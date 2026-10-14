# DealFish

Personal shopper on TinyFish. Type what you want, it finds the real price you would pay, and watches your want-to-buy list.

## Run
```
npm install
cp .env.example .env     # add TINYFISH_API_KEY
npm start                # http://127.0.0.1:3000
npm test                 # price math + fake-discount logic
```

## How TinyFish is used
- **Search**: discovers which shops sell the product (nothing hardcoded per retailer).
- **Fetch**: quick read of every page. Gives a rough price fallback if the Agent gets blocked.
- **Agent**: opens each product page, expands the offers panel, reads bank offers and coupons, optionally checks delivery for your pincode.

## What it computes
- Effective price = sticker price - best offer for your card - best coupon. Cashback shown separately.
- Fake-discount check against price history this app records itself. Says "not enough history" until it has 2+ prior scans.
- Want-to-buy list re-checks on a schedule and raises an in-app alert when the effective price crosses your target.

## Safety rules (by design)
- Never logs in, adds to cart, buys, or submits personal info. It only links you to the page.
- Blocked or unreadable shop = a clear failure card, never a guessed price.
- Offers can have hidden stacking rules, so every card says to verify at checkout.
# The-Dealer
