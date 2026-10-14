import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { TinyFish, BrowserProfile, RunStatus } from "@tiny-fish/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pickListings, canonicalUrl, computeEffective, discountVerdict,
  roughPriceFromText, toNum, isHttpUrl, BLOCK_WORDS,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_AGENT_LISTINGS = Number(process.env.MAX_LISTINGS || 4); // Agent costs credits. Keep it small.
const CHECK_MINUTES = Number(process.env.CHECK_MINUTES || 360);    // watchlist re-check interval
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_SECONDS || 45) * 1000;
const DB_FILE = path.join(__dirname, "data", "db.json");

if (!process.env.TINYFISH_API_KEY) {
  console.error("Missing TINYFISH_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}
process.env.TINYFISH_API_KEY = process.env.TINYFISH_API_KEY.trim().replace(/^['"]|['"]$/g, "");
const tf = new TinyFish();

// ---------- tiny JSON "database" ----------
let db = { watchlist: [], priceLog: {}, alerts: [] };
async function loadDb() {
  try { db = { ...db, ...JSON.parse(await readFile(DB_FILE, "utf8")) }; } catch { /* first run */ }
}
async function saveDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- the Agent goal ----------
function agentGoal(query, pincode) {
  return `You are on a shopping product page. The shopper wants: "${query}".
Do these steps:
1. Read the product name, the seller, the current selling price in INR, the MRP (struck-through price) in INR, and stock status.
2. Find the offers area (look for "Offers", "Bank offers", "Coupons", "View all offers", "Available offers"). Open it or expand every collapsed offer list so you can read all of them.
${pincode ? `3. If there is a delivery or pincode box, enter ${pincode} and read the delivery estimate. Do not do anything else with it.` : "3. Skip delivery checks."}
Rules: Do NOT log in, add to cart, buy, subscribe, or submit any personal info. If you hit a captcha, login wall, or "access denied", stop and set blocked to true.
If this page is clearly not the product the shopper wants (wrong product, or a category/list page), set wrong_page to true.
Return ONLY JSON, numbers as plain numbers without currency symbols:
{"product_name": string, "seller": string|null, "price_inr": number|null, "mrp_inr": number|null, "in_stock": boolean|null, "delivery": string|null, "blocked": boolean, "wrong_page": boolean,
 "offers": [{"type": "bank"|"coupon"|"cashback"|"exchange"|"emi"|"other", "description": string, "bank_or_card": string|null, "discount_inr": number|null, "percent": number|null, "max_discount_inr": number|null, "min_order_inr": number|null}]}`;
}

// Agent results can be nested or stringified depending on the run. Normalise.
function unwrapResult(result) {
  if (!result || typeof result !== "object") return null;
  if ("price_inr" in result || "offers" in result) return result;
  for (const v of Object.values(result)) {
    if (v && typeof v === "object" && ("price_inr" in v || "offers" in v)) return v;
    if (typeof v === "string") {
      try { const j = JSON.parse(v.replace(/^```json|```$/g, "").trim()); if (j && typeof j === "object") return j; } catch { /* ignore */ }
    }
  }
  return null;
}

// ---------- one scan: Search -> Fetch -> Agent ----------
async function scan(query, { bank, pincode } = {}, log = () => {}, onCard = () => {}) {
  log(`Searching the web for "${query}"`);
  const search = await tf.search.query({
    query: `${query} buy online price India`,
    location: "IN",
    language: "en",
    purpose: "Find product pages from online shops that sell this exact product, to compare prices.",
  });
  const listings = pickListings(search.results, MAX_AGENT_LISTINGS);
  if (!listings.length) throw new Error("Search found no shop pages for that. Try a more specific product name.");
  const hostOf = (u) => new URL(u).hostname.replace(/^www\./, "");
  log(`Found ${listings.length} shops: ${listings.map((l) => hostOf(l.url)).join(", ")}`);

  // Show a card for every shop the instant TinyFish touches it.
  const state = {};
  listings.forEach((l) => {
    const key = canonicalUrl(l.url);
    state[key] = { key, state: "reading", store: hostOf(l.url), url: l.url, title: l.title };
    onCard(state[key]);
  });
  const update = (key, patch) => { state[key] = { ...state[key], ...patch }; onCard(state[key]); return state[key]; };

  // Fetch runs IN PARALLEL with the agents (no longer blocks them). Gives a fast rough price per card.
  const fetchDone = tf.fetch.getContents({
    urls: listings.map((l) => l.url), format: "markdown", ttl: 0,
    purpose: "Read the visible price of this product.",
  }).then((f) => {
    for (const r of f.results || []) {
      const key = canonicalUrl(r.url);
      const p = roughPriceFromText(r.text);
      if (state[key] && state[key].state === "reading" && p) update(key, { roughPrice: p });
    }
  }).catch((e) => log(`Quick read failed (${e.message}).`));

  const results = await Promise.all(
    listings.map(async (l) => {
      const host = hostOf(l.url);
      const key = canonicalUrl(l.url);
      try {
        log(`Agent opening ${host}`);
        const run = await Promise.race([
          tf.agent.run({ url: l.url, goal: agentGoal(query, pincode), browser_profile: BrowserProfile.STEALTH }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Offers took too long to read")), AGENT_TIMEOUT_MS)),
        ]);
        if (run.status !== RunStatus.COMPLETED || !run.result) throw new Error(run.error?.message || "The agent run did not finish");
        const data = unwrapResult(run.result);
        if (!data || data.blocked || BLOCK_WORDS.test(JSON.stringify(run.result).slice(0, 600))) throw new Error("The site blocked the agent (captcha or login wall)");
        if (data.wrong_page) throw new Error("That page is not the product you searched for");
        const calc = computeEffective(data, bank);
        if (!calc) throw new Error("Could not read a price from that page");
        const prior = (db.priceLog[key] || []).map((p) => p.price);
        const verdict = discountVerdict(calc.price, calc.mrp, prior);
        (db.priceLog[key] ||= []).push({ ts: Date.now(), price: calc.price });
        db.priceLog[key] = db.priceLog[key].slice(-60);
        log(`${host}: ₹${calc.price.toLocaleString("en-IN")} sticker, ₹${calc.effective.toLocaleString("en-IN")} effective`);
        return update(key, { state: "ok", ok: true, product: data.product_name, seller: data.seller, inStock: data.in_stock, delivery: data.delivery, ...calc, verdict });
      } catch (e) {
        log(`${host}: ${e.message}`);
        await fetchDone;
        const rp = state[key].roughPrice;
        if (rp) return update(key, { state: "ok", ok: true, rough: true, product: l.title, price: rp, effective: rp, mrp: null,
          verdict: { level: "unknown", text: "Quick price from the page. Offers could not be read in time, so check bank offers at checkout." } });
        return update(key, { state: "failed", ok: false, error: e.message });
      }
    })
  );

  await saveDb();
  const good = results.filter((c) => c.ok).sort((a, b) => a.effective - b.effective);
  const bad = results.filter((c) => !c.ok);
  return { cards: [...good, ...bad], best: good[0] || null };
}

// ---------- jobs so the UI can show live progress ----------
const jobs = new Map();
function startJob(query, opts) {
  const id = randomUUID();
  const job = { id, status: "running", steps: [], cards: {}, result: null, error: null };
  jobs.set(id, job);
  scan(query, opts, (m) => job.steps.push({ ts: Date.now(), text: m }), (c) => { job.cards[c.key] = c; })
    .then((r) => { job.result = r; job.status = "done"; })
    .catch((e) => { job.error = e.message; job.status = "error"; });
  setTimeout(() => jobs.delete(id), 30 * 60 * 1000);
  return job;
}

// ---------- watchlist ----------
async function checkItem(item) {
  try {
    const { best } = await scan(item.query, { bank: item.bank, pincode: item.pincode });
    item.lastCheck = Date.now();
    item.lastError = null;
    if (best) {
      item.history.push({ ts: Date.now(), price: best.effective, store: best.store });
      item.history = item.history.slice(-60);
      item.best = { price: best.effective, store: best.store, url: best.url };
      const alreadyAlerted = item.lastAlertPrice === best.effective;
      if (best.effective <= item.target && !alreadyAlerted) {
        item.lastAlertPrice = best.effective;
        db.alerts.unshift({
          id: randomUUID(), ts: Date.now(), itemId: item.id, query: item.query,
          price: best.effective, target: item.target, store: best.store, url: best.url, seen: false,
        });
        db.alerts = db.alerts.slice(0, 50);
      }
    } else {
      item.lastError = "No shop returned a readable price this time";
    }
  } catch (e) {
    item.lastCheck = Date.now();
    item.lastError = e.message;
  }
  await saveDb();
}

let checking = false;
async function checkAll() {
  if (checking) return;
  checking = true;
  try { for (const item of db.watchlist) await checkItem(item); } finally { checking = false; }
}

// ---------- HTTP ----------
const app = Fastify({ logger: false });
await app.register(fastifyStatic, { root: path.join(__dirname, "public") });

const clean = (s, n = 120) => String(s ?? "").trim().slice(0, n);

app.post("/api/search", async (req, reply) => {
  const q = clean(req.body?.query, 150);
  if (q.length < 3) return reply.code(400).send({ error: "Type what you want to buy (at least 3 characters)." });
  const job = startJob(q, { bank: clean(req.body?.bank, 40), pincode: clean(req.body?.pincode, 6).replace(/\D/g, "") });
  return { jobId: job.id };
});

app.get("/api/jobs/:id", async (req, reply) => {
  const job = jobs.get(req.params.id);
  if (!job) return reply.code(404).send({ error: "That scan expired. Run it again." });
  return job;
});

app.get("/api/watchlist", async () => ({ items: db.watchlist, alerts: db.alerts, checkEveryMinutes: CHECK_MINUTES }));

app.post("/api/watchlist", async (req, reply) => {
  const query = clean(req.body?.query, 150);
  const target = toNum(req.body?.target);
  if (query.length < 3 || !target) return reply.code(400).send({ error: "Need a product and a target price in rupees." });
  const item = {
    id: randomUUID(), query, target,
    bank: clean(req.body?.bank, 40), pincode: clean(req.body?.pincode, 6).replace(/\D/g, ""),
    createdAt: Date.now(), lastCheck: null, lastError: null, best: null, history: [], lastAlertPrice: null,
  };
  const seed = toNum(req.body?.seedPrice);
  const seedStore = clean(req.body?.seedStore, 60);
  if (seed) { item.history.push({ ts: Date.now(), price: seed, store: seedStore }); item.best = { price: seed, store: seedStore, url: isHttpUrl(req.body?.seedUrl) ? req.body.seedUrl : null }; item.lastCheck = Date.now(); }
  db.watchlist.push(item);
  await saveDb();
  return item;
});

app.post("/api/watchlist/:id/check", async (req, reply) => {
  const item = db.watchlist.find((i) => i.id === req.params.id);
  if (!item) return reply.code(404).send({ error: "Not on your list anymore." });
  await checkItem(item);
  return item;
});

app.delete("/api/watchlist/:id", async (req) => {
  db.watchlist = db.watchlist.filter((i) => i.id !== req.params.id);
  await saveDb();
  return { ok: true };
});

app.post("/api/alerts/seen", async () => {
  db.alerts.forEach((a) => (a.seen = true));
  await saveDb();
  return { ok: true };
});

await loadDb();
setInterval(checkAll, CHECK_MINUTES * 60 * 1000);
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`DealFish running on http://127.0.0.1:${PORT}`);
