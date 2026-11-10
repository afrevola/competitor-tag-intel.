// Injected into the page (MAIN world). Must be fully self-contained: no outside references.
// Collects tag containers, data layers, the Adobe Launch container, and network/cookie evidence.

export async function collectPage() {
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
    if (!id || !/^(GTM|GT|G|AW|DC)-[A-Za-z0-9]+$/i.test(id)) return;
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
  resources.forEach((u) => { if (/[?&]id=(GTM|GT|G|AW|DC)-/i.test(u) && /gtm\.js|gtag\/js|googletagmanager/.test(u)) check(u); });
  try {
    if (window.google_tag_manager) Object.keys(window.google_tag_manager).forEach((k) => { if (/^(GTM|GT|G|AW|DC)-/.test(k)) add(k, null); });
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

  // ---- Experiments running now (testing tools that expose their live tests in the page) ----
  const experiments = [];
  try {
    const o = window.optimizely;
    if (o && typeof o.get === 'function') {
      const st = o.get('state'), data = o.get('data');
      const vm = st?.getVariationMap?.() || {};
      for (const id of st?.getActiveExperimentIds?.() || []) experiments.push({ tool: 'Optimizely', name: data?.experiments?.[id]?.name || id, variant: vm[id]?.name || null });
    }
  } catch {}
  try { if (window._vwo_exp) for (const [id, e] of Object.entries(window._vwo_exp)) if (e && (e.status === 'RUNNING' || e.ready)) experiments.push({ tool: 'VWO', name: e.name || id, variant: e.combination_chosen && e.comb_n ? e.comb_n[e.combination_chosen] || null : null }); } catch {}
  try { const r = window.ABTasty?.results; if (r) for (const [id, e] of Object.entries(r)) experiments.push({ tool: 'AB Tasty', name: e.name || id, variant: e.variationName || null }); } catch {}
  try { const c = window.convert?.currentData?.experiments; if (c) for (const [id, e] of Object.entries(c)) experiments.push({ tool: 'Convert', name: e.experiment_name || e.name || id, variant: e.variation_name || null }); } catch {}
  try { const k = window.Kameleoon?.API?.Experiments?.getActive?.(); if (k) for (const e of k) experiments.push({ tool: 'Kameleoon', name: e.name || e.id, variant: e.associatedVariation?.name || null }); } catch {}
  try {
    const ig = window.igData || window.Intelligems;
    if (ig) {
      const t = ig.tests || ig.activeTests || ig.user?.tests || ig.experiences;
      if (t && typeof t === 'object' && Object.keys(t).length) for (const [id, e] of Object.entries(t)) experiments.push({ tool: 'Intelligems', name: e?.name || id, variant: e?.variation?.name || e?.variationName || null });
      else experiments.push({ tool: 'Intelligems', name: '(running; test names not exposed)', variant: null });
    }
  } catch {}
  try { if (window.adobe?.target) experiments.push({ tool: 'Adobe Target', name: '(loaded; activity names not exposed)', variant: null }); } catch {}
  try { if (window.monetateQ || window.monetate) experiments.push({ tool: 'Monetate', name: '(loaded; test names not exposed)', variant: null }); } catch {}

  // ---- Messaging on this page ----
  let messaging = null;
  try {
    const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
    // Visible text only (skips hidden menus, drawers and style blocks); repeated marquee text is kept once
    const vis = (el) => !!el && (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null);
    const said = (el) => {
      let t = (el?.innerText || '').replace(/\s+/g, ' ').trim();
      const half = t.slice(0, Math.floor(t.length / 2)).trim();
      if (half && t.split(half).length > 2) t = half;
      return t;
    };
    const meta = (q) => document.querySelector(q)?.getAttribute('content') || '';
    const ctas = [...new Set([...document.querySelectorAll('a,button')]
      .filter((e) => (e.tagName === 'BUTTON' || /btn|button|cta/i.test(String(e.className || '') + ' ' + (e.getAttribute('role') || ''))) && vis(e))
      .map(said).filter((t) => t.length > 1 && t.length < 40))].slice(0, 25);
    const body = (document.body?.textContent || '').replace(/\s+/g, ' ');
    const offerRe = /(?:get|save|take|enjoy|unlock|receive)?\s*(?:\d{1,2}\s?%|[$£€]\s?\d+)\s*off\s*(?:your\s*)?(?:first|next|1st)\s*(?:order|purchase|box|month|booking|visit)[^.!<>{}]{0,40}/gi;
    messaging = {
      title: document.title || '',
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      h1: [...document.querySelectorAll('h1')].filter(vis).map(said).filter(Boolean).slice(0, 3),
      h2: [...document.querySelectorAll('h2')].filter(vis).map(said).filter(Boolean).slice(0, 12),
      ctas,
      announcement: said(document.querySelector('[class*="announcement"],[id*="announcement"],[class*="promo-bar"],[class*="promobar"],[class*="top-bar"],[class*="topbar"],[class*="banner-bar"]')).slice(0, 200),
      signupOffers: [...new Set((body.match(offerRe) || []).map((x) => x.trim()))].slice(0, 5),
    };
  } catch {}

  // ---- Structured data and language versions ----
  const structured = [];
  for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { structured.push(JSON.parse(sc.textContent)); } catch {}
    if (JSON.stringify(structured).length > 60000) break;
  }
  const hreflang = [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => [l.getAttribute('hreflang'), l.href]).slice(0, 80);

  // ---- Shopify: app pixels configured in Shopify (webPixelsConfigList) and theme app embeds ----
  let shopify = null;
  try {
    const sliceArr = (text, from) => {
      const start = text.indexOf('[', from);
      if (start < 0) return null;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '[' || ch === '{') depth++;
        else if (ch === ']' || ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
      }
      return null;
    };
    const webPixels = [];
    for (const sc of document.scripts) {
      if (sc.src || !sc.textContent.includes('webPixelsConfigList')) continue;
      const t = sc.textContent;
      const arr = sliceArr(t, t.indexOf('webPixelsConfigList'));
      try {
        for (const px of JSON.parse(arr) || []) webPixels.push({ id: px.id, type: px.type, apiClientId: px.apiClientId, runtime: px.runtimeContext, purposes: px.privacyPurposes, config: String(px.configuration || '').slice(0, 20000) });
      } catch {}
      break;
    }
    const appEmbeds = [...new Set(scripts.map((u) => (u.match(/cdn\.shopify\.com\/extensions\/[^/]+\/([^/]+)\//) || [])[1]).filter(Boolean).map((h) => h.replace(/-\d+$/, '')))];
    const S = window.Shopify;
    if (S || webPixels.length || appEmbeds.length) shopify = {
      shop: S?.shop || null,
      theme: S?.theme ? { name: S.theme.name || null, id: S.theme.id || null, schema: S.theme.schema_name || null } : null,
      currency: S?.currency?.active || null, country: S?.country || null,
      webPixels, appEmbeds,
    };
  } catch {}

  return {
    url: location.href,
    host: location.hostname,
    shopify,
    experiments,
    messaging,
    structured,
    hreflang,
    containers: [...found].map(([id, src]) => ({ id, src })),
    dataLayers,
    launch,
    network: { urls: resources.map((u) => u.slice(0, 1000)), scripts, cookies, resources: resTiming, timing },
  };
}
