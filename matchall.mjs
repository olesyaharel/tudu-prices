// After the nightly job: the price of every grocery-list product at every branch, so the app downloads one small file
// per nearby branch instead of whole price lists.
//   out/match/<k>.json   {product: [total, price, name, count]}   total = the standard amount's price (defs.json std),
//                        price/name = the item picked, count = how many of `by` it holds (4 for a 4-pack of wipes)
//   out/products.json    {product: {dept, by, std} | {dept, ask, options}}   what the app needs to read the match files
// Products a branch doesn't sell are left out of its file. Run: node matchall.mjs [--out=dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidates, priceFor } from './match.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = path.resolve(process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || HERE + 'out') + '/';
const defs = JSON.parse(fs.readFileSync(HERE + 'defs.json', 'utf8'));
const branches = JSON.parse(fs.readFileSync(OUT + 'branches.json'));
const started = Date.now();

fs.mkdirSync(OUT + 'match', { recursive: true });
const products = Object.fromEntries(Object.entries(defs).filter(([, d]) => !d.skip).map(([name, d]) =>
  [name, d.ask ? { dept: d.dept, ask: d.ask, options: d.options } : { dept: d.dept, by: d.by, std: d.std }]));
fs.writeFileSync(OUT + 'products.json', JSON.stringify(products));

const priced = Object.entries(defs).filter(([, d]) => !d.skip && !d.ask);
// the matching items are found once per chain; each branch then only looks up its prices
const chains = {}; let files = 0, found = 0;
const chain = c => chains[c] || (chains[c] = (() => { const items = JSON.parse(fs.readFileSync(`${OUT}items/${c}.json`));
  return { items, cands: priced.map(([, def]) => candidates(def, items)) }; })());
for (const b of branches) {
  const file = `${OUT}prices/${b.k}.json`; if (!fs.existsSync(file)) continue;
  const { items, cands } = chain(b.chain), prices = JSON.parse(fs.readFileSync(file)), m = {};
  priced.forEach(([name, def], i) => { const p = priceFor(def, items, prices, cands[i]); if (p) m[name] = [p.total, p.price, p.name, p.count]; });
  fs.writeFileSync(`${OUT}match/${b.k}.json`, JSON.stringify(m));
  files++; found += Object.keys(m).length;
}
const report = JSON.parse(fs.readFileSync(OUT + 'report.json'));
report.match = { branches: files, products: priced.length, ask: Object.keys(products).length - priced.length, perBranch: Math.round(found / (files || 1)), seconds: Math.round((Date.now() - started) / 1000) };
fs.writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 1));
console.log('matched', report.match);
