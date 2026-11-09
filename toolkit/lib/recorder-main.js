// Runs in the page's own JavaScript world from the very start of every page load.
// Captures data layer pushes and tracking requests and hands them to recorder-relay.js.
// It only observes: every hooked function calls through to the original unchanged.
(() => {
  if (window.__tiRecorder) return;
  window.__tiRecorder = true;

  const pageId = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  const MAX_ITEM = 20000;

  const emit = (kind, data) => {
    try {
      const item = { id: pageId + ':' + seq, page: pageId, seq: seq++, t: Date.now(), url: location.href, kind, ...data };
      let s = JSON.stringify(item);
      if (s.length > MAX_ITEM) {
        item.truncated = true;
        if (item.e !== undefined) item.e = JSON.stringify(item.e).slice(0, MAX_ITEM);
        if (item.body !== undefined) item.body = String(item.body).slice(0, 6000);
        s = JSON.stringify(item);
      }
      document.dispatchEvent(new CustomEvent('__ti_rec', { detail: s }));
    } catch {}
  };

  // ---------- serialization ----------
  const stack = new Set();
  const safe = (v, d = 0) => {
    const t = typeof v;
    if (t === 'function') return '[function]';
    if (t === 'bigint' || t === 'symbol') return String(v);
    if (v === null || t !== 'object') return v;
    if (v === window) return '[window]';
    if (typeof Node !== 'undefined' && v instanceof Node) {
      if (v.nodeType !== 1) return '[node]';
      let s = '<' + v.tagName.toLowerCase();
      if (v.id) s += '#' + v.id;
      if (typeof v.className === 'string' && v.className.trim()) s += '.' + v.className.trim().split(/\s+/).slice(0, 3).join('.');
      return s + '>';
    }
    if (stack.has(v)) return '[circular]';
    if (d > 6) return '[…]';
    stack.add(v);
    try {
      if (Object.prototype.toString.call(v) === '[object Arguments]') return { gtag: Array.from(v).map((x) => safe(x, d + 1)) };
      if (Array.isArray(v)) return v.slice(0, 100).map((x) => safe(x, d + 1));
      const o = {};
      let n = 0;
      for (const k of Object.keys(v)) {
        if (n++ > 120) { o['…'] = 'truncated'; break; }
        try { o[k] = safe(v[k], d + 1); } catch { o[k] = '[unreadable]'; }
      }
      return o;
    } finally {
      stack.delete(v);
    }
  };

  // ---------- data layers ----------
  const seen = new WeakSet();
  const record = (name, entry, pre) => {
    if (entry && typeof entry === 'object') {
      if (seen.has(entry)) return;
      seen.add(entry);
    }
    emit('dl', { layer: name, e: safe(entry), pre: !!pre });
  };
  const wrapped = new WeakMap(); // array -> our current wrapper
  const hookArr = (name, arr) => {
    if (!Array.isArray(arr)) return;
    if (!wrapped.has(arr)) arr.forEach((e) => record(name, e, true));
    const current = arr.push;
    if (wrapped.get(arr) === current) return;
    const ours = function (...args) {
      args.forEach((e) => record(name, e, false));
      return current.apply(this, args);
    };
    wrapped.set(arr, ours);
    try { arr.push = ours; } catch {}
  };
  const names = new Set(['dataLayer', 'adobeDataLayer']);
  const trap = (name) => {
    let val = window[name];
    if (Array.isArray(val)) hookArr(name, val);
    try {
      Object.defineProperty(window, name, {
        configurable: true, enumerable: true,
        get() { return val; },
        set(v) { val = v; if (Array.isArray(v)) hookArr(name, v); },
      });
    } catch {}
  };
  names.forEach(trap);
  // GTM and other libraries replace push after we wrap it; re-wrap whatever is current.
  let ticks = 0;
  const scanned = new WeakMap(); // array -> index scanned up to
  const rewrap = () => {
    for (const n of names) {
      const arr = window[n];
      if (!Array.isArray(arr)) continue;
      hookArr(n, arr);
      // Catch entries added without going through our wrapper (e.g. a library swapped push in between ticks)
      for (let i = scanned.get(arr) || 0; i < arr.length; i++) {
        const e = arr[i];
        if (e && typeof e === 'object' && !seen.has(e)) record(n, e, false);
      }
      scanned.set(arr, arr.length);
    }
    // pick up renamed GTM data layers (gtm.js?l=myLayer)
    try {
      for (const s of document.scripts) {
        const m = s.src && s.src.match(/googletagmanager\.com\/gtm\.js\?[^#]*\bl=([A-Za-z_$][\w$]*)/);
        if (m && !names.has(m[1])) { names.add(m[1]); trap(m[1]); }
      }
    } catch {}
    ticks++;
    setTimeout(rewrap, ticks < 40 ? 250 : ticks < 100 ? 1000 : 3000);
  };
  setTimeout(rewrap, 0);

  // ---------- navigation ----------
  emit('nav', { title: document.title, referrer: document.referrer });
  const route = (how) => emit('route', { how });
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...a) {
      const before = location.href;
      const r = orig.apply(this, a);
      if (location.href !== before) route(fn);
      return r;
    };
  }
  addEventListener('hashchange', () => route('hashchange'));
  addEventListener('popstate', () => route('popstate'));

  // ---------- network ----------
  const STATIC = /\.(css|woff2?|ttf|otf|eot|svg|png|jpe?g|webp|avif|gif|mp4|webm|m4s|ico|map)(\?|$)/i;
  const TRACKY = /collect|track|event|pixel|conv|adsct|\/tr\/?(\?|$)|\/p(\?|$)|batch|\/log|beacon|\/b\/ss\/|httpapi|\/v1\/[tpi](\?|$)|\/v1\/(track|page|identify)|interact|activity/i;
  const sameSite = (u) => {
    try { return new URL(u, location.href).hostname.split('.').slice(-2).join('.') === location.hostname.split('.').slice(-2).join('.'); }
    catch { return true; }
  };
  const wantUrl = (u) => !!u && !/^(data|blob|chrome-extension):/.test(u) && !(STATIC.test(u) && sameSite(u) && !TRACKY.test(u));

  try { performance.setResourceTimingBufferSize(3000); } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (wantUrl(e.name)) emit('req', { u: e.name.slice(0, 2000), via: 'resource:' + e.initiatorType });
    }).observe({ type: 'resource', buffered: true });
  } catch {}

  const bodyOf = (b) => {
    if (b == null) return null;
    if (typeof b === 'string') return b;
    if (b instanceof URLSearchParams) return b.toString();
    return null; // Blob/FormData handled separately or skipped
  };
  const sendBody = (url, body, via) => {
    try {
      const u = new URL(url, location.href).href;
      if (!TRACKY.test(u) && sameSite(u)) return;
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        if (body.size > 200000) return;
        body.text().then((t) => emit('req', { u: u.slice(0, 2000), body: t.slice(0, 8000), via })).catch(() => {});
        return;
      }
      const s = bodyOf(body);
      emit('req', { u: u.slice(0, 2000), body: s == null ? null : s.slice(0, 8000), via });
    } catch {}
  };

  try {
    const ob = navigator.sendBeacon;
    if (ob) navigator.sendBeacon = function (url, data) { sendBody(url, data, 'beacon'); return ob.apply(this, arguments); };
  } catch {}
  try {
    const of = window.fetch;
    if (of) window.fetch = function (input, init) {
      try {
        const url = typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input);
        const method = (init && init.method) || (input && input.method) || 'GET';
        if (url && method.toUpperCase() !== 'GET') sendBody(url, init && init.body, 'fetch');
      } catch {}
      return of.apply(this, arguments);
    };
  } catch {}
  try {
    const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__ti = { method: String(method || 'GET'), url: String(url) }; } catch {}
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try { if (this.__ti && this.__ti.method.toUpperCase() !== 'GET') sendBody(this.__ti.url, body, 'xhr'); } catch {}
      return xs.apply(this, arguments);
    };
  } catch {}
})();
