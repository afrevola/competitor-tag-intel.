// Injected into the page (MAIN world). Must be fully self-contained.
// Reads robots.txt and the sitemap, picks promo / campaign pages, and fetches a sample of them.
// Polite by design: same-origin GETs only, a capped number of pages, 3 at a time.

export async function scanPromos(opts = {}) {
  const maxPages = opts.maxPages || 25;
  const maxSitemaps = opts.maxSitemaps || 10;
  const origin = location.origin;
  const PROMO = /special|deal|promo|offer|discount|sale\b|coupon|holiday|black-?friday|cyber|\blto\b|limited|happy-?hour|kids-?(eat|bowl|play)|season-?pass|\bpass(es)?\b|gift-?card|bogo|free|campaign|\/lp\/|landing|seasonal|summer|winter|spring|\bfall\b|valentine|halloween|thanksgiving|new-?year|nye|mothers?-?day|fathers?-?day|moms|dads|grads?\b|back-?to-?school|military|veteran|student|membership|rewards?|loyalty|bundle|combo|unlimited|all-?you-?can/i;
  const SKIP = /\/(blog|stories|news|press|careers|jobs|faq|help|privacy|terms|legal|accessibility|sitemap)\b|\.(pdf|jpg|png|xml)$/i;

  const get = async (u, ms = 9000) => {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), ms);
      const r = await fetch(u, { signal: c.signal, credentials: 'omit', redirect: 'follow' });
      clearTimeout(t);
      return { ok: r.ok, status: r.status, url: r.url, text: r.ok ? await r.text() : '' };
    } catch (e) {
      // Some sites wrap fetch; fall back to XHR
      return await new Promise((res) => {
        try {
          const x = new XMLHttpRequest();
          x.open('GET', u);
          x.timeout = ms;
          x.onload = () => res({ ok: x.status >= 200 && x.status < 300, status: x.status, url: x.responseURL || u, text: x.status < 300 ? x.responseText : '' });
          x.onerror = x.ontimeout = () => res({ ok: false, status: 0, url: u, text: '' });
          x.send();
        } catch { res({ ok: false, status: 0, url: u, text: '' }); }
      });
    }
  };

  // ---- robots + sitemaps ----
  const robots = (await get(origin + '/robots.txt')).text || '';
  let maps = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!maps.length) maps = [origin + '/sitemap.xml'];
  const disallow = [...robots.matchAll(/^\s*disallow:\s*(\S+)/gim)].map((m) => m[1]);
  const urls = new Map();
  const queue = [...maps];
  const seenMaps = new Set();
  let fetched = 0;
  while (queue.length && fetched < maxSitemaps) {
    queue.sort((a, b) => (PROMO.test(b) || /page|landing/.test(b)) - (PROMO.test(a) || /page|landing/.test(a)));
    const sm = queue.shift();
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    fetched++;
    const x = (await get(sm)).text;
    if (!x) continue;
    if (/<sitemapindex/i.test(x)) {
      for (const m of x.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\s\]]+)/g)) queue.push(m[1].replace(/&amp;/g, '&'));
      continue;
    }
    for (const m of x.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = (m[1].match(/<loc>\s*(?:<!\[CDATA\[)?([^<\s\]]+)/) || [])[1];
      if (!loc) continue;
      const lm = (m[1].match(/<lastmod>\s*([^<\s]+)/) || [])[1] || null;
      if (urls.size < 30000) urls.set(loc.replace(/&amp;/g, '&'), lm);
    }
  }

  // ---- candidate promo pages: sitemap + links on the current page ----
  const cands = new Map();
  for (const [u, lm] of urls) {
    let p;
    try { p = new URL(u); } catch { continue; }
    if (p.origin !== origin && p.hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, '')) continue;
    if (PROMO.test(p.pathname.replace(/\/locations?\/[^/]+/, '')) && !SKIP.test(p.pathname)) cands.set(p.origin + p.pathname, { lastmod: lm, from: 'sitemap' });
  }
  for (const a of document.querySelectorAll('a[href]')) {
    let p;
    try { p = new URL(a.getAttribute('href'), location.href); } catch { continue; }
    if (p.origin !== origin || SKIP.test(p.pathname)) continue;
    const label = (a.textContent || '').trim().slice(0, 80);
    if (PROMO.test(p.pathname.replace(/\/locations?\/[^/]+/, '')) || (!/\/locations?\//.test(p.pathname) && PROMO.test(label))) {
      const k = p.origin + p.pathname;
      if (!cands.has(k)) cands.set(k, { lastmod: urls.get(k) || null, from: 'page link', label });
    }
  }
  // Per-location copies of the same offer (/location/x/summer-pass, /location/y/summer-pass) count once
  const byOffer = new Map();
  for (const [u, info] of cands) {
    let key = u;
    try { key = new URL(u).pathname.replace(/\/locations?\/[^/]+/, '').replace(/\/$/, '') || u; } catch {}
    const prev = byOffer.get(key);
    if (!prev) byOffer.set(key, [u, { ...info, copies: 1 }]);
    else {
      prev[1].copies++;
      if (String(info.lastmod || '') > String(prev[1].lastmod || '')) byOffer.set(key, [u, { ...info, copies: prev[1].copies }]);
    }
  }
  const picked = [...byOffer.values()]
    .sort((a, b) => String(b[1].lastmod || '').localeCompare(String(a[1].lastmod || '')))
    .slice(0, maxPages);

  // ---- fetch and read each promo page ----
  const ASSET = /(?:src|href|srcset|data-src|data-srcset|poster|content)=["']([^"']+?\.(?:png|jpe?g|webp|gif|svg|mp4|webm|pdf))/gi;
  const assetsOf = (html) => {
    const out = new Set();
    for (const m of html.matchAll(ASSET)) {
      for (const part of m[1].split(',')) {
        const s = part.trim().split(/\s+/)[0];
        try { out.add(decodeURIComponent(new URL(s, origin).pathname)); } catch {}
      }
    }
    for (const m of html.matchAll(/url\(["']?([^"')]+?\.(?:png|jpe?g|webp|gif|svg))/gi)) {
      try { out.add(decodeURIComponent(new URL(m[1], origin).pathname)); } catch {}
    }
    return [...out].slice(0, 200);
  };
  const readPage = (html, finalUrl) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = (sel) => doc.querySelector(sel)?.getAttribute('content') || '';
    doc.querySelectorAll('script,style,noscript,header,footer,nav,[role=dialog],[aria-modal=true],.modal,iframe,svg').forEach((n) => n.remove());
    const main = doc.querySelector('main') || doc.body;
    const text = (main?.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      finalUrl,
      title: (doc.title || '').trim(),
      ogTitle: meta('meta[property="og:title"]'),
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      h1: [...doc.querySelectorAll('h1')].map((h) => h.textContent.trim()).filter(Boolean).slice(0, 3),
      h2: [...doc.querySelectorAll('h2,h3')].map((h) => h.textContent.trim()).filter(Boolean).slice(0, 10),
      text: text.slice(0, 6000),
    };
  };

  const pages = [];
  let i = 0;
  const worker = async () => {
    while (i < picked.length) {
      const [u, info] = picked[i++];
      const r = await get(u);
      if (!r.text) { pages.push({ url: u, ...info, status: r.status }); continue; }
      const finalPath = (() => { try { return new URL(r.url).pathname; } catch { return ''; } })();
      const redirected = finalPath && finalPath.replace(/\/$/, '') !== new URL(u).pathname.replace(/\/$/, '');
      pages.push({ url: u, ...info, status: r.status, redirectedTo: redirected ? r.url : null, ...readPage(r.text, r.url), assets: assetsOf(r.text) });
      await new Promise((res) => setTimeout(res, 150));
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  const recent = [...urls.entries()].filter(([, lm]) => lm).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 25).map(([url, lastmod]) => ({ url, lastmod }));

  return {
    origin,
    scannedAt: new Date().toISOString(),
    robots: { sitemaps: maps, disallow: disallow.slice(0, 200) },
    sitemapUrlCount: urls.size,
    sitemapsRead: fetched,
    candidates: cands.size,
    uniqueOffers: byOffer.size,
    recent,
    pages,
    currentPage: { url: location.href, assets: assetsOf(document.documentElement.outerHTML) },
  };
}
