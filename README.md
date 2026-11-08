# TuDu prices

Every night this downloads the public price files that Israeli supermarket chains must publish
(price-transparency law) and turns them into small files for the TuDu grocery list app:

- `branches.json` — every branch with its chain, address and location
- `prices/<chain>-<store>.json` — barcode → price, one file per branch
- `items/<chain>.json` — barcode → name, size, unit, sold by weight, maker
- `report.json` — what worked last night and what didn't

Run by hand: `node job.mjs` (Node 22). Options: `--chains=RamiLevi,carrefour`, `--limit=5`, `--out=dir`, `--merge=dir`, `--no-locate`, `--locate-only`.
Carrefour, Hatzi Hinam, Victory, Mahsanei HaShuk, H. Cohen and Netiv HaHesed refuse servers abroad, so a computer in Israel fetches them each morning (`local.sh`, scheduled by
`il.tudu.prices.plist`) and leaves them on the release "israel"; the nightly job folds them in with `--merge`.
Branch locations come from OpenStreetMap (Nominatim, Photon) and are kept in `geocode.json`.

## Sales
Each branch's sales file (PromoFull) gives `out/promos/<branch>.json`: only sales anyone can get at the till today (no club, credit-card, coupon or gift sales, none that need a basket total), as the price per item and how many to buy ("3 ב-10" is 3.33 each when buying 3). The matcher uses a sale price when it is lower and keeps the regular price beside it.

## Grocery-list products
`defs.json` says, for each product on the app's list ("חלב 3%", "עגבניות"), which items match it and how its price is compared (per kilo, liter, unit or pack); `match.mjs` is the matcher. General products ("לחם", "שמפו") aren't priced: they list the specific products the user picks from. After the nightly job, `node matchall.mjs` writes `out/match/<branch>.json` (each product's price there and the item picked) and `out/products.json`. Then `node codes.mjs` writes `out/codes/<last 3 digits>.json` (one barcode's price at every branch, and the general products it counts as), so the app can price an exact item the user picked ("ירח מתוק") from one small file, and `out/words.json` (which name words are a brand, a base or a kind) for the app's "למצוא דומה".
