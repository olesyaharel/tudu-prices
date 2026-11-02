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
