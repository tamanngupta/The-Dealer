// Pure helpers. No network, no TinyFish calls, so they are easy to test.

const SHOP_HINTS = [
  "amazon.in", "flipkart.com", "croma.com", "reliancedigital.in", "vijaysales.com",
  "tatacliq.com", "myntra.com", "ajio.com", "nykaa.com", "snapdeal.com",
  "bigbasket.com", "blinkit.com", "jiomart.com", "shopclues.com", "meesho.com",
  "boat-lifestyle.com", "mi.com", "samsung.com", "apple.com", "oneplus.in",
  "decathlon.in", "healthkart.com", "pepperfry.com", "lenskart.com",
];

const NOT_SHOPS = [
  "youtube.com", "reddit.com", "quora.com", "wikipedia.org", "facebook.com",
  "instagram.com", "twitter.com", "x.com", "pinterest.com", "linkedin.com",
  "medium.com", "gadgets360.com", "91mobiles.com", "digit.in", "ndtv.com",
  "timesofindia.indiatimes.com", "hindustantimes.com", "indianexpress.com",
];

const host = (u) => {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
};
const hostMatches = (h, list) => list.some((d) => h === d || h.endsWith("." + d));

export function canonicalUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname.replace(/\/+$/, "");
  } catch { return u; }
}

export function isHttpUrl(u) {
  try { return ["http:", "https:"].includes(new URL(u).protocol); } catch { return false; }
}

// Search discovers listings. Known retailers rank first, unknown shops fill in,
// news/social/review sites are dropped. One listing per domain for variety.
export function pickListings(results, max = 3) {
  const seen = new Set();
  const scored = [];
  for (const r of results || []) {
    if (!r?.url || !isHttpUrl(r.url)) continue;
    const h = host(r.url);
    if (!h || hostMatches(h, NOT_SHOPS) || seen.has(h)) continue;
    seen.add(h);
    scored.push({ r, score: hostMatches(h, SHOP_HINTS) ? 0 : 1, pos: r.position ?? 99 });
  }
  scored.sort((a, b) => a.score - b.score || a.pos - b.pos);
  return scored.slice(0, max).map((s) => s.r);
}

export function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Rough sticker price from fetched markdown. Used only as a fallback and always labelled rough.
export function roughPriceFromText(text) {
  if (!text) return null;
  const m = text.match(/(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)/i);
  return m ? toNum(m[1]) : null;
}

export function offerValue(o, price) {
  const flat = toNum(o.discount_inr);
  let v = flat;
  if (!v) {
    const pct = toNum(o.percent);
    if (pct) {
      v = (price * pct) / 100;
      const cap = toNum(o.max_discount_inr);
      if (cap) v = Math.min(v, cap);
    }
  }
  return v ? Math.round(v) : 0;
}

// Effective price = sticker price - best bank offer for YOUR card - best coupon.
// Cashback is reported separately because it lands later. Offers can have hidden
// stacking rules, so the card tells the user to verify at checkout.
export function computeEffective(data, bank) {
  const price = toNum(data?.price_inr);
  if (!price) return null;
  const bankNorm = (bank || "").toLowerCase().trim();
  const offers = (Array.isArray(data.offers) ? data.offers : [])
    .map((o) => ({ ...o, value: offerValue(o, price) }))
    .filter((o) => o.value > 0)
    .filter((o) => !toNum(o.min_order_inr) || price >= toNum(o.min_order_inr));

  const best = (list) => list.sort((a, b) => b.value - a.value)[0] || null;
  const bankOffer = bankNorm
    ? best(offers.filter((o) => o.type === "bank" &&
        `${o.bank_or_card || ""} ${o.description || ""}`.toLowerCase().includes(bankNorm)))
    : null;
  const coupon = best(offers.filter((o) => o.type === "coupon"));
  const cashback = best(offers.filter((o) => o.type === "cashback"));

  const effective = Math.max(price - (bankOffer?.value || 0) - (coupon?.value || 0), 1);
  return {
    price,
    mrp: toNum(data.mrp_inr),
    bankOffer: bankOffer && { text: bankOffer.description, value: bankOffer.value },
    coupon: coupon && { text: coupon.description, value: coupon.value },
    cashback: cashback && { text: cashback.description, value: cashback.value },
    effective,
    effectiveAfterCashback: cashback ? Math.max(effective - cashback.value, 1) : null,
    otherOffers: offers.filter((o) => !["bank", "coupon", "cashback"].includes(o.type)).length,
  };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Judges the discount claim against price history this app recorded itself.
// With under 2 prior points it says so instead of guessing.
export function discountVerdict(price, mrp, priorPrices) {
  const claimed = mrp && mrp > price ? Math.round(((mrp - price) / mrp) * 100) : null;
  if (!priorPrices || priorPrices.length < 2) {
    return {
      level: "unknown",
      claimedPct: claimed,
      text: claimed
        ? `Claims ${claimed}% off MRP. Not enough history yet to verify, scan again later.`
        : "Not enough price history yet. Scan again later to build it.",
    };
  }
  const med = median(priorPrices);
  const low = Math.min(...priorPrices);
  if (price <= low * 1.01) {
    return { level: "real", claimedPct: claimed, text: `Lowest price we have seen (usual ~₹${Math.round(med).toLocaleString("en-IN")}).` };
  }
  if (claimed && claimed >= 20 && price >= med * 0.97) {
    return {
      level: "fake",
      claimedPct: claimed,
      text: `Shows ${claimed}% off, but this price is the same as usual (~₹${Math.round(med).toLocaleString("en-IN")}). The discount is MRP theatre.`,
    };
  }
  return { level: "normal", claimedPct: claimed, text: `Around the usual price (~₹${Math.round(med).toLocaleString("en-IN")}).` };
}

export const BLOCK_WORDS = /captcha|access denied|blocked|robot|unusual traffic|verify you are human/i;
