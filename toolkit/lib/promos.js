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

export function analyzePromos(scan, today = new Date()) {
  if (!scan) return null;
  const todayIso = today.toISOString().slice(0, 10);
  const refYear = today.getFullYear();
  const offers = [];
  for (const p of scan.pages || []) {
    if (!p.text && !p.redirectedTo) continue;
    const body = [p.description, ...(p.h2 || []), p.text].filter(Boolean).join(' . ');
    const dates = parseDates(body, refYear);
    const prices = [...new Set((body.match(/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?!\d)/g) || []).map((s) => s.replace(/\s/g, '')))].slice(0, 8);
    const pct = [...new Set((body.match(/\d{1,2}%\s*off/gi) || []))].slice(0, 4);
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
    const restrict = (body.match(/[^.]{0,60}\b(except|excludes?|not valid|only on|mon(?:day)?s?-fri|weekdays?|after \d{1,2}\s?(?:am|pm)|before \d{1,2}\s?(?:am|pm)|participating locations)[^.]{0,80}/i) || [])[0];
    offers.push({
      name: cleanName(p), url: p.url, lastmod: p.lastmod || null, status,
      start, end, dateText: dates.map((d) => d.raw).slice(0, 4),
      prices, percentOff: pct, free,
      summary: (p.description || p.h2?.[0] || p.text || '').slice(0, 200),
      restriction: restrict ? restrict.trim().slice(0, 160) : null,
      redirectedTo: p.redirectedTo || null,
      locationCopies: p.copies > 1 ? p.copies : null,
    });
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
