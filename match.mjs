// Matching a grocery-list product (generic, like "חלב 3%") to a branch's items, and its price for a standard amount.
// A definition (defs.json, by product name): { q: [alternatives], x: [exclusions], by: 'kg'|'L'|'unit', std, skip? }
//   q    regexes on the item name (quotes made plain, see clean); an item matches if any one does
//   x    regexes; an item matching any of them is left out
//   by   what the price is compared per: kilo, liter, or unit (a pack of 18 eggs is 18 units; a 32-roll pack is 32)
//   std  the amount counted when the list gives none (1 kg tomatoes, 1 L milk, 12 eggs)
//   skip a reason this product isn't compared (a whole category, like "אוכל לחתולים")
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
// how many units a pack holds: "18 יח", "12 יחידות", "32 גליל", "x6"; else the item's own count when its unit is units
const COUNT = /(\d+)\s*(?:יח(?:ידות|'|י)?|גלילים|גליל|גל'|זוגות|שקיות|ביצים)(?![א-ת])|(?:^|\s)(\d+)\s*(?:L|M|XL|S)?\s*(?:ביצים)|(?:x|X|\*)\s*(\d+)(?!\d)/;

// amount of `by` in one item, or null when it can't be told
export function amount(item, by) {
  const [name, qty, unit, weighted] = item;
  if (by === 'kg' || by === 'L') {
    if (weighted) return by === 'kg' ? 1 : null; // weighted items are priced per kilo
    const u = UNIT[unit]; if (u && u[0] === by && qty > 0) return qty * u[1];
    for (const [re, b, f] of SIZE) { const m = clean(name).match(re); if (m && b === by) return num(m[1]) * f; }
    // names cut at 20 letters lose the size ("חלב תנובה 3% שומן 2"); an unnamed unit then tells by its size: 2 is liters, 250 is ml
    if (!UNIT[unit] && unit !== 'יחידות' && qty > 0) return qty <= 5 ? qty : qty >= 20 ? qty / 1000 : null;
    return null;
  }
  if (weighted) return null;
  const m = clean(name).match(COUNT); if (m) return +(m[1] || m[2] || m[3]);
  // without a count in the name only a "units" item can be counted (toilet paper in meters can't)
  return unit === 'יחידות' && qty >= 1 && qty < 200 ? qty : null;
}

const compile = def => def.re || (def.re = { q: def.q.map(s => new RegExp(s)), x: (def.x || []).map(s => new RegExp(s)) });
export const matches = (def, name) => { const { q, x } = compile(def), n = clean(name); return q.some(r => r.test(n)) && !x.some(r => r.test(n)); };

// the branch's price for a product: the cheapest item per unit, times the standard amount
export function priceFor(def, items, prices) {
  if (def.skip) return null;
  let best = null;
  for (const [code, price] of Object.entries(prices)) {
    const it = items[code]; if (!it || !matches(def, it[0])) continue;
    const a = amount(it, def.by); if (!a) continue;
    const per = price / a; if (!best || per < best.per) best = { code, name: it[0], price, per, total: +(per * def.std).toFixed(2) };
  }
  return best;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const [defsFile, dir, branches, ...only] = process.argv.slice(2);
  const defs = JSON.parse(fs.readFileSync(defsFile, 'utf8'));
  const bs = branches.split(',').map(s => { const [chain, k] = s.split(':'); return { chain, items: JSON.parse(fs.readFileSync(`${dir}/items-${chain}.json`)), prices: JSON.parse(fs.readFileSync(`${dir}/p-${k}.json`)) }; });
  for (const [name, def] of Object.entries(defs)) {
    if (only.length && !only.includes(name) && !only.includes(def.dept)) continue;
    if (def.skip) { console.log(`\n## ${name} — skip: ${def.skip}`); continue; }
    console.log(`\n## ${name} (${def.std} ${def.by})`);
    for (const b of bs) {
      const all = Object.keys(b.prices).filter(c => b.items[c] && matches(def, b.items[c][0]));
      const best = priceFor(def, b.items, b.prices);
      const others = all.filter(c => c !== best?.code).slice(0, 5).map(c => b.items[c][0]).join(' ; ');
      console.log(`  ${b.chain}: ${best ? `₪${best.total} ← ${best.name} (₪${best.price})` : 'not found'} | ${all.length} matched${others ? ': ' + others : ''}`);
    }
  }
}
