// The nightly price job: every branch of every chain we can read → out/
//   out/branches.json          [{k, chain, chainName, name, sub, address, city, lat, lng, approx?, n}]   approx: street | town | place
//   out/prices/<k>.json        {code: price}               (one file per branch, small)
//   out/items/<chain>.json     {code: [name, qty, unit, weighted, maker]}
//   out/report.json            what worked, what failed, how long it took
// Run: node job.mjs [--chains=RamiLevi,carrefour] [--limit=5] [--out=dir] [--merge=dir] [--no-locate] [--locate-only]
//   --merge=dir    fold in a run made elsewhere: some chains (Carrefour, Victory…) refuse servers abroad, so a computer in Israel
//                  fetches them (local.sh) and this job takes its chains as they are, without fetching them again
//   --no-locate    leave missing cities and branch locations out (the computer in Israel leaves them to this job)
//   --locate-only  only redo cities and locations in an existing branches.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES } from './sources.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const arg = k => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const flag = k => process.argv.includes(`--${k}`);
const OUT = path.resolve(arg('out') || HERE + 'out') + '/', MERGE = arg('merge') && path.resolve(arg('merge')) + '/';
const GEO = HERE + 'geocode.json', CITIES = HERE + 'cities.json', PLACES = HERE + 'places.json';
const LIMIT = +arg('limit') || Infinity, PARALLEL = 6, MAX_MERGE_AGE_H = 36;
for (const d of ['', 'prices', 'items']) fs.mkdirSync(OUT + d, { recursive: true });
const started = Date.now(), log = (...a) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s]`, ...a);

// Some chains give the city as its official settlement code (2640 = ראש העין); the list comes from data.gov.il
async function cityNames() {
  if (fs.existsSync(CITIES)) return JSON.parse(fs.readFileSync(CITIES));
  const r = await (await fetch('https://data.gov.il/api/3/action/datastore_search?resource_id=5c78e9fa-c2e2-4771-93ff-7f400a12f7ba&limit=5000')).json();
  const m = Object.fromEntries(r.result.records.map(x => [String(+x['סמל_ישוב']), x['שם_ישוב'].trim().replace(/\s+/g, ' ')]));
  fs.writeFileSync(CITIES, JSON.stringify(m)); return m;
}

// Other chains leave the city out (0, or a code that isn't a settlement); it is usually in the branch name
// ("יוחננוף קרית שמונה"). Towns that other branches are in come first, then a name or address that is nothing but a town
// ("אור יהודה"; streets are named after towns, so an address never counts otherwise), then any settlement in the name
// that isn't also a common word (אזור, רחוב). ALIASES: short forms and well-known places the chains write instead of the town
const ALIASES = { 'ת"א': 'תל אביב - יפו', 'יד אליהו': 'תל אביב - יפו', 'ראשלצ': 'ראשון לציון', 'ראשל"צ': 'ראשון לציון', 'ב"ש': 'באר שבע',
  'פ"ת': 'פתח תקווה', 'כ"ס': 'כפר סבא', 'עקרון': 'קרית עקרון', 'פולג': 'נתניה', 'חוצות המפרץ': 'חיפה', 'צור יגאל': 'כוכב יאיר-צור יגאל',
  'דלית אל כרמל': 'דאלית אל-כרמל', 'מישור אדומים': 'מעלה אדומים', 'ויתקין': 'כפר ויתקין', 'טירת הכרמל': 'טירת כרמל', 'תל אבית יפה': 'תל אביב - יפו',
  'יוקנעם': 'יקנעם עילית', 'טבעון': 'קרית טבעון', 'קרית חיים': 'חיפה', 'קרית אליעזר': 'חיפה' };
const WORDS = new Set(['אזור', 'רחוב', 'מרכז', 'שדרות', 'נווה', 'רמות']);
const PREFIX = new Set(['כפר', 'קרית', 'נווה', 'נוה', 'גבעת', 'רמת', 'בית', 'תל', 'עין', 'שכונת', 'רחוב', 'שדרות']);
const isTown = c => c && !/^\d+$/.test(c);
// places.json: where a branch is, told by hand, for branches the files and guesses can't place:
// branch key → town or place ("מחלף לטרון"), or {city, address} when the file's address is missing or wrong
const places = fs.existsSync(PLACES) ? JSON.parse(fs.readFileSync(PLACES)) : {};
// Branch names are matched word by word, ignoring marks and doubled letters only ("קרית גת*" = "קריית גת", "סכנין" =
// "סח'נין"); dropping all vowel letters, as for map answers, would make short names collide (בילו = אביאל)
const mild = s => s.replace(/ח['׳]/g, 'כ').replace(/["'״׳`*.]/g, '').replace(/יי/g, 'י').replace(/וו/g, 'ו');
const words = t => t.replace(/[-,()]/g, ' ').split(/\s+/).map(mild).filter(Boolean);
function fillCities(list, cities) {
  const parts = names => names.flatMap(n => [n, ...n.split(/\s*-\s*/)].filter(p => p.length > 2).map(p => [words(p), n])).sort((a, b) => b[0].join('').length - a[0].join('').length);
  const near = parts([...new Set(list.map(b => b.city).filter(isTown))]).concat(Object.entries(ALIASES).map(([p, n]) => [words(p), n]));
  const all = new Set(Object.values(cities).map(c => words(c).join(' '))), any = parts(Object.values(cities)).filter(([w]) => w.join('').length > 2 && !(w.length === 1 && WORDS.has(w[0])));
  for (const b of list) if (places[b.k]) Object.assign(b, typeof places[b.k] === 'string' ? { city: places[b.k] } : places[b.k]);
  // a written town counts only if it's a real one (or a known short form); typos like "תל אבית יפה" are searched for below
  const key = c => words(c).join(' '), known = new Map([...Object.values(cities).map(c => [key(c), c]), ...Object.entries(ALIASES).map(([p, n]) => [key(p), n])]);
  for (const b of list) if (isTown(b.city) && known.has(key(b.city))) b.city = known.get(key(b.city));
  for (const b of list) if (!isTown(b.city) || !known.has(key(b.city))) {
    const written = isTown(b.city) ? b.city : '';
    // the town written first in the name wins ("ראשל"צ ירושלים 120" is a street in Rishon), then the longer one; a word
    // right after כפר, קרית… belongs to a longer name ("כפר עזר" isn't the moshav עזר)
    const at = (text, w) => text.findIndex((_, i) => !PREFIX.has(text[i - 1]) && w.every((x, j) => text[i + j] === x));
    const found = (text, t) => t.map(([w, n]) => [at(text, w), n]).filter(([i]) => i >= 0).sort((a, b) => a[0] - b[0])[0]?.[1];
    const name = words(b.name), whole = [b.name, b.address].map(t => words(t).join(' ')).find(t => all.has(t));
    // some chains write the town after the street ("חנקין 95 חולון"): it is taken from there and left out of the street
    const m = b.address.match(/^(.*?\d+[א-ת]?)\s+(\D+)$/), tail = m ? words(m[2]) : [];
    const tailTown = [...near, ...any].find(([w]) => w.length === tail.length && at(tail, w) === 0)?.[1];
    b.city = tailTown || found(name, near) || (whole && Object.values(cities).find(c => words(c).join(' ') === whole)) || found(name, any) || found(words(written), any) || '';
    if (tailTown && b.city === tailTown) b.address = m[1].replace(/^רח(וב|')?\s+/, '');
    if (!b.city) b.city = written; // nothing better: the town as written is kept, never dropped
  }
}

// Branch locations: OpenStreetMap's Nominatim (at most one request a second), then Photon for addresses Nominatim
// doesn't know; every answer is remembered in geocode.json, so later nights only look up new branches.
// Both often put a same-named street in another town first ("טופז 1, חיפה" → Zikhron Ya'akov, "אריאל" → a street in
// Jerusalem), so only an answer inside the town asked for counts. The search area is a box around Israel rather than the
// country code, which would leave out Judea and Samaria (אריאל, מעלה אדומים)
const geo = fs.existsSync(GEO) ? JSON.parse(fs.readFileSync(GEO)) : {};
const UA_GEO = { 'User-Agent': 'TuDu-prices/1.0 (grocery list app, branch locations)', 'Accept-Language': 'he' };
let lastGeo = 0, geoQueue = Promise.resolve();
const remember = (key, v) => { geo[key] = v; fs.writeFileSync(GEO, JSON.stringify(geo)); return v; };
const pt = (lat, lon) => [+(+lat).toFixed(5), +(+lon).toFixed(5)];
// Spelling-blind: no spaces or marks, no vowel letters (קריית = קרית, דאלית = דלית), ח' = כ (סח'נין = סכנין)
const norm = s => (s || '').replace(/ח['׳]/g, 'כ').replace(/[\s\-־–'"״׳`()]/g, '').replace(/[אוי]/g, '');
// The name must start with the town ("תל־אביב–יפו" for תל אביב), so a neighbourhood like "גבעת אלונים" isn't אלונים
const sameTown = (name, town) => norm(name).replace(/^מעצהזרת/, '').startsWith(norm(town));
// Nominatim's answer names the place first and the areas it lies in after: an address must lie in the town itself (not
// through the street's own name, nor a district named after the town: Hadera is in "מחוז חיפה"), a town must be the place
const inTown = (r, town, street) => r.display_name.split(',').slice(1).map(x => x.trim())
  .filter(x => norm(x) !== norm(street) && !/^(נפת|מחוז)\s/.test(x)).some(x => sameTown(x, town));
const isPlace = (r, town) => (r.class === 'boundary' || r.class === 'place' && !['suburb', 'neighbourhood', 'quarter'].includes(r.type)) && sameTown(r.display_name.split(',')[0], town);
// Only a real answer is remembered; a refusal or an error page is tried again next night
const ask = (key, q, ok, extra = '') => geoQueue = geoQueue.then(async () => {
  if (key in geo) return geo[key];
  await new Promise(r => setTimeout(r, Math.max(0, lastGeo + 1100 - Date.now()))); lastGeo = Date.now();
  try { const j = await (await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&viewbox=34.2,33.4,35.9,29.4&bounded=1' + extra + '&q=' + encodeURIComponent(q), { headers: UA_GEO })).json();
    if (!Array.isArray(j)) return null; const r = j.find(ok); return remember(key, r ? pt(r.lat, r.lon) : null); }
  catch { return null; }
});
const street = (addr, town) => ask(`street:${addr}|${town}`, `${addr}, ${town}`, r => inTown(r, town, addr.replace(/\s*\d+[א-ת]?$/, '')));
const townAt = town => ask(`town:${town}`, town, r => isPlace(r, town), '&featureType=settlement');
// A place told by hand or a named junction is taken as it is
const placeAt = q => ask(`place:${q}`, q, () => true);
// Photon guesses freely, so only an answer in the right town counts (or, without a town, a place of exactly that name)
const photon = async (q, city) => {
  const key = 'photon:' + q; if (key in geo) return geo[key];
  try {
    const j = await (await fetch('https://photon.komoot.io/api/?limit=3&lang=default&bbox=34.2,29.4,35.9,33.4&q=' + encodeURIComponent(q), { headers: UA_GEO })).json();
    const f = j.features.find(f => city ? ['house', 'street'].includes(f.properties.type) && [f.properties.city, f.properties.locality, f.properties.county].some(x => x && sameTown(x, city)) : f.properties.name === q);
    return remember(key, f ? pt(f.geometry.coordinates[1], f.geometry.coordinates[0]) : null);
  } catch { return null; }
};
const townName = c => c.replace(/\s*-\s*יפו$/, '').replace(/^(מודיעין)-.*/, '$1').replace(/\s*\(.*\)$/, '').trim();
// "רח' 9 ככר דיזנגוף פינת ..." → "כיכר דיזנגוף 9"
function cleanAddress(a, city) {
  a = a.replace(/&#x?[0-9a-f]+;/gi, ' ').replace(/\b(unknown|null)\b/gi, '').replace(/^\d+$/, '');
  a = a.replace(/(^|\s)(רחוב|רח'|רח\.|רח)\s*/g, '$1').replace(/(^|\s)שד'\s*/g, '$1שדרות ').replace(/ככר/g, 'כיכר');
  a = a.replace(/\s*(פינת|פ\.|ת\.ד\.?|מתחם|מרכז מסחרי|דרומית ל|צפונית ל).*$/, '').split(',')[0];
  if (city) a = a.replace(new RegExp('\\s*' + townName(city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*$'), '');
  a = a.replace(/^(\d+[א-ת]?)\s+(.+)$/, '$2 $1').replace(/\s+/g, ' ').trim();
  return /[א-תa-z]{2}/i.test(a) ? a : '';
}
// No town at all: a junction, interchange or industrial zone with a name is a place of its own ("צומת ביל"ו", "מחלף לטרון").
// Malls and plain streets are not, since the same names are found in other towns
function spot(s) {
  for (const t of [s.address, s.name]) {
    const m = t.replace(/&#x?[0-9a-f]+;/gi, ' ').replace(/א\.ת\.?|אזור ה?תעשי[י]?ה/g, 'אזור תעשייה').match(/(צומת|מחלף|אזור תעשייה)\s+([^,\d]+)/);
    const name = m?.[2].split(/\s+(?:ליד|בין|מול|כביש|ל(?=צומת|מחלף))/)[0].trim();
    if (name && name.length > 2) return `${m[1]} ${name}`;
  }
}
async function locate(s, city) {
  const town = isTown(city) ? townName(city) : '';
  const addr = cleanAddress(s.address, town);
  if (addr && town) {
    const p = await street(addr, town) || await photon(`${addr} ${town}`, town);
    if (p) return { lat: p[0], lng: p[1] };
    const name = addr.replace(/\s*\d+[א-ת]?$/, '');
    const q = name !== addr && name.length > 2 && (await street(name, town) || await photon(`${name} ${town}`, town));
    if (q) return { lat: q[0], lng: q[1], approx: 'street' };
  }
  if (!town) { const q = spot(s), p = q && (await placeAt(q) || await photon(q)); return p ? { lat: p[0], lng: p[1], approx: 'place' } : {}; }
  const c = await townAt(town) || typeof places[s.k] === 'string' && await placeAt(town);
  return c ? { lat: c[0], lng: c[1], approx: 'town' } : {};
}

// Online shops and warehouses have no street to walk into (an online shop may give its web address instead of a street;
// "וולט …" branches are Wolt's delivery-only stores)
const SKIP = /online|אונליין|אינטרנט|www\.|https?:\/\/|משלוחים|מחסן|מרלו"ג|לוגיסט|וולט|wolt/i;
const pool = async (list, fn) => { let i = 0; await Promise.all(Array.from({ length: PARALLEL }, async () => { while (i < list.length) { const x = list[i++]; await fn(x); } })); };

const cities = await cityNames();
let branches = [];
const report = { started: new Date(started).toISOString(), chains: {} };

// A run from the computer in Israel: its chains are taken as they are, unless it is too old to trust (then they are tried here)
const merged = new Set();
if (MERGE && fs.existsSync(MERGE + 'report.json')) {
  const r = JSON.parse(fs.readFileSync(MERGE + 'report.json')), age = (Date.now() - Date.parse(r.started)) / 3600000;
  if (age > MAX_MERGE_AGE_H) log(`merge: the run from Israel is ${age.toFixed(0)} hours old, not used`);
  else {
    for (const d of ['prices', 'items']) fs.cpSync(MERGE + d, OUT + d, { recursive: true });
    branches.push(...JSON.parse(fs.readFileSync(MERGE + 'branches.json')).map(({ lat, lng, approx, ...b }) => b));
    for (const [c, rep] of Object.entries(r.chains)) { merged.add(c); report.chains[c] = { ...rep, from: 'israel', at: r.started }; }
    log('merge:', [...merged].join(', '), `(${age.toFixed(1)} hours old)`);
  }
}

if (flag('locate-only')) branches = JSON.parse(fs.readFileSync(OUT + 'branches.json')).map(({ lat, lng, approx, ...b }) => b);
else for (const chain of (arg('chains') ? arg('chains').split(',') : Object.keys(SOURCES)).filter(c => !merged.has(c))) {
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
        branches.push({ k, chain, chainName: src.name, name: s.name, sub: s.sub, address: s.address, city: cities[s.city] || s.city, n: list.length });
        rep.prices++;
      } catch (e) { rep.failed.push(`${s.id} ${s.name}: ${e.message}`); }
    });
    fs.writeFileSync(`${OUT}items/${chain}.json`, JSON.stringify(items));
    log(chain, 'done:', rep.prices, 'branches,', Object.keys(items).length, 'products,', rep.failed.length, 'failed');
  } catch (e) { rep.error = e.message; log(chain, 'FAILED:', e.message); }
}

// Missing cities are guessed only where all chains are together (towns of other chains' branches help)
if (!flag('no-locate')) { fillCities(branches, cities); log('locating', branches.length, 'branches'); for (const b of branches) Object.assign(b, await locate(b, b.city)); }
branches.sort((a, b) => a.k.localeCompare(b.k));
fs.writeFileSync(OUT + 'branches.json', JSON.stringify(branches));
Object.assign(report, { finished: new Date().toISOString(), minutes: +((Date.now() - started) / 60000).toFixed(1), branches: branches.length,
  noCity: branches.filter(b => !b.city).map(b => b.k), noLocation: branches.filter(b => !b.lat).map(b => b.k), approxLocation: branches.filter(b => b.approx).length, townOnly: branches.filter(b => b.approx === 'town').length });
fs.writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 1));
log('branches with prices:', branches.length, '| no city:', report.noCity.length, '| no location:', report.noLocation.length, '| approximate:', report.approxLocation);
