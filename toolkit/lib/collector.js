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
    containers: [...found].map(([id, src]) => ({ id, src })),
    dataLayers,
    launch,
    network: { urls: resources.map((u) => u.slice(0, 1000)), scripts, cookies, resources: resTiming, timing },
  };
}
