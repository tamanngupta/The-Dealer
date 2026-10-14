import assert from "node:assert";
import { computeEffective, discountVerdict, pickListings, roughPriceFromText, canonicalUrl } from "./lib.js";

// effective price: HDFC bank offer + coupon, ignores other bank + below-min offers
const data = { price_inr: 10000, mrp_inr: 15000, offers: [
  { type: "bank", description: "10% off HDFC cards", bank_or_card: "HDFC", percent: 10, max_discount_inr: 750 },
  { type: "bank", description: "5% off SBI cards", bank_or_card: "SBI", percent: 5 },
  { type: "coupon", description: "Save 200", discount_inr: 200 },
  { type: "coupon", description: "Save 900 on 50k+", discount_inr: 900, min_order_inr: 50000 },
  { type: "cashback", description: "5% cashback", percent: 5, max_discount_inr: 300 },
]};
const c = computeEffective(data, "hdfc");
assert.equal(c.bankOffer.value, 750);       // 10% capped at 750
assert.equal(c.coupon.value, 200);          // min-order coupon excluded
assert.equal(c.effective, 9050);
assert.equal(c.effectiveAfterCashback, 8750);
assert.equal(computeEffective(data, "").bankOffer, null);   // no card given -> no bank offer assumed
assert.equal(computeEffective({ price_inr: null }, "x"), null);

// verdicts
assert.equal(discountVerdict(10000, 15000, []).level, "unknown");
assert.equal(discountVerdict(10000, 15000, [10100, 9900, 10000]).level, "fake");  // 33% off but always ~10k
assert.equal(discountVerdict(8000, 15000, [10100, 9900, 10000]).level, "real");
assert.equal(discountVerdict(10000, 10000, [10100, 9900, 10000]).level, "normal");

// listings: drops news/social, prefers retailers, one per domain
const picks = pickListings([
  { url: "https://www.youtube.com/watch?v=1", position: 1 },
  { url: "https://randomblog.example/review", position: 2 },
  { url: "https://www.amazon.in/dp/B1", position: 3 },
  { url: "https://www.amazon.in/dp/B2", position: 4 },
  { url: "https://www.croma.com/p/1", position: 5 },
], 3);
assert.deepEqual(picks.map((p) => new URL(p.url).hostname), ["www.amazon.in", "www.croma.com", "randomblog.example"]);

assert.equal(roughPriceFromText("Price: ₹1,29,999 only"), 129999);
assert.equal(canonicalUrl("https://x.com/p/1/?utm=a#h"), "https://x.com/p/1");
console.log("ALL TESTS PASS");
