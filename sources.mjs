// Price-transparency files from the chains' official sites. Own code; which portals exist was learned from public projects.
// Each source gives: stores() → [{id, name, address, city, sub}], files() → Map(storeId → url-or-name of its latest PriceFull),
// and prices(storeId, ref) → [{code, name, maker, price, qty, unit, weighted}]
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
const latestByStore = names => { const m = new Map(); for (const n of names) { const p = n.match(/PriceFull\d+-(?:\d+-)?0*(\d+)-(\d{8,12})/i); if (p && (!m.get(p[1]) || m.get(p[1]).t < p[2] + n)) m.set(p[1], { t: p[2] + n, ref: n }); } return new Map([...m].map(([k, v]) => [k, v.ref])); };

// Shufersal
const SHUF = 'https://prices.shufersal.co.il/FileObject/UpdateCategory';
const shufLinks = async (cat, store = 0) => [...(await (await get(`${SHUF}?catID=${cat}&storeId=${store}`)).text()).replace(/&amp;/g, '&').matchAll(/href="(https:\/\/[^"]+)"/g)].map(m => m[1]);
const shufersal = {
  name: 'שופרסל',
  stores: async () => records(unzip(await bytes((await shufLinks(5))[0])), 'Store').map(storeRow),
  // Shufersal lists files per store, so the store's latest link is looked up when its prices are fetched
  files: async ids => new Map(ids.map(id => [id, null])),
  prices: async id => { const u = (await shufLinks(2, id)).filter(u => /PriceFull/i.test(u)).pop(); if (!u) throw new Error('no PriceFull'); return itemRows(unzip(await bytes(u))); }
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
    prices: async (id, ref) => itemRows(await (await session()).dl(ref))
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
  prices: async (id, ref) => itemRows(unzip(await bytes(`${CAR}/${(await carIndex()).path}/${ref}`)))
};

// Hatzi Hinam: its own site lists blob links, newest first, a few per page
const HH = 'https://shop.hazi-hinam.co.il/Prices';
const hhLinks = async (f, pages) => { const out = []; for (let p = 1; p <= pages; p++) { const l = [...(await (await get(`${HH}?p=${p}&f=${f}`)).text()).matchAll(/https:\/\/hazihinam[^"']+\.gz/g)].map(m => m[0]); if (!l.length) break; out.push(...l); } return out; };
const hazihinam = {
  name: 'חצי חינם',
  stores: async () => { const u = (await hhLinks(3, 10)).filter(u => /Stores/i.test(u)).sort().pop(); if (!u) throw new Error('no Stores file');
    return records(unzip(await bytes(u)), 'Store').map(storeRow).map(s => ({ ...s, name: s.name || 'חצי חינם', address: s.address.replace(/,\s*ישראל\s*$/, '').replace(/,\s*[^,]+$/, '') })); },
  files: async () => new Map([...latestByStore((await hhLinks(1, 40)).map(u => u))]),
  prices: async (id, ref) => itemRows(unzip(await bytes(ref)))
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
    prices: async (id, ref) => itemRows(unzip(await bytes(url(ref))))
  };
};

// binaprojects.com: a site per chain, used by smaller chains; files listed by type (1 stores, 4 full prices), and each
// download link asked for separately
const bina = (host, name) => {
  const B = `https://${host}.binaprojects.com`, post = { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  const list = async type => (await (await get(`${B}/MainIO_Hok.aspx`, { ...post, body: new URLSearchParams({ WStore: 0, WDate: '', WFileType: type }) })).json()).map(f => f.FileNm);
  const file = async f => unzip(await bytes((await (await get(`${B}/Download.aspx?FileNm=${encodeURIComponent(f)}`, { ...post, body: '' })).json())[0].SPath));
  return {
    name,
    stores: async () => { const f = (await list(1)).sort().pop(); if (!f) throw new Error('no Stores file'); return records(await file(f), 'Store').map(storeRow); },
    files: async () => latestByStore(await list(4)),
    prices: async (id, ref) => itemRows(await file(ref))
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
      .matchAll(/<td>\s*((?:Price|Stores)[\w.-]+)\s*<\/td>\s*<td>[^<]*<\/td>\s*<td>[^<]*<\/td>\s*<td>\s*([\d.]+)\s*<\/td>\s*<td>\s*<a href="(\/downloadFile\/[^"]+)"/g)];
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
  prices: async (id, url) => itemRows(unzip(await bytes(url)))
};

// Netiv HaHesed (with Bar-Kol, Shira Market, Express Mehadrin): its site lists one day's files of a type
const NH = 'https://app.netiv-hesed.com';
const nhList = async type => { const out = []; for (let d = 0; d < 3; d++) out.push(...[...(await (await get(`${NH}/?FileType=${type}&Date=${day(d)}`)).text()).matchAll(/fileName=([^"&]+)/g)].map(m => decodeURIComponent(m[1]))); return out; };
const nhFile = async f => unzip(await bytes(`${NH}/Prices/Download?fileName=${encodeURIComponent(f)}`));
const netivhesed = {
  name: 'נתיב החסד',
  stores: async () => { const f = (await nhList('Stores')).sort().pop(); if (!f) throw new Error('no Stores file'); return records(await nhFile(f), 'Store').map(storeRow); },
  files: async () => latestByStore(await nhList('PriceFull')),
  prices: async (id, ref) => itemRows(await nhFile(ref))
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
