// Injected into the page (MAIN world). Must be fully self-contained.
// Reads robots.txt and the sitemap, picks promo / campaign pages, and fetches a sample of them.
// Polite by design: same-origin GETs only, a capped number of pages, 3 at a time.

export async function scanPromos(opts = {}) {
  const maxPages = opts.maxPages || 25;
  const maxSitemaps = opts.maxSitemaps || 10;
  const origin = location.origin;
  // Offer / campaign words across industries (retail, travel, SaaS, finance, auto, venues, food, services)
  const PROMO = /\bspecials?\b|\bdeals?\b|promo|\boffers?\b|discount|\bsales?\b|sales-?event|clearance|\boutlet\b|coupon|voucher|rebate|cash-?back|holiday|black-?friday|cyber|bfcm|prime-?day|\blto\b|limited|bogo|\bfree\b|\btrials?\b|pricing|\bplans?\b|subscri|membership|rewards?|loyalty|\brefer|bundle|\bcombos?\b|packages?\b|unlimited|\bgifts?\b|gift-?cards?|campaign|\/lp\/|landing|seasonal|\bsummer\b|\bwinter\b|\bspring\b|\bfall\b|valentine|halloween|thanksgiving|christmas|xmas|new-?year|\bnye\b|easter|ramadan|diwali|lunar-?new-?year|mothers?-?day|fathers?-?day|graduat|\bgrads?\b|back-?to-?school|tax-?(season|day)|military|veteran|student|teacher|\bnurses?\b|first-?responder|\bseniors?\b|financing|\d+-?apr\b|\blease\b|incentive|trade-?in|happy-?hour|kids-?(eat|stay|fly|free)|season-?pass|\bpass(es)?\b|\bsave\b|savings|percent-?off|\d+-?off\b|anniversary|early-?bird|pre-?order|presale|\bflash\b|doorbuster|exclusive/i;
  const SKIP = /\/(blog|stories|news|press|newsroom|careers|jobs|faq|help|support|docs?|documentation|developers?|api|investors?|ir|privacy|terms|legal|accessibility|sitemap|account|login|sign-?in|register|cart|checkout|wishlist|search|s|order-status|reviews?|recipes?|articles?|tags?|authors?)\/|\/(search|s)$|\+|%20|\.(pdf|jpe?g|png|webp|xml)$/i;
  // Sitemaps of search keywords, products, stores, brands, media or articles rarely hold offer pages
  const LOW_SITEMAP = /keyword|search|pdp|product|item|sku|stores?|location|brand|image|video|review|recipe|blog|article|post|author|tag|news/i;

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
    const rank = (u) => (PROMO.test(u) || /page|landing|categor|collection|campaign/.test(u) ? 2 : 0) - (LOW_SITEMAP.test(u.split('/').pop()) ? 1 : 0);
    queue.sort((a, b) => rank(b) - rank(a));
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

  // ---- entity slugs: a path segment that also appears under another parent folder and isn't an offer word
  // (e.g. "philadelphia" in /locations/philadelphia/ and /promotions/philadelphia/; a store, city, branch,
  // dealer or product line). Pages that differ only by an entity slug are copies of one offer.
  const parentsOf = new Map();
  for (const u of urls.keys()) {
    let segs;
    try { segs = new URL(u).pathname.split('/').filter(Boolean); } catch { continue; }
    segs.forEach((seg, i) => {
      const k = seg.toLowerCase();
      if (!parentsOf.has(k)) parentsOf.set(k, new Set());
      if (parentsOf.get(k).size < 4) parentsOf.get(k).add(segs.slice(0, i).join('/'));
    });
  }
  // An entity also lives under a non-offer folder (/locations/x, /stores/x, /dealers/x, /products/x)
  const isEntity = (seg) => {
    const parents = parentsOf.get(seg.toLowerCase());
    // A folder named for an offer itself (/pricing, /deals, /promotions) is never a store or city
    if (/^(pricing|prices|plans?|promos?|promotions?|offers?|deals?|specials?|sales?|discounts?|coupons?|clearance|outlet|rewards|loyalty|membership|gift-?cards?|trial|free-trial)$/i.test(seg)) return false;
    return !!parents && parents.size >= 2 && !/^\d+$/.test(seg) && [...parents].some((par) => par && !PROMO.test(par));
  };
  const offerKey = (pathname) => pathname.split('/').filter(Boolean).map((seg) => (isEntity(seg) || /^locations?$/i.test(seg) ? '*' : seg)).join('/').replace(/(^|\/)\*(\/\*)+/g, '$1*');
  const variantOf = (pathname) => pathname.split('/').filter(Boolean).filter((seg) => isEntity(seg)).join('/');
  const promoPath = (pathname) => PROMO.test(pathname.split('/').filter((seg) => !isEntity(seg)).join('/'));

  // ---- candidate promo pages: sitemap + links on the current page ----
  const cands = new Map();
  for (const [u, lm] of urls) {
    let p;
    try { p = new URL(u); } catch { continue; }
    if (p.origin !== origin && p.hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, '')) continue;
    if (promoPath(p.pathname) && !SKIP.test(p.pathname)) cands.set(p.origin + p.pathname, { lastmod: lm, from: 'sitemap' });
  }
  for (const a of document.querySelectorAll('a[href]')) {
    let p;
    try { p = new URL(a.getAttribute('href'), location.href); } catch { continue; }
    if (p.origin !== origin || SKIP.test(p.pathname)) continue;
    const label = (a.textContent || '').trim().slice(0, 80);
    if (promoPath(p.pathname) || (!variantOf(p.pathname) && PROMO.test(label))) {
      const k = p.origin + p.pathname;
      if (!cands.has(k)) cands.set(k, { lastmod: urls.get(k) || null, from: 'page link', label });
    }
  }
  // Copies of one offer per store / city / branch / product line count once, with the variants listed
  const byOffer = new Map();
  for (const [u, info] of cands) {
    let key = u, variant = '';
    try { const pn = new URL(u).pathname; key = offerKey(pn) || u; variant = variantOf(pn); } catch {}
    const prev = byOffer.get(key);
    if (!prev) byOffer.set(key, [u, { ...info, copies: 1, variants: variant ? [variant] : [] }]);
    else {
      const meta = prev[1];
      const variants = variant && meta.variants.length < 60 ? [...meta.variants, variant] : meta.variants;
      if (String(info.lastmod || '') > String(meta.lastmod || '')) byOffer.set(key, [u, { ...info, copies: meta.copies + 1, variants }]);
      else { meta.copies++; meta.variants = variants; }
    }
  }
  // Rank pages that are clearly about offers or prices ahead of pages that only share a word with them
  // (a SaaS "sales pipeline" feature page, a "campaign management" template), then by sitemap date
  const STRONG = /pricing|\bplans?\b|promo|\boffers?\b|discount|coupon|\bspecials?\b|\bdeals?\b|black-?friday|cyber|bfcm|clearance|\btrials?\b|\bfree\b|\bsales?\b$|\/sale|rebate|financing|\d+-?off\b|percent-?off|bogo|\bsave\b|savings|membership|rewards|loyalty|\brefer/i;
  const strength = (u) => {
    let path = '';
    try { path = new URL(u).pathname.toLowerCase(); } catch {}
    const segs = path.split('/').filter(Boolean);
    let sc = 0;
    if (STRONG.test(path)) sc += 3;
    if (segs.some((seg) => /^(pricing|plans?|promos?|promotions?|offers?|deals?|specials?|sales?|discounts?|coupons?|clearance|outlet|trial|free-trial|black-friday|cyber-monday|rewards|membership)$/.test(seg))) sc += 3;
    if (segs.length <= 2) sc += 1;
    if (/template|use-case|customer|stor(y|ies)|agent|integration|feature|solution|partner|webinar|event|guide|course|academy/.test(path)) sc -= 5;
    return sc;
  };
  const picked = [...byOffer.values()]
    .sort((a, b) => strength(b[0]) - strength(a[0]) || String(b[1].lastmod || '').localeCompare(String(a[1].lastmod || '')))
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
