// Price-transparency files from the chains' official sites. Own code; which portals exist was learned from public projects.
// Each source gives: stores() → [{id, name, address, city, sub}], files() → Map(storeId → url-or-name of its latest PriceFull),
// and prices(storeId, ref) → [{code, name, maker, price, qty, unit, weighted}]; promoFiles() and promos(storeId, ref) do the
// same for the sales file (PromoFull) → the sales open to everyone today (see promoRows)
import { gunzipSync } from 'node:zlib';

const UA = { 'User-Agent': 'TuDu-prices/1.0 (grocery list app, daily price comparison)' };
// Files come gzipped or plain, in UTF-8, UTF-16 (with a byte-order mark) or Windows-1255
const decode = b => b[0] === 0xFF && b[1] === 0xFE ? b.subarray(2).toString('utf16le') : b[0] === 0xFE && b[1] === 0xFF ? Buffer.from(b.subarray(2)).swap16().toString('utf16le')
  : b[0] === 0xEF && b[1] === 0xBB ? b.subarray(3).toString('utf8') : (/encoding="windows-1255"/i.test(b.subarray(0, 100).toString('latin1')) ? new TextDecoder('windows-1255').decode(b) : b.toString('utf8'));
const unzip = buf => { let b = buf; try { b = gunzipSync(buf); } catch {} return decode(b); };
async function get(url, opts = {}) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(120000) }); if (r.status >= 400) throw new Error(r.status + ' ' + url); return r; }
    catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, 3000 * (i + 1))); }
  }
}
const bytes = async (url, opts) => Buffer.from(await (await get(url, opts)).arrayBuffer());

// tiny XML: every <tag>…children…</tag> as {lowercased child: text}
export function records(xml, tag) {
  const out = [], re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi'); let m;
  while ((m = re.exec(xml))) { const o = {}; m[1].replace(/<([A-Za-z_]+)>([\s\S]*?)<\/\1>/g, (_, k, v) => { o[k.toLowerCase()] = v.trim(); }); out.push(o); }
  return out;
}
const ent = s => (s || '').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const storeRow = d => ({ id: String(+d.storeid || 0), name: ent(d.storename), address: ent(d.address), city: ent(d.city), sub: ent(d.subchainname) });
const itemRows = xml => records(xml, 'Item').concat(records(xml, 'Product')).map(d => ({
  code: d.itemcode, name: ent(d.itemname || d.itemnm), maker: ent(d.manufacturername || d.manufacturename),
  price: +d.itemprice, qty: +d.quantity || null, unit: ent(d.unitqty || d.unitofmeasure),
  weighted: d.bisweighted === '1' || d.bisweighted === 'true'
})).filter(i => i.code && i.price > 0);
// latest file per store, from names like PriceFull7290027600007-001-105-20261101-0300.gz (City Market leaves out the sub-chain)
const latestByStore = (names, kind = 'PriceFull') => { const m = new Map(), re = new RegExp(`${kind}\\d+-(?:\\d+-)?0*(\\d+)-(\\d{8,12})`, 'i'); for (const n of names) { const p = n.match(re); if (p && (!m.get(p[1]) || m.get(p[1]).t < p[2] + n)) m.set(p[1], { t: p[2] + n, ref: n }); } return new Map([...m].map(([k, v]) => [k, v.ref])); };

// Sales (PromoFull): only what anyone can get at the till today — not club or credit-card sales, coupons, gifts, or sales
// that need a basket total; a sale on hundreds of items at once is a store-wide coupon, not a price. Each gives the item
// codes and what it asks: MinQty items for DiscountedPrice ("3 ב-10"), or DiscountRate % off
const tag = (b, t) => (b.match(new RegExp(`<${t}>([^<]*)</${t}>`, 'i')) || [])[1]?.trim() || '';
export function promoRows(xml, now = new Date()) {
  const today = now.toISOString().slice(0, 10), out = [];
  for (const [, b] of xml.matchAll(/<Promotion>([\s\S]*?)<\/Promotion>/gi)) {
    const start = (tag(b, 'PromotionStartDateTime') || tag(b, 'PromotionStartDate')).slice(0, 10), end = (tag(b, 'PromotionEndDateTime') || tag(b, 'PromotionEndDate')).slice(0, 10);
    if ((start && start > today) || (end && end < today)) continue;
    const clubs = [...b.matchAll(/<Club(?:ID|Id)>([^<]*)</gi)].map(m => m[1].trim());
    if (clubs.length && !clubs.some(c => /^0(\D|$)/.test(c))) continue;
    if (tag(b, 'AdditionalIsCoupon') === '1' || tag(b, 'IsGiftItem') === '1' || +tag(b, 'AdditionalGiftCount') > 0 || +tag(b, 'MinPurchaseAmount') > 0) continue;
    const codes = [...b.matchAll(/<ItemCode>([^<]+)</gi)].map(m => m[1].trim()); if (!codes.length || codes.length > 300) continue;
    out.push({ codes, minQty: +tag(b, 'MinQty') || 1, price: +tag(b, 'DiscountedPrice') || 0, rate: +tag(b, 'DiscountRate') || 0, desc: ent(tag(b, 'PromotionDescription')) });
  }
  return out;
}

// A sale's price per item, next to the item's regular price, or null when the sale can't be read safely: "3 ב-10" (or
// MinQty 3 with DiscountedPrice 10) is 3.33; MinQty 1 is the price itself; a rate is % off. Chains differ on whether
// DiscountedPrice is per item or for all MinQty, so a reading that lands outside 20–99.5% of the regular price is dropped
export function salePrice(p, regular) {
  const ok = v => v > 0 && v >= regular * 0.2 && v < regular * 0.995 ? +v.toFixed(2) : null;
  const xy = p.desc.match(/(\d+)\s*ב\s*-?\s*(\d+(?:\.\d+)?)\s*(?:ש"ח|₪)?/);
  if (xy && +xy[1] >= 2 && +xy[1] <= 12) return ok(+xy[2] / +xy[1]) && { unit: ok(+xy[2] / +xy[1]), qty: +xy[1] };
  if (p.price > 0) { const q = Math.max(1, Math.round(p.minQty)); for (const v of q > 1 ? [p.price / q, p.price] : [p.price]) if (ok(v)) return { unit: ok(v), qty: q }; return null; }
  if (p.rate > 0 && p.rate < 100 && p.minQty <= 1) return ok(regular * (1 - p.rate / 100)) && { unit: ok(regular * (1 - p.rate / 100)), qty: 1 };
  return null;
}

// Shufersal
const SHUF = 'https://prices.shufersal.co.il/FileObject/UpdateCategory';
const shufLinks = async (cat, store = 0) => [...(await (await get(`${SHUF}?catID=${cat}&storeId=${store}`)).text()).replace(/&amp;/g, '&').matchAll(/href="(https:\/\/[^"]+)"/g)].map(m => m[1]);
const shufersal = {
  name: 'שופרסל',
  stores: async () => records(unzip(await bytes((await shufLinks(5))[0])), 'Store').map(storeRow),
  // Shufersal lists files per store, so the store's latest link is looked up when its prices are fetched
  files: async ids => new Map(ids.map(id => [id, null])),
  prices: async id => { const u = (await shufLinks(2, id)).filter(u => /PriceFull/i.test(u)).pop(); if (!u) throw new Error('no PriceFull'); return itemRows(unzip(await bytes(u))); },
  promoFiles: async ids => new Map(ids.map(id => [id, null])),
  promos: async id => { const u = (await shufLinks(4, id)).filter(u => /PromoFull/i.test(u)).pop(); return u ? promoRows(unzip(await bytes(u))) : []; }
};

// publishedprices.co.il: each chain has a public user with an empty password
const PP = 'https://url.publishedprices.co.il';
async function ppSession(user) {
  let cookie = '';
  const keep = r => { for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0], k = kv.split('=')[0]; cookie = cookie.split('; ').filter(x => x && !x.startsWith(k + '=')).concat(kv).join('; '); } return r; };
  const g = async (path, init = {}) => keep(await get(PP + path, { redirect: 'manual', ...init, headers: { cookie, ...(init.headers || {}) } }));
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  let tok = (await (await g('/login')).text()).match(/name="csrftoken" content="([^"]+)"/)[1];
  await g('/login/user', { method: 'POST', body: new URLSearchParams({ username: user, password: '', csrftoken: tok }), headers: form });
  const m = (await (await g('/file')).text()).match(/name="csrftoken" content="([^"]+)"/); if (!m) throw new Error('login failed ' + user);
  tok = m[1];
  const ls = async q => (await (await g('/file/json/dir', { method: 'POST', body: new URLSearchParams({ sEcho: 1, iDisplayStart: 0, iDisplayLength: 100000, sSearch: q, cd: '/', csrftoken: tok }), headers: form })).json()).aaData.map(f => f.fname);
  const dl = async f => unzip(Buffer.from(await (await g('/file/d/' + f)).arrayBuffer()));
  return { ls, dl };
}
const published = (user, name) => {
  let s; const session = async () => s || (s = await ppSession(user));
  return {
    name,
    stores: async () => { const x = await session(); const f = (await x.ls('Stores')).sort().pop(); if (!f) throw new Error('no Stores file'); return records(await x.dl(f), 'Store').map(storeRow); },
    files: async () => latestByStore(await (await session()).ls('PriceFull')),
    prices: async (id, ref) => itemRows(await (await session()).dl(ref)),
    promoFiles: async () => latestByStore(await (await session()).ls('PromoFull'), 'PromoFull'),
    promos: async (id, ref) => promoRows(await (await session()).dl(ref))
  };
};

// Carrefour (Yayno Bitan joined it)
const CAR = 'https://prices.carrefour.co.il';
let carIdx;
const carIndex = async () => carIdx || (carIdx = (async () => { const h = await (await get(CAR + '/')).text(); return { path: h.match(/const path = '(\d+)'/)[1], names: [...new Set([...h.matchAll(/"name":"([^"]+)"/g)].map(m => m[1]))] }; })());
const carrefour = {
  name: 'קרפור',
  stores: async () => { const { path, names } = await carIndex(); const n = names.filter(n => /^Stores/i.test(n)).sort().pop(); return records(unzip(await bytes(`${CAR}/${path}/${n}`)), 'Store').map(storeRow); },
  files: async () => latestByStore((await carIndex()).names),
  prices: async (id, ref) => itemRows(unzip(await bytes(`${CAR}/${(await carIndex()).path}/${ref}`))),
  promoFiles: async () => latestByStore((await carIndex()).names, 'PromoFull'),
  promos: async (id, ref) => promoRows(unzip(await bytes(`${CAR}/${(await carIndex()).path}/${ref}`)))
};

// Hatzi Hinam: its own site lists blob links, newest first, a few per page
const HH = 'https://shop.hazi-hinam.co.il/Prices';
const hhLinks = async (f, pages) => { const out = []; for (let p = 1; p <= pages; p++) { const l = [...(await (await get(`${HH}?p=${p}&f=${f}`)).text()).matchAll(/https:\/\/hazihinam[^"']+\.gz/g)].map(m => m[0]); if (!l.length) break; out.push(...l); } return out; };
let hhList; const hhAll = () => hhList || (hhList = hhLinks(1, 40)); // one listing (all file types) for prices and sales
const hazihinam = {
  name: 'חצי חינם',
  stores: async () => { const u = (await hhLinks(3, 10)).filter(u => /Stores/i.test(u)).sort().pop(); if (!u) throw new Error('no Stores file');
    return records(unzip(await bytes(u)), 'Store').map(storeRow).map(s => ({ ...s, name: s.name || 'חצי חינם', address: s.address.replace(/,\s*ישראל\s*$/, '').replace(/,\s*[^,]+$/, '') })); },
  files: async () => latestByStore(await hhAll()),
  prices: async (id, ref) => itemRows(unzip(await bytes(ref))),
  promoFiles: async () => latestByStore(await hhAll(), 'PromoFull'),
  promos: async (id, ref) => promoRows(unzip(await bytes(ref)))
};

// laibcatalog.co.il: a file service some chains use (Victory), with its file list as JSON
const LAIB = 'https://laibcatalog.co.il/webapi';
const laib = (edi, name) => {
  let list; const all = async () => list || (list = await (await get(`${LAIB}/api/getfiles?edi=${edi}`)).json());
  const url = f => `${LAIB}/${edi}/${encodeURIComponent(f)}`;
  return {
    name,
    stores: async () => { const f = (await all()).filter(f => f.fileType === 'stores').map(f => f.fileName).sort().pop(); if (!f) throw new Error('no Stores file'); return records(unzip(await bytes(url(f))), 'Store').map(storeRow); },
    files: async () => latestByStore((await all()).filter(f => f.fileType === 'pricefull').map(f => f.fileName)),
    prices: async (id, ref) => itemRows(unzip(await bytes(url(ref)))),
    promoFiles: async () => latestByStore((await all()).filter(f => f.fileType === 'promofull').map(f => f.fileName), 'PromoFull'),
    promos: async (id, ref) => promoRows(unzip(await bytes(url(ref))))
  };
};

// binaprojects.com: a site per chain, used by smaller chains; files listed by type (1 stores, 4 full prices, 5 full sales), and each
// download link asked for separately
const bina = (host, name) => {
  const B = `https://${host}.binaprojects.com`, post = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  const list = async type => (await (await get(`${B}/MainIO_Hok.aspx`, { ...post, body: new URLSearchParams({ WStore: 0, WDate: '', WFileType: type }) })).json()).map(f => f.FileNm);
  const file = async f => unzip(await bytes((await (await get(`${B}/Download.aspx?FileNm=${encodeURIComponent(f)}`, { ...post, body: '' })).json())[0].SPath));
  return {
    name,
    stores: async () => { const f = (await list(1)).sort().pop(); if (!f) throw new Error('no Stores file'); return records(await file(f), 'Store').map(storeRow); },
    files: async () => latestByStore(await list(4)),
    prices: async (id, ref) => itemRows(await file(ref)),
    promoFiles: async () => latestByStore(await list(5), 'PromoFull'),
    promos: async (id, ref) => promoRows(await file(ref))
  };
};

// the files of one day are listed per day, so these look at today and the two days before (dates as YYYY-MM-DD)
const day = back => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);

// City Market: its own site lists files by type (1 prices, 3 stores; f=1 full), a page of rows per day, each with a
// download id and size. Some branches post hourly "full" files of a few KB with no prices, so smaller ones are passed over.
// Its stores file has no address: the branch name ends with ", street number town".
const CM = 'https://www.citymarket-shops.co.il';
const cmList = async type => {
  const out = new Map();
  for (let d = 0; d < 3; d++) for (let p = 1; p <= 10; p++) {
    const rows = [...(await (await get(`${CM}/?t=${type}&f=1&d=${day(d)}&p=${p}`)).text())
      .matchAll(/<td>\s*((?:Price|Promo|Stores)[\w.-]+)\s*<\/td>\s*<td>[^<]*<\/td>\s*<td>[^<]*<\/td>\s*<td>\s*([\d.]+)\s*<\/td>\s*<td>\s*<a href="(\/downloadFile\/[^"]+)"/g)];
    const size = out.size; for (const [, n, kb, u] of rows) out.set(n, { url: CM + u, kb: +kb });
    if (out.size === size) break;
  }
  return out;
};
const citymarketShops = {
  name: 'סיטי מרקט',
  stores: async () => { const f = [...(await cmList(3))].sort().pop(); if (!f) throw new Error('no Stores file');
    return records(unzip(await bytes(f[1].url)), 'SubChainStoreXMLObject').map(storeRow).map(s => { const i = s.name.lastIndexOf(',');
      return s.address !== 'unknown' || i < 0 ? s : { ...s, name: s.name.slice(0, i).replace(/בע"מ/g, '').trim(), address: s.name.slice(i + 1).trim(), city: '' }; }); },
  files: async () => { const l = new Map([...await cmList(1)].filter(([, f]) => f.kb >= 20)); return new Map([...latestByStore(l.keys())].map(([id, n]) => [id, l.get(n).url])); },
  prices: async (id, url) => itemRows(unzip(await bytes(url))),
  promoFiles: async () => { const l = await cmList(2); return new Map([...latestByStore(l.keys(), 'PromoFull')].map(([id, n]) => [id, l.get(n).url])); },
  promos: async (id, url) => promoRows(unzip(await bytes(url)))
};

// Netiv HaHesed (with Bar-Kol, Shira Market, Express Mehadrin): its site lists one day's files of a type
const NH = 'https://app.netiv-hesed.com';
const nhList = async type => { const out = []; for (let d = 0; d < 3; d++) out.push(...[...(await (await get(`${NH}/?FileType=${type}&Date=${day(d)}`)).text()).matchAll(/fileName=([^"&]+)/g)].map(m => decodeURIComponent(m[1]))); return out; };
const nhFile = async f => unzip(await bytes(`${NH}/Prices/Download?fileName=${encodeURIComponent(f)}`));
const netivhesed = {
  name: 'נתיב החסד',
  stores: async () => { const f = (await nhList('Stores')).sort().pop(); if (!f) throw new Error('no Stores file'); return records(await nhFile(f), 'Store').map(storeRow); },
  files: async () => latestByStore(await nhList('PriceFull')),
  prices: async (id, ref) => itemRows(await nhFile(ref)),
  promoFiles: async () => latestByStore(await nhList('PromoFull'), 'PromoFull'),
  promos: async (id, ref) => promoRows(await nhFile(ref))
};

export const SOURCES = {
  shufersal, carrefour, hazihinam,
  RamiLevi: published('RamiLevi', 'רמי לוי'), osherad: published('osherad', 'אושר עד'), yohananof: published('yohananof', 'יוחננוף'),
  TivTaam: published('TivTaam', 'טיב טעם'), Keshet: published('Keshet', 'קשת טעמים'), freshmarket: published('freshmarket', 'פרשמרקט'),
  SalachD: published('SalachD', 'סאלח דבאח'), Stop_Market: published('Stop_Market', 'סטופ מרקט'), politzer: published('politzer', 'פוליצר'),
  doralon: published('doralon', 'am:pm'),
  victory: laib('7290696200003', 'ויקטורי'), mshuk: laib('7290661400001', 'מחסני השוק'), hcohen: laib('7290455000004', 'ח. כהן'),
  kingstore: bina('kingstore', 'קינג סטור'), maayan2000: bina('maayan2000', 'מעיין 2000'), zolvebegadol: bina('zolvebegadol', 'זול ובגדול'),
  supersapir: bina('supersapir', 'סופר ספיר'), citymarket: bina('citymarketkiryatgat', 'סיטי מרקט'), superbareket: bina('superbareket', 'סופר ברקת'),
  ktshivuk: bina('ktshivuk', 'משנת יוסף'), shukhayir: bina('shuk-hayir', 'שוק העיר'), shefabirkathashem: bina('shefabirkathashem', 'שפע ברכת השם'),
  citymarketshops: citymarketShops, netivhesed
};
