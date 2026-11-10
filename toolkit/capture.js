// Paste this whole file into the browser's JavaScript tool on the page to analyze.
// It returns part 0 of a gzip+base64 package (the tool saves it to a file). If it says parts=N>1, run __tiPart(1) ... __tiPart(N-1).
// Then: node intel.js extract <file0> [file1 ...] -o capture.json
await (async () => {
  const OPTS = Object.assign({ promos: true, maxPromoPages: 20, wait: 2500 }, window.__TI_OPTS || {});
  const collectPage = (async function collectPage() {
  const stack = new Set();
  const safe = (v, d = 0) => {
    const t = typeof v;
    if (t === 'function') return '[function]';
    if (t === 'bigint' || t === 'symbol') return String(v);
    if (v === null || t !== 'object') return v;
    if (v === window || v === document) return '[window]';
    if (typeof Node !== 'undefined' && v instanceof Node) {
      if (v.nodeType !== 1) return '[node]';
      let s = '<' + v.tagName.toLowerCase();
      if (v.id) s += '#' + v.id;
      if (typeof v.className === 'string' && v.className.trim()) s += '.' + v.className.trim().split(/\s+/).slice(0, 3).join('.');
      return s + '>';
    }
    if (stack.has(v)) return '[circular]';
    if (d > 7) return '[…]';
    stack.add(v);
    let out;
    try {
      if (Object.prototype.toString.call(v) === '[object Arguments]') {
        out = { gtag: Array.from(v).map((x) => safe(x, d + 1)) };
      } else if (Array.isArray(v)) {
        out = v.slice(0, d === 0 ? 2000 : 300).map((x) => safe(x, d + 1));
      } else {
        out = {};
        let n = 0;
        for (const k of Object.keys(v)) {
          if (n++ > 150) { out['…'] = 'truncated'; break; }
          try { out[k] = safe(v[k], d + 1); } catch { out[k] = '[unreadable]'; }
        }
      }
    } finally {
      stack.delete(v);
    }
    return out;
  };

  // ---- Tag containers ----
  const found = new Map();
  const dlNames = new Set(['dataLayer']);
  const add = (id, src) => {
    if (!id) return;
    id = id.toUpperCase();
    if (!found.has(id) || (src && !found.get(id))) found.set(id, src || found.get(id) || null);
  };
  const check = (u) => {
    if (!u) return;
    let url;
    try { url = new URL(u, location.href); } catch { return; }
    const id = url.searchParams.get('id');
    if (!id || !/^(GTM|G|AW|DC)-[A-Za-z0-9]+$/i.test(id)) return;
    const isLoader = /gtm\.js|gtag\/js/.test(url.pathname) || !/googletagmanager\.com$/.test(url.hostname);
    const isNs = /ns\.html/.test(url.pathname);
    if (!isLoader && !isNs) return;
    const l = url.searchParams.get('l');
    if (l) dlNames.add(l);
    add(id, isNs ? null : url.href);
  };
  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean);
  scripts.forEach(check);
  document.querySelectorAll('iframe[src]').forEach((el) => check(el.src));
  document.querySelectorAll('noscript').forEach((n) => (n.textContent.match(/https?:[^"'\s]+ns\.html\?id=[^"'\s]+/g) || []).forEach(check));
  let resources = [];
  try { resources = performance.getEntriesByType('resource').map((e) => e.name); } catch {}
  resources.forEach((u) => { if (/[?&]id=(GTM|G|AW|DC)-/i.test(u) && /gtm\.js|gtag\/js|googletagmanager/.test(u)) check(u); });
  try {
    if (window.google_tag_manager) Object.keys(window.google_tag_manager).forEach((k) => { if (/^(GTM|G|AW|DC)-/.test(k)) add(k, null); });
  } catch {}

  // ---- Data layers ----
  const dataLayers = [];
  for (const n of dlNames) if (Array.isArray(window[n])) dataLayers.push({ name: n, kind: 'array', entries: safe(window[n]) });
  if (Array.isArray(window.adobeDataLayer)) {
    dataLayers.push({ name: 'adobeDataLayer', kind: 'array', entries: safe(window.adobeDataLayer) });
    try {
      if (typeof window.adobeDataLayer.getState === 'function') {
        dataLayers.push({ name: 'adobeDataLayer (current state)', kind: 'object', snapshot: safe(window.adobeDataLayer.getState()) });
      }
    } catch {}
  }
  for (const n of ['digitalData', 'utag_data']) {
    if (window[n] && typeof window[n] === 'object' && !Array.isArray(window[n])) dataLayers.push({ name: n, kind: 'object', snapshot: safe(window[n]) });
  }

  // ---- Adobe Launch ----
  let launch = null;
  const sat = window._satellite;
  const c = sat && sat._container;
  if (c) {
    const comp = (x) => {
      const mp = x.modulePath || '';
      const st = Object.assign({}, x.settings || {});
      let code = null, external = null;
      if (typeof st.source === 'function') code = String(st.source);
      else if (typeof st.source === 'string') { if (st.isExternal) external = st.source; else code = st.source; }
      delete st.source;
      return { ext: mp.split('/')[0], type: mp.split('/').pop().replace(/\.js$/, ''), negate: !!x.negate, settings: safe(st), code, external };
    };
    const rules = (c.rules || []).map((r) => ({
      name: r.name, id: r.id,
      events: (r.events || []).map(comp),
      conditions: (r.conditions || []).map(comp),
      actions: (r.actions || []).map(comp),
    }));
    const dataElements = Object.entries(c.dataElements || {}).map(([name, de]) => ({
      name, ...comp(de), defaultValue: de.defaultValue, storageDuration: de.storageDuration,
    }));
    // Fetch externally hosted custom code so its vendors can be identified
    const ext = [];
    rules.forEach((r) => [...r.events, ...r.conditions, ...r.actions].forEach((a) => { if (a.external && !a.code) ext.push(a); }));
    await Promise.all(ext.slice(0, 400).map(async (a) => {
      try {
        const res = await fetch(new URL(a.external, location.href).href);
        if (res.ok) a.code = (await res.text()).slice(0, 30000);
      } catch {}
    }));
    launch = {
      property: sat.property && sat.property.name,
      environment: sat.environment && sat.environment.stage,
      buildInfo: safe(sat.buildInfo),
      libSrc: scripts.find((u) => /adobedtm\.com|\/launch-[^/]+\.js|satelliteLib/.test(u)) || null,
      extensions: Object.entries(c.extensions || {}).map(([id, v]) => ({ id, name: v.displayName || id, settings: safe(v.settings) })),
      dataElements,
      rules,
    };
  }

  // ---- Network / cookie evidence (for server-side detection) ----
  const cookies = document.cookie.split(';').map((s) => s.split('=')[0].trim()).filter(Boolean);

  // ---- Resource timing (for the third-party cost view) ----
  let resTiming = [];
  let timing = null;
  try {
    resTiming = performance.getEntriesByType('resource').slice(0, 2500).map((e) => ({
      u: e.name.slice(0, 600), type: e.initiatorType, transfer: e.transferSize || 0, encoded: e.encodedBodySize || 0,
      decoded: e.decodedBodySize || 0, dur: Math.round(e.duration), start: Math.round(e.startTime),
    }));
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) timing = {
      ttfb: Math.round(nav.responseStart), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd),
      docTransfer: nav.transferSize || 0, docEncoded: nav.encodedBodySize || 0, now: Math.round(performance.now()),
    };
  } catch {}

  return {
    url: location.href,
    host: location.hostname,
    containers: [...found].map(([id, src]) => ({ id, src })),
    dataLayers,
    launch,
    network: { urls: resources.map((u) => u.slice(0, 1000)), scripts, cookies, resources: resTiming, timing },
  };
});
  const scanPromos = (async function scanPromos(opts = {}) {
  const maxPages = opts.maxPages || 25;
  const maxSitemaps = opts.maxSitemaps || 10;
  const origin = location.origin;
  // Offer / campaign words across industries (retail, travel, SaaS, finance, auto, venues, food, services)
  const PROMO = /special|deal|promo|offer|discount|sale\b|sales-?event|clearance|outlet|coupon|voucher|rebate|cash-?back|holiday|black-?friday|cyber|bfcm|prime-?day|\blto\b|limited|bogo|free|trial|pricing|\bplans?\b|subscri|membership|rewards?|loyalty|refer|bundle|combo|package|unlimited|gift|campaign|\/lp\/|landing|seasonal|summer|winter|spring|\bfall\b|valentine|halloween|thanksgiving|christmas|xmas|new-?year|nye|easter|ramadan|diwali|lunar-?new-?year|mothers?-?day|fathers?-?day|graduat|grads?\b|back-?to-?school|tax-?(season|day)|military|veteran|student|teacher|nurse|first-?responder|senior|financing|\d+-?apr\b|lease|incentive|trade-?in|happy-?hour|kids-?(eat|stay|fly|free)|season-?pass|\bpass(es)?\b|\bsave\b|savings|percent-?off|\d+-?off\b|anniversary|early-?bird|pre-?order|presale|flash|doorbuster|exclusive/i;
  const SKIP = /\/(blog|stories|news|press|newsroom|careers|jobs|faq|help|support|docs?|documentation|developers?|api|investors?|ir|privacy|terms|legal|accessibility|sitemap|account|login|sign-?in|register|cart|checkout|wishlist|search|order-status)\b|\.(pdf|jpe?g|png|webp|xml)$/i;

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
});
  const getText = async (url) => {
    try { const r = await fetch(url, { credentials: 'omit' }); return r.ok ? await r.text() : null; }
    catch { return await new Promise((res) => { try { const x = new XMLHttpRequest(); x.open('GET', url); x.onload = () => res(x.status < 300 ? x.responseText : null); x.onerror = () => res(null); x.send(); } catch { res(null); } }); }
  };
  await new Promise((r) => setTimeout(r, OPTS.wait));
  const page = await collectPage();
  const containers = {};
  for (const c of page.containers.filter((c) => /^GTM-/.test(c.id))) containers[c.id] = await getText(c.src || 'https://www.googletagmanager.com/gtm.js?id=' + c.id);
  let promos = null;
  if (OPTS.promos) { try { promos = await scanPromos({ maxPages: OPTS.maxPromoPages }); } catch (e) { promos = { error: String(e) }; } }
  const out = { v: 1, tool: 'tag-intel', capturedAt: new Date().toISOString(), page, containers, promos };
  
  const __tiPack = async (obj, tag) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const gz = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let bin = ''; for (let i = 0; i < gz.length; i += 0x8000) bin += String.fromCharCode.apply(null, gz.subarray(i, i + 0x8000));
    const b64 = btoa(bin), CH = 150000, n = Math.max(1, Math.ceil(b64.length / CH));
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => A[x % 62]).join('');
    const host = location.hostname;
    window.__tiPart = (i) => '__' + tag + '_PART_' + i + '_OF_' + n + '_ID_' + id + '_HOST_' + host + '__' + b64.slice(i * CH, (i + 1) * CH) + '__' + tag + '_PART_END__ ' +
      'pad:' + Array.from(crypto.getRandomValues(new Uint8Array(45000)), (x) => A[x % 62]).join('');
    return window.__tiPart(0) + ' parts=' + n + ' host=' + host;
  };
  return await __tiPack(out, 'TAGINTEL');
})()
