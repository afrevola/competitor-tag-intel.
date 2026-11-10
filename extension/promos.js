// Turns a promo scan into a dated offer calendar, campaign asset folders and recently changed pages.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const mIdx = (s) => MONTHS.indexOf(String(s).slice(0, 3).toLowerCase());
const yr = (y, fallback) => (y == null ? fallback : (y = +y) < 100 ? 2000 + y : y);
const iso = (y, m, d) => (m < 0 || m > 11 || d < 1 || d > 31 ? null : `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();

// Pull date ranges out of offer text. Returns [{ start, end, raw }] (ISO dates, either may be null).
export function parseDates(text, refYear = new Date().getFullYear()) {
  const out = [];
  const t = String(text || '');
  let m;
  const NUM = '(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?';
  const SEP = '\\s*(?:-|–|—|to|through|thru|until)\\s*';
  // 9/8/26 - 11/15/26
  const r1 = new RegExp(NUM + SEP + NUM, 'gi');
  while ((m = r1.exec(t))) {
    const y2 = yr(m[6], refYear), y1 = yr(m[3], y2);
    out.push({ start: iso(y1, +m[1] - 1, +m[2]), end: iso(y2, +m[4] - 1, +m[5]), raw: m[0] });
  }
  // November 15 - December 31, 2026 / Nov 15 – 31
  const r2 = new RegExp(`${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?${SEP}(?:${MON}\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, 'gi');
  while ((m = r2.exec(t))) {
    const y2 = yr(m[6], refYear), y1 = yr(m[3], y2);
    const m1 = mIdx(m[1]), m2 = m[4] ? mIdx(m[4]) : m1;
    out.push({ start: iso(y1, m1, +m[2]), end: iso(y2, m2, +m[5]), raw: m[0] });
  }
  // through 12/31 / valid until 11/30/2026 / ends 1/5
  const r3 = new RegExp(`(?:through|thru|until|till|ends?|expires?|valid (?:through|until)|by)\\s+${NUM}`, 'gi');
  while ((m = r3.exec(t))) if (!out.some((o) => o.raw.includes(m[0].split(/\s+/).pop()))) out.push({ start: null, end: iso(yr(m[3], refYear), +m[1] - 1, +m[2]), raw: m[0] });
  // through October / until December 31
  const r4 = new RegExp(`(?:through|thru|until|till|ends?)\\s+(?:the end of\\s+)?${MON}\\b(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s*(\\d{4}))?`, 'gi');
  while ((m = r4.exec(t))) {
    const y = yr(m[3], refYear), mi = mIdx(m[1]);
    out.push({ start: null, end: iso(y, mi, m[2] ? +m[2] : lastDay(y, mi)), raw: m[0] });
  }
  // on 11/11 / on November 11
  const r5 = new RegExp(`\\bon\\s+(?:${NUM}|${MON}\\s+(\\d{1,2}))`, 'gi');
  while ((m = r5.exec(t))) {
    const d = m[1] ? iso(yr(m[3], refYear), +m[1] - 1, +m[2]) : iso(refYear, mIdx(m[4]), +m[5]);
    if (d) out.push({ start: d, end: d, raw: m[0] });
  }
  // starting 11/1 / starts November 1
  const r6 = new RegExp(`(?:start(?:s|ing)?|begin(?:s|ning)?|from|beginning)\\s+(?:${NUM}|${MON}\\s+(\\d{1,2}))`, 'gi');
  while ((m = r6.exec(t))) {
    const d = m[1] ? iso(yr(m[3], refYear), +m[1] - 1, +m[2]) : iso(refYear, mIdx(m[4]), +m[5]);
    if (d && !out.some((o) => o.start === d)) out.push({ start: d, end: null, raw: m[0] });
  }
  return out.filter((o) => o.start || o.end);
}

const CAMPAIGN_TOKEN = /\b(q[1-4][-_ ]?(?:fy)?[-_ ]?\d{2,4}|fy[-_ ]?\d{2,4}|f\d{2}(?=[-_])|h[12][-_]?\d{2,4}|20\d{2}|holiday|summer|spring|fall|autumn|winter|black[-_ ]?friday|cyber|bfcm|nye|new[-_ ]?year|valentine|mothers?[-_ ]?day|fathers?[-_ ]?day|grads?|back[-_ ]?to[-_ ]?school|halloween|thanksgiving|lto|promo|campaign|phase[-_ ]?\d|launch|deals?|specials?|offers?|veteran|kbf|seasonal)\b/gi;
const FISCAL = /\b(q[1-4][-_ ]?(?:fy)?[-_ ]?\d{2,4}|fy[-_ ]?\d{2,4}|f\d{2}(?=[-_]))\b/i;

function cleanName(p) {
  const raw = p.h1?.[0] || p.ogTitle || p.title || p.url;
  return String(raw).split(/\s+[|–—-]\s+/)[0].trim().slice(0, 80);
}

const PRICE = /(?:US\$|C\$|A\$|[$£€¥₹])\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?(?!\d)(?:\s?\/\s?(?:mo|month|yr|year|night|person|user|seat))?|\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s?(?:€|EUR|GBP|USD)\b/g;
function shingles(text, drop = []) {
  let words = String(text || '').toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').split(' ').filter(Boolean);
  if (drop.length) words = words.filter((w) => !drop.includes(w));
  words = words.slice(0, 400);
  const set = new Set();
  for (let i = 0; i + 4 < words.length; i++) set.add(words.slice(i, i + 5).join(' '));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
// Words that name the store / city / branch in a page (from its URL and title), dropped before comparing text
function variantWords(p) {
  const fromUrl = (() => { try { return new URL(p.url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } })();
  return [...new Set((fromUrl + ' ' + (p.h1?.[0] || '') + ' ' + (p.title || '')).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
}
function variantOf(o) { try { return new URL(o.url).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } }

export function analyzePromos(scan, today = new Date()) {
  if (!scan) return null;
  const todayIso = today.toISOString().slice(0, 10);
  const refYear = today.getFullYear();
  const offers = [];
  for (const p of scan.pages || []) {
    if (!p.text && !p.redirectedTo) continue;
    const body = [p.description, ...(p.h2 || []), p.text].filter(Boolean).join(' . ');
    const dates = parseDates(body, refYear);
    const priceList = (t) => [...new Set((String(t || '').match(PRICE) || []).map((x) => x.replace(/\s+/g, ' ').trim()))];
    // Headline prices come from the title, headings and description; the rest of the page is fine print
    const headlinePrices = priceList([p.title, p.ogTitle, p.description, ...(p.h1 || []), ...(p.h2 || [])].join(' . ')).slice(0, 6);
    const prices = headlinePrices.length ? headlinePrices : priceList(body).slice(0, 6);
    const pct = [...new Set((body.match(/\d{1,2}\s?%\s*off|save\s+(?:up\s+to\s+)?\d{1,2}\s?%/gi) || []))].slice(0, 4);
    const free = /\bfree\b/i.test(body);
    const starts = dates.map((d) => d.start).filter(Boolean).sort();
    const ends = dates.map((d) => d.end).filter(Boolean).sort();
    const start = starts[0] || null;
    const end = ends[ends.length - 1] || null;
    let status = 'ongoing / no dates';
    if (p.redirectedTo) status = 'expired (page redirects)';
    else if (end && end < todayIso) status = 'expired';
    else if (start && start > todayIso) status = 'upcoming';
    else if (start || end) status = 'active';
    const restrict = (body.match(/[^.]{0,60}\b(except|excludes?|exclusions|not valid|cannot be combined|only on|mon(?:day)?s?-fri|weekdays?|after \d{1,2}\s?(?:am|pm)|before \d{1,2}\s?(?:am|pm)|participating|new (?:customers|members|subscribers) only|first[- ]time|minimum (?:purchase|spend|order)|min\.? (?:spend|order)|while supplies last|limit (?:one|\d)|one per|in-store only|online only|subject to (?:credit )?approval|terms (?:and conditions )?apply|eligible)[^.]{0,80}/i) || [])[0];
    offers.push({
      name: cleanName(p), url: p.url, lastmod: p.lastmod || null, status,
      start, end, dateText: dates.map((d) => d.raw).slice(0, 4),
      prices, percentOff: pct, free,
      summary: (p.description || p.h2?.[0] || p.text || '').slice(0, 200),
      restriction: restrict ? restrict.trim().slice(0, 160) : null,
      redirectedTo: p.redirectedTo || null,
      copies: p.copies > 1 ? p.copies : null,
      variants: p.variants?.length > 1 ? p.variants : null,
      _sig: shingles(body, variantWords(p)),
      _names: [cleanName(p)],
      _entities: p.variants?.length > 1 ? p.variants : [],
    });
  }
  // Pages with near-identical text are one offer (e.g. the same deal on each store's page)
  const merged = [];
  for (const o of offers) {
    const parent = (x) => { try { return new URL(x.url).pathname.replace(/[^/]+\/?$/, ''); } catch { return ''; } };
    // Same text, or same folder and largely the same text (per-store pages with local tweaks)
    // ...and the names must be the same apart from one place word ("Oakbrook Promotions" / "Miami Promotions"),
    // so different collections that happen to show the same products stay apart
    const words = (n) => String(n || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const sameName = (x, y) => { const A = words(x), B = new Set(words(y)); const common = A.filter((w) => B.has(w)).length; return common && common * 2 >= A.length && common * 2 >= B.size; };
    const same = merged.find((m) => m.status === o.status && sameName(m._names[0], o._names[0]) && (jaccard(m._sig, o._sig) >= 0.6 || (parent(m) === parent(o) && parent(o).length > 1 && jaccard(m._sig, o._sig) >= 0.3)));
    if (!same) { merged.push(o); continue; }
    same.copies = (same.copies || 1) + (o.copies || 1);
    same._names.push(...o._names);
    same._entities.push(...o._entities);
    same.variants = [...new Set([...(same.variants || [variantOf(same)]), ...(o.variants || [variantOf(o)])])].filter(Boolean);
    same.prices = [...new Set([...same.prices, ...o.prices])].slice(0, 6);
    if (String(o.lastmod || '') > String(same.lastmod || '')) same.lastmod = o.lastmod;
  }
  offers.length = 0;
  for (const o of merged) {
    delete o._sig;
    if (o.variants && o.variants.length < 2) o.variants = null;
    // A grouped offer is named by what its pages share ("Oakbrook Promotions" + "Miami Promotions" → "Promotions")
    const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
    let generic = o.name;
    if (o._names.length > 1) {
      const sets = o._names.map((n) => new Set(n.split(/\s+/).map(norm)));
      generic = o.name.split(/\s+/).filter((w) => sets.every((st) => st.has(norm(w)))).join(' ');
    }
    generic = generic.replace(/^[-–|:,\s]+|[-–|:,\s]+$/g, '');
    if (generic.length >= 3 && (generic.split(/\s+/).length >= 2 || o.name.split(/\s+/).length <= 2)) o.name = generic;
    // Stable key for comparing pulls: the page's path, or its folder for an offer copied across pages
    try { const pn = new URL(o.url).pathname; o.key = o.copies > 1 ? pn.replace(/[^/]+\/?$/, '*') : pn; } catch { o.key = o.name; }
    delete o._names; delete o._entities;
    offers.push(o);
  }
  // Prices on most pages are site-wide boilerplate (a free-shipping threshold, a membership fee), not offers
  let sitewidePrices = [];
  if (offers.length >= 5) {
    const freq = {};
    for (const o of offers) for (const pr of new Set(o.prices)) freq[pr] = (freq[pr] || 0) + 1;
    sitewidePrices = Object.entries(freq).filter(([, n]) => n / offers.length >= 0.6).map(([pr]) => pr);
    for (const o of offers) o.prices = o.prices.filter((pr) => !sitewidePrices.includes(pr));
  }
  const order = { active: 0, upcoming: 1, 'ongoing / no dates': 2, expired: 3, 'expired (page redirects)': 4 };
  offers.sort((a, b) => order[a.status] - order[b.status] || String(a.end || '9').localeCompare(String(b.end || '9')));

  // Campaign asset folders: group asset paths by folder; keep folders with campaign / fiscal tokens
  const folders = new Map();
  const addAssets = (assets, pageUrl) => {
    for (const a of assets || []) {
      const parts = a.split('/');
      const file = parts.pop();
      const folder = parts.join('/') || '/';
      const tokens = [...new Set([...(folder + '/' + file).matchAll(CAMPAIGN_TOKEN)].map((m) => m[1].toLowerCase()))];
      if (!tokens.length) continue;
      if (!folders.has(folder)) folders.set(folder, { folder, files: new Set(), pages: new Set(), tokens: new Set() });
      const f = folders.get(folder);
      f.files.add(file);
      if (pageUrl) f.pages.add(pageUrl);
      tokens.forEach((t) => f.tokens.add(t));
    }
  };
  for (const p of scan.pages || []) addAssets(p.assets, p.url);
  addAssets(scan.currentPage?.assets, scan.currentPage?.url);
  const campaignFolders = [...folders.values()]
    .map((f) => ({ folder: f.folder, tokens: [...f.tokens], fiscal: (f.folder.match(FISCAL) || [])[1] || null, files: [...f.files].slice(0, 12), fileCount: f.files.size, pages: [...f.pages].slice(0, 5) }))
    .sort((a, b) => (b.fiscal ? 1 : 0) - (a.fiscal ? 1 : 0) || b.fileCount - a.fileCount)
    .slice(0, 40);
  const fiscalPeriods = [...new Set(campaignFolders.map((f) => f.fiscal).filter(Boolean).map((s) => s.toLowerCase()))].sort();
  const phases = [...new Set(campaignFolders.flatMap((f) => f.files.join(' ').match(/phase[-_ ]?\d+/gi) || []))];

  // robots.txt paths that hint at hidden campaign / landing content
  const hiddenHints = (scan.robots?.disallow || []).filter((d) => /lp|landing|promo|campaign|offer|special|test|preview|staging|draft|beta/i.test(d)).slice(0, 20);

  return {
    scannedAt: scan.scannedAt,
    sitemapUrlCount: scan.sitemapUrlCount,
    candidates: scan.uniqueOffers ?? scan.candidates,
    candidatePages: scan.candidates,
    pagesRead: (scan.pages || []).length,
    offers,
    sitewidePrices,
    campaignFolders,
    fiscalPeriods,
    phases,
    hiddenHints,
    recent: scan.recent || [],
  };
}

export function promosCsv(a) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Offer', 'Status', 'Start', 'End', 'Prices', '% off', 'Restriction', 'Summary', 'URL', 'Sitemap lastmod']];
  for (const o of a.offers) rows.push([o.name, o.status, o.start, o.end, o.prices.join(' '), o.percentOff.join(' '), o.restriction, o.summary, o.url, o.lastmod]);
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}
