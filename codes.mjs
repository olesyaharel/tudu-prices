// After matchall: every barcode's price at every branch, so the app can price one exact item ("ירח מתוק", the barcode the
// user picked in the comparison's search) by downloading one small file instead of every nearby branch's price list.
//   out/codes/<nnn>.json   nnn = the barcode's last 3 digits
//     {code: {p: [the general products it counts as (defs.json)], b: {branch k: price | [sale price, regular price, how many to buy]}}}
// Only real barcodes (7+ digits); a chain's own short codes mean different things in different chains. Run: node codes.mjs [--out=dir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidates } from './match.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = path.resolve(process.argv.find(a => a.startsWith('--out='))?.split('=')[1] || HERE + 'out') + '/';
const defs = JSON.parse(fs.readFileSync(HERE + 'defs.json', 'utf8'));
const branches = JSON.parse(fs.readFileSync(OUT + 'branches.json'));
const started = Date.now();
const REAL = /^\d{7,14}$/;
const shard = code => code.slice(-3).padStart(3, '0');

// out/words.json: what each word in item names is, for "למצוא דומה" (an item's kind = its words that are neither a brand nor a base):
//   {word: 0 kind (מעדן, אורז) | 1 brand (most of its items from one maker, or the maker's own name: תנובה, במבה) |
//          2 base (in 1,000+ names: חלב, עם) | 3 rare kind (in 5–29 names: קוטג; ירח too, which is how a brand looks from here)}
//   words in fewer than 5 names are left out
const toks = s => s.toLowerCase().replace(/["'`׳״]/g, '').replace(/[^0-9a-zא-ת%]+/g, ' ').trim().split(' ').filter(w => w.length > 1 && !/\d/.test(w));
const named = {};
const all = {}, entry = code => all[code] || (all[code] = { p: [], b: {} });
// which general products each barcode counts as, from every chain's items (the same barcode is the same item everywhere)
// brand and kind rules (`m`, "חלב תנובה") are not "other brands" of an item, so only the plain products count here
const priced = Object.entries(defs).filter(([, d]) => !d.skip && !d.ask && !d.m);
for (const f of fs.readdirSync(OUT + 'items')) {
  const items = JSON.parse(fs.readFileSync(OUT + 'items/' + f));
  for (const [code, it] of Object.entries(items)) if (REAL.test(code)) {
    if (!named[code]) named[code] = [it[0], it[4] || ''];
    else if (!named[code][1] && it[4]) named[code][1] = it[4];   // the maker, from any chain that gives it
  }
  for (const [name, def] of priced) for (const [code] of candidates(def, items)) {
    if (!REAL.test(code)) continue;
    const e = entry(code); if (!e.p.includes(name)) e.p.push(name);
  }
}
let n = 0;
for (const b of branches) {
  const file = `${OUT}prices/${b.k}.json`; if (!fs.existsSync(file)) continue;
  const prices = JSON.parse(fs.readFileSync(file)), salesFile = `${OUT}promos/${b.k}.json`;
  const sales = fs.existsSync(salesFile) ? JSON.parse(fs.readFileSync(salesFile)) : {};
  for (const [code, price] of Object.entries(prices)) {
    if (!REAL.test(code) || !(price >= 0.5)) continue;   // ₪0.01 is a placeholder, not a price
    const s = sales[code];
    entry(code).b[b.k] = s ? [s[0], price, s[1]] : price; n++;
  }
}
const GENERIC = new Set(['מחלבות', 'מחלבת', 'קבוצת', 'חברת', 'תעשיות', 'מפעלי', 'בע', 'ltd', 'the']);
const df = {}, makers = {}, inMaker = {};
for (const [name, maker] of Object.values(named)) {
  const mw = new Set(toks(maker)), m = toks(maker).find(w => !GENERIC.has(w));   // "מחלבות גד" → גד
  for (const w of new Set(toks(name))) {
    df[w] = (df[w] || 0) + 1;
    if (mw.has(w)) inMaker[w] = (inMaker[w] || 0) + 1;
    if (m) (makers[w] ||= {})[m] = (makers[w][m] || 0) + 1;
  }
}
const words = {};
for (const [w, n] of Object.entries(df)) {
  if (n < 5) continue;
  const ms = Object.values(makers[w] || {}), known = ms.reduce((a, b) => a + b, 0);
  words[w] = n >= 1000 ? 2 : (known >= 3 && Math.max(...ms) / known >= 0.6) || (inMaker[w] || 0) >= n * 0.3 ? 1 : n < 30 ? 3 : 0;
}
fs.writeFileSync(OUT + 'words.json', JSON.stringify(words));
fs.rmSync(OUT + 'codes', { recursive: true, force: true });
fs.mkdirSync(OUT + 'codes', { recursive: true });
const shards = {};
for (const [code, e] of Object.entries(all)) if (Object.keys(e.b).length) {
  if (!e.p.length) delete e.p;
  (shards[shard(code)] ||= {})[code] = e;
}
for (const [s, obj] of Object.entries(shards)) fs.writeFileSync(`${OUT}codes/${s}.json`, JSON.stringify(obj));
const report = JSON.parse(fs.readFileSync(OUT + 'report.json'));
report.codes = { codes: Object.values(shards).reduce((a, o) => a + Object.keys(o).length, 0), prices: n, files: Object.keys(shards).length, seconds: Math.round((Date.now() - started) / 1000) };
fs.writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 1));
console.log('codes', report.codes);
