// The nightly price job: every branch of every chain we can read → out/
//   out/branches.json          [{k, chain, chainName, name, address, city, lat, lng, n, updated}]
//   out/prices/<k>.json        {code: price}               (one file per branch, small)
//   out/items/<chain>.json     {code: [name, qty, unit, weighted, maker]}
//   out/report.json            what worked, what failed, how long it took
// Run: node tools/prices/job.mjs [--chains=RamiLevi,carrefour] [--limit=5]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOURCES } from './sources.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = HERE + 'out/', GEO = HERE + 'geocode.json', CITIES = HERE + 'cities.json';
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const CHAINS = arg('chains') ? arg('chains').split(',') : Object.keys(SOURCES);
const LIMIT = +arg('limit') || Infinity, PARALLEL = 6;
for (const d of ['', 'prices', 'items']) fs.mkdirSync(OUT + d, { recursive: true });
const started = Date.now(), log = (...a) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s]`, ...a);

// Some chains give the city as its official settlement code (2640 = ראש העין); the list comes from data.gov.il
async function cityNames() {
  if (fs.existsSync(CITIES)) return JSON.parse(fs.readFileSync(CITIES));
  const r = await (await fetch('https://data.gov.il/api/3/action/datastore_search?resource_id=5c78e9fa-c2e2-4771-93ff-7f400a12f7ba&limit=5000')).json();
  const m = Object.fromEntries(r.result.records.map(x => [String(+x['סמל_ישוב']), x['שם_ישוב'].trim().replace(/\s+/g, ' ')]));
  fs.writeFileSync(CITIES, JSON.stringify(m)); return m;
}

// Branch locations: OpenStreetMap's Nominatim (at most one request a second), then Photon for addresses Nominatim
// doesn't know; every answer is remembered in geocode.json, so later nights only look up new branches
const geo = fs.existsSync(GEO) ? JSON.parse(fs.readFileSync(GEO)) : {};
const UA_GEO = { 'User-Agent': 'TuDu-prices/1.0 (grocery list app, branch locations)', 'Accept-Language': 'he' };
let lastGeo = 0, geoQueue = Promise.resolve();
const remember = (key, v) => { geo[key] = v; fs.writeFileSync(GEO, JSON.stringify(geo)); return v; };
const pt = (lat, lon) => [+(+lat).toFixed(5), +(+lon).toFixed(5)];
const nominatim = q => geoQueue = geoQueue.then(async () => {
  if (q in geo) return geo[q];
  await new Promise(r => setTimeout(r, Math.max(0, lastGeo + 1100 - Date.now()))); lastGeo = Date.now();
  try { const j = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=il&q=' + encodeURIComponent(q), { headers: UA_GEO })).json(); return remember(q, j[0] ? pt(j[0].lat, j[0].lon) : null); }
  catch { return null; }
});
// Photon guesses freely, so only an answer in the right town counts
const photon = async (q, city) => {
  const key = 'photon:' + q; if (key in geo) return geo[key];
  try {
    const j = await (await fetch('https://photon.komoot.io/api/?limit=3&lang=default&bbox=34.2,29.4,35.9,33.4&q=' + encodeURIComponent(q), { headers: UA_GEO })).json();
    const town = city.split(/[\s-]/)[0];
    const f = j.features.find(f => ['house', 'street'].includes(f.properties.type) && [f.properties.city, f.properties.locality, f.properties.district, f.properties.county].some(x => x && x.includes(town)));
    return remember(key, f ? pt(f.geometry.coordinates[1], f.geometry.coordinates[0]) : null);
  } catch { return null; }
};
const townName = c => c.replace(/\s*-\s*יפו$/, '').replace(/^(מודיעין)-.*/, '$1').trim();
// "רח' 9 ככר דיזנגוף פינת ..." → "כיכר דיזנגוף 9"
function cleanAddress(a, city) {
  a = a.replace(/&#x?[0-9a-f]+;/gi, ' ').replace(/\b(unknown|null)\b/gi, '').replace(/^\d+$/, '');
  a = a.replace(/(^|\s)(רחוב|רח'|רח\.|רח)\s*/g, '$1').replace(/(^|\s)שד'\s*/g, '$1שדרות ').replace(/ככר/g, 'כיכר');
  a = a.replace(/\s*(פינת|פ\.|ת\.ד\.?|מתחם|מרכז מסחרי|דרומית ל|צפונית ל).*$/, '').split(',')[0];
  if (city) a = a.replace(new RegExp('\\s*' + townName(city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*$'), '');
  a = a.replace(/^(\d+[א-ת]?)\s+(.+)$/, '$2 $1').replace(/\s+/g, ' ').trim();
  return /[א-תa-z]{2}/i.test(a) ? a : '';
}
async function locate(s, city) {
  const town = city && !/^\d+$/.test(city) ? townName(city) : '';
  const addr = cleanAddress(s.address, town);
  if (addr && town) {
    const p = await nominatim(`${addr}, ${town}`) || await photon(`${addr} ${town}`, town);
    if (p) return { lat: p[0], lng: p[1] };
    const street = addr.replace(/\s*\d+[א-ת]?$/, '');
    const q = street !== addr && street.length > 2 && (await nominatim(`${street}, ${town}`) || await photon(`${street} ${town}`, town));
    if (q) return { lat: q[0], lng: q[1], approx: 'street' };
  }
  const c = town && await nominatim(town);
  return c ? { lat: c[0], lng: c[1], approx: 'town' } : null;
}

// Online shops and warehouses have no street to walk into
const SKIP = /online|אונליין|אינטרנט|www\.|משלוחים|מחסן|מרלו"ג|לוגיסט/i;
const pool = async (list, fn) => { let i = 0; await Promise.all(Array.from({ length: PARALLEL }, async () => { while (i < list.length) { const x = list[i++]; await fn(x); } })); };

const cities = await cityNames();
if (process.argv.includes('--locate-only')) {
  const list = JSON.parse(fs.readFileSync(OUT + 'branches.json'));
  for (const b of list) if (b.approx || !b.lat) { const { lat, lng, approx, ...rest } = b; Object.assign(b, { ...rest }, await locate(b, b.city)); if (!b.approx) delete b.approx; }
  fs.writeFileSync(OUT + 'branches.json', JSON.stringify(list.map(b => b.approx ? b : (({ approx, ...x }) => x)(b))));
  log('town only:', list.filter(b => b.approx === 'town').length, '| street only:', list.filter(b => b.approx === 'street').length, '| none:', list.filter(b => !b.lat).length, 'of', list.length);
  process.exit(0);
}
const branches = [], report = { started: new Date(started).toISOString(), chains: {} };
for (const chain of CHAINS) {
  const src = SOURCES[chain], rep = report.chains[chain] = { name: src.name, stores: 0, prices: 0, failed: [] };
  try {
    const stores = (await src.stores()).filter(s => !SKIP.test(s.name + ' ' + s.address + ' ' + s.sub));
    const files = await src.files(stores.map(s => s.id));
    const todo = stores.filter(s => files.has(s.id)).slice(0, LIMIT);
    rep.stores = stores.length; rep.noFile = stores.length - stores.filter(s => files.has(s.id)).length;
    log(chain, stores.length, 'stores,', todo.length, 'with price files');
    const items = {};
    await pool(todo, async s => {
      const k = `${chain}-${s.id}`;
      try {
        const list = await src.prices(s.id, files.get(s.id));
        const prices = {};
        for (const i of list) { prices[i.code] = i.price; items[i.code] ||= [i.name, i.qty, i.unit, i.weighted ? 1 : 0, i.maker]; }
        fs.writeFileSync(`${OUT}prices/${k}.json`, JSON.stringify(prices));
        const city = cities[s.city] || s.city;
        branches.push({ k, chain, chainName: src.name, name: s.name, sub: s.sub, address: s.address, city, ...(await locate(s, city)), n: list.length });
        rep.prices++;
      } catch (e) { rep.failed.push(`${s.id} ${s.name}: ${e.message}`); }
    });
    fs.writeFileSync(`${OUT}items/${chain}.json`, JSON.stringify(items));
    log(chain, 'done:', rep.prices, 'branches,', Object.keys(items).length, 'products,', rep.failed.length, 'failed');
  } catch (e) { rep.error = e.message; log(chain, 'FAILED:', e.message); }
}
branches.sort((a, b) => a.k.localeCompare(b.k));
fs.writeFileSync(OUT + 'branches.json', JSON.stringify(branches));
Object.assign(report, { finished: new Date().toISOString(), minutes: +((Date.now() - started) / 60000).toFixed(1), branches: branches.length, noLocation: branches.filter(b => !b.lat).map(b => b.k), approxLocation: branches.filter(b => b.approx).length, townOnly: branches.filter(b => b.approx === 'town').length });
fs.writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 1));
log('branches with prices:', branches.length, '| no location:', report.noLocation.length, '| approximate:', report.approxLocation);
