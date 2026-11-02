// Matching a grocery-list product (generic, like "חלב 3%") to a branch's items, and its price for a standard amount.
// A definition (defs.json, by product name): { q: [alternatives], x: [exclusions], by: 'kg'|'L'|'unit', std, skip? }
//   q    regexes on the item name (quotes made plain, see clean); an item matches if any one does
//   x    regexes; an item matching any of them is left out
//   by   what the price is compared per: kilo, liter, unit (a pack of 18 eggs is 18 units; a 32-roll pack is 32), pack (as
//        sold), or packs (a 4-pack of wipes is 4: compared per pack, and `count` tells what the branch sells)
//   std  the amount counted when the list gives none (1 kg tomatoes, 1 L milk, 12 eggs)
//   bare (with by 'unit') a lone number ending the name is the count (floor wipes: "מטליות לחות לרצפה 10")
//   size [min, max] of the item's amount in `by` (water: a 1.5 L bottle is [1.4, 1.6], a six-pack of them [8.5, 9.5]);
//        single: only items sold one at a time; multi: only multipacks
//   skip a reason this product isn't compared at all
//   ask  a general product ("קפה", "עוגה", the brand "סנו"): not priced until the user picks what they meant, from
//        options (more specific products defined here) and, with search, catalog products whose name matches it
// The cheapest matching item per unit is the branch's price (any brand; the list may later pin one).
// Run: node match.mjs <defs.json> <dir with items-<chain>.json + p-<branch>.json> <chain:branch,…> [product or dept…]
import fs from 'node:fs';

export const clean = s => (s || '').replace(/[׳`’]/g, "'").replace(/[״“”]/g, '"').replace(/\s+/g, ' ').trim();
const num = s => +s.replace(',', '.');
// sizes written in the name, for items whose size field is empty or "unknown"
const SIZE = [
  [/(\d+(?:[.,]\d+)?)\s*(?:ק"ג|קג|קילו(?:גרם)?|ק'ג)(?![א-ת])/, 'kg', 1], [/(\d+(?:[.,]\d+)?)\s*(?:גרם|גר'?|ג'|ג)(?![א-ת])/, 'kg', .001],
  [/(\d+(?:[.,]\d+)?)\s*(?:ליטר|ל'|ל)(?![א-ת])/, 'L', 1], [/(\d+(?:[.,]\d+)?)\s*(?:מ"ל|מל|מ'ל)(?![א-ת])/, 'L', .001]
];
const UNIT = { 'גרם': ['kg', .001], 'קילוגרם': ['kg', 1], 'קילוגרמים': ['kg', 1], 'מיליליטר': ['L', .001], 'ליטר': ['L', 1], 'ליטרים': ['L', 1] };
// how many units a pack holds: "18 יח", "12 יחידות", "32 גליל", "30 שקיקים", and the cut forms "700 טב", "120 שק", "10י"
const COUNT = /(\d+)\s*(?:יח(?:ידות|ידו|'|י)?|גלילים|גליל|גל'|זוגות|שקיות|שקיקים|שק|טבליות|טבל|טב'?|ט|ביצים|כמוסות|קפסולות|דפים|דף|י)(?![א-ת])|(?:^|\s)(\d+)\s*(?:L|M|XL|S)?\s*(?:ביצים)/;
// "A*B": a count of packs of a size ("10*100ג" is 10), a count of counts ("4*56" wipes is 224), or a measure ("28*26 ס"מ", none)
const TIMES = /(\d+(?:[.,]\d+)?)\s*[x*X×]\s*(\d+(?:[.,]\d+)?)(?![\d.,])(?:\s*(ק"ג|קג|גרם|גר|ג|מ"ל|מל|ליטר|ל|ס"מ|סמ|ס'מ|מ'|מטר)(?![א-ת]))?/;
const sizeInName = (name, by) => {
  const t = clean(name).match(TIMES);
  if (t && t[3] && !/ס|מ'|מטר/.test(t[3])) { const per = sizeInName(t[2] + ' ' + t[3], by); if (per) return +t[1] * per; }
  for (const [re, b, f] of SIZE) { const m = clean(name).match(re); if (m && b === by) { const v = num(m[1]) * f; return by === 'L' && f === 1 && v >= 50 ? v / 1000 : v; } }
  return null; // ("500 ל" is 500 ml)
};

// how many packs an item is sold as (wipes are bought by the pack): "4*56" and "56*4" are 4 packs (the small number),
// רביעייה 4, שלישייה 3, זוג/שנייה 2, חמישייה 5, שישייה 6, "מארז … 5 יח" 5; a units field of 2–6 (Rami Levi's "3 יחידות") too
const PACK_WORDS = [[/רב(י)?עי/, 4], [/שליש/, 3], [/זוג|שני(י)?ה|שניית/, 2], [/חמיש/, 5], [/שישי(י)?ה|שישיית/, 6], [/תריסר/, 12]];
export function packs(item) {
  const [name, qty, unit] = item, n = clean(name);
  // "6*1.5 ליטר" is 6 bottles of 1.5: a size after the star leaves the first number as the count
  const t = n.match(/(\d+)\s*[x*X×]\s*(\d+(?:[.,]\d+)?)?\s*(ליטר|ל|מ"ל|מל|גרם|גר|ג|ק"ג)?(?![א-ת])/);
  if (t) { const a = +t[1], b = t[2] ? num(t[2]) : 0, p = !b ? a : t[3] || !Number.isInteger(b) ? a : Math.min(a, b); if (p >= 1 && p <= 24) return p; }
  for (const [re, p] of PACK_WORDS) if (re.test(n)) return p;
  const m = /מארז/.test(n) && n.match(/(\d+)\s*(?:יח|י)(?![א-ת])/); if (m && +m[1] >= 2 && +m[1] <= 12) return +m[1];
  return unit === 'יחידות' && qty >= 2 && qty <= 6 ? qty : 1; // "10 יחידות" is more likely 10 wipes
}

// amount of `by` in one item, or null when it can't be told. by 'pack': the item as sold (a box of tissues, a pack of sponges)
export function amount(item, by, std = 1, bare = false) {
  const [name, qty, unit, weighted] = item, n = clean(name);
  if (by === 'pack') return weighted ? null : 1;
  if (by === 'packs') return weighted ? null : packs(item);
  if (by === 'kg' || by === 'L') {
    if (weighted) return by === 'kg' ? 1 : null; // weighted items are priced per kilo
    const fromName = sizeInName(n, by), u = UNIT[unit];
    if (u && u[0] === by && qty > 0) {
      let v = qty * u[1];
      if (by === 'L' && u[1] === 1 && v >= 50) v /= 1000; // "750 ליטר" wine is 750 ml
      // a size field far from the size in the name is a typing slip ("2.8 גרם" for a 2.8 kg bag): the name wins
      return fromName && (v / fromName > 20 || fromName / v > 20) ? fromName : v;
    }
    if (fromName) return fromName;
    // names cut at 20 letters lose the size unit ("חלב תנובה 3% שומן 2"): when the name ends with the item's number, 2 is liters, 250 is ml
    if (!u && unit !== 'יחידות' && qty > 0 && new RegExp(`(^|\\s)${qty}\\.?$`).test(n)) return qty <= 5 ? qty : qty >= 20 ? qty / 1000 : null;
    return null;
  }
  if (weighted) return null;
  const t = n.match(TIMES); if (t && !t[3]) return +t[1] * +t[2]; // "6*72י" wipes are 432
  const m = n.match(COUNT); if (m) return +(m[1] || m[2]);
  // with `bare`, a lone number after the name is the count ("מטליות לחות לרצפה 10", "לרצפה50 VIVI")
  const b = bare && n.match(/[א-ת]\s*(\d{1,3})(?:\s+[A-Za-z]+)?$/); if (b && +b[1] > 1) return +b[1];
  if (t && t[3] && !/ס|מ'|מטר/.test(t[3])) return +t[1];
  // a "units" field small next to the usual amount counts packs, not pieces ("4" for a 4-pack of wipes), so it can't be used
  return unit === 'יחידות' && qty >= 1 && qty <= 5000 && (std <= 1 || qty > std / 10) ? qty : null;
}

const compile = def => def.re || (def.re = { q: def.q.map(s => new RegExp(s)), x: (def.x || []).map(s => new RegExp(s)) });
export const matches = (def, name) => { const { q, x } = compile(def), n = clean(name); return q.some(r => r.test(n)) && !x.some(r => r.test(n)); };

// a chain's items that match a product, with the amount each holds (done once per chain: its branches share the items)
export function candidates(def, items) {
  if (def.skip || def.ask) return [];
  const out = [];
  for (const [code, it] of Object.entries(items)) if (matches(def, it[0])) {
    const a = amount(it, def.by, def.std, def.bare); if (!a) continue;
    if (def.size && (a < def.size[0] || a > def.size[1])) continue; // a package size (water: single 1.5 L vs a six-pack)
    if (def.single && packs(it) > 1) continue;
    if (def.multi && packs(it) < 2) continue;
    out.push([code, a]);
  }
  return out;
}

// the branch's price for a product: the cheapest item per unit, times the standard amount
export function priceFor(def, items, prices, cands = candidates(def, items)) {
  const found = [];
  for (const [code, a] of cands) {
    const price = prices[code]; if (!(price >= 0.5)) continue; // ₪0.01 is a placeholder, not a price
    found.push({ code, name: items[code][0], price, per: price / a, count: a });
  }
  if (!found.length) return null;
  // a price per unit far below the others is a data slip (a wrong size), not a bargain
  found.sort((a, b) => a.per - b.per);
  const mid = found[found.length >> 1].per, best = found.find(f => found.length < 3 || f.per >= mid / 5);
  return { ...best, total: +(best.per * def.std).toFixed(2) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [defsFile, dir, branches, ...only] = process.argv.slice(2);
  const defs = JSON.parse(fs.readFileSync(defsFile, 'utf8'));
  const bs = branches.split(',').map(s => { const [chain, k] = s.split(':'); return { chain, items: JSON.parse(fs.readFileSync(`${dir}/items-${chain}.json`)), prices: JSON.parse(fs.readFileSync(`${dir}/p-${k}.json`)) }; });
  for (const [name, def] of Object.entries(defs)) {
    if (only.length && !only.includes(name) && !only.includes(def.dept)) continue;
    if (def.skip) { console.log(`\n## ${name} — skip: ${def.skip}`); continue; }
    if (def.ask) { console.log(`\n## ${name} — ask: ${def.ask} → ${def.options.join(', ')}`); continue; }
    console.log(`\n## ${name} (${def.std} ${def.by})`);
    for (const b of bs) {
      const all = Object.keys(b.prices).filter(c => b.items[c] && matches(def, b.items[c][0]));
      const best = priceFor(def, b.items, b.prices);
      const others = all.filter(c => c !== best?.code).slice(0, 5).map(c => b.items[c][0]).join(' ; ');
      console.log(`  ${b.chain}: ${best ? `₪${best.total} ← ${best.name} (₪${best.price})` : 'not found'} | ${all.length} matched${others ? ': ' + others : ''}`);
    }
  }
}
