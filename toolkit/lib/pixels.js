// Decodes tracking requests (pixel URLs and request bodies) into { vendor, account, event, value, currency, params }.

const VALUE_KEYS = ['value', 'revenue', 'price', 'total', 'cost', 'conv_value', 'gv', 'amount', 'order_value'];

function qs(str) {
  const out = {};
  if (!str) return out;
  for (const part of String(str).replace(/^[?#]/, '').split(/[&;]/)) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    let v = i < 0 ? '' : part.slice(i + 1);
    try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch {}
    let key = k;
    try { key = decodeURIComponent(k); } catch {}
    if (!(key in out)) out[key] = v;
  }
  return out;
}

const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const num = (v) => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
function genericValue(p) {
  for (const k of VALUE_KEYS) if (p[k] != null && num(p[k]) != null) return num(p[k]);
  for (const [k, v] of Object.entries(p)) if (/(^|[._\[])(value|revenue)(\]|$)/i.test(k) && num(v) != null) return num(v);
  return null;
}
const hit = (vendor, o) => {
  const h = { vendor, account: null, event: null, value: null, currency: null, params: {}, ...o };
  if (h.event == null || h.event === '' || h.event === 'undefined') h.event = '(details in request body)';
  return h;
};

// Returns an array (a request can carry several events, e.g. batched GA4 hits).
export function decodeHit(rawUrl, body) {
  let u;
  try { u = new URL(rawUrl, 'https://x.invalid/'); } catch { return []; }
  const host = u.hostname, path = u.pathname, p = qs(u.search);
  const b = typeof body === 'string' ? body : '';
  const bodyJson = b && /^\s*[[{]/.test(b) ? tryJson(b) : null;

  // ---- Google Analytics 4 (also first-party / server-side GTM endpoints) ----
  if (/\/g\/collect$/.test(path) && /^G-/.test(p.tid || '')) {
    const lines = b && !bodyJson ? b.split(/\r?\n/).filter(Boolean) : [''];
    return lines.map((line) => {
      const q = { ...p, ...qs(line) };
      return hit('GA4', {
        account: q.tid, event: q.en || 'page_view',
        value: num(q['epn.value'] ?? q['ep.value']), currency: q.cu || null,
        params: q, transport: GOOGLE_HOST.test(host) ? 'google' : host,
      });
    });
  }
  // ---- Google consent-mode / tag gateway pings (ccm) ----
  if (/\/ccm\/collect$/.test(path) && p.tid) {
    const vendor = /^AW-/.test(p.tid) ? 'Google Ads' : /^DC-/.test(p.tid) ? 'Floodlight / CM360' : /^G-/.test(p.tid) ? 'GA4' : 'Google tag';
    return [hit(vendor, { account: p.tid, event: p.en || 'ping', params: p })];
  }
  // ---- Google Ads ----
  let m = path.match(/\/pagead\/(?:conversion|viewthroughconversion|1p-conversion|1p-user-list)\/(\d+)/);
  if (m && /google|doubleclick/.test(host)) {
    const remarketing = /viewthrough|user-list/.test(path) && !p.label;
    const data = qs((p.data || '').replace(/;/g, '&'));
    return [hit('Google Ads', {
      account: 'AW-' + m[1], event: remarketing ? 'remarketing' : `conversion${p.label ? ' ' + p.label : ''}`,
      value: num(p.value), currency: p.currency_code || null, params: { ...p, ...data },
    })];
  }
  // ---- Floodlight ----
  if (/ad\.doubleclick\.net$|fls\.doubleclick\.net$|\.fls\.doubleclick\.net$/.test(host) && /\/activityi?[;/]/.test(path + ';')) {
    const fp = qs(path.split(/;/).slice(1).join(';') + (u.search ? ';' + u.search.slice(1) : ''));
    return [hit('Floodlight / CM360', {
      account: fp.src ? 'DC-' + fp.src : null, event: [fp.type, fp.cat].filter(Boolean).join('/') || 'config ping',
      value: num(fp.cost), params: fp,
    })];
  }
  // ---- Meta ----
  if (/(^|\.)facebook\.com$/.test(host) && /^\/tr\/?$/.test(path)) {
    const q = { ...p, ...(b && !bodyJson ? qs(b) : {}) };
    return [hit('Meta Pixel', {
      account: q.id, event: q.ev, value: num(q['cd[value]']), currency: q['cd[currency]'] || null,
      params: q, dedupId: q.eid || null,
    })];
  }
  // ---- TikTok ----
  if (/tiktok/.test(host) && /\/api\/v\d\/pixel\/(act|inter|perf|enrich)/.test(path)) return [hit('TikTok', { account: bodyJson?.context?.pixel?.code || null, event: 'auto engagement', params: bodyJson || p, noise: true })];
  if (/tiktok/.test(host) && /\/api\/v\d\/pixel/.test(path)) {
    const evs = bodyJson ? (Array.isArray(bodyJson.batch) ? bodyJson.batch : [bodyJson]) : [p];
    return evs.map((e) => hit('TikTok', {
      account: e?.context?.pixel?.code || e?.pixel_code || p.sdkid || null,
      event: e?.event || p.event || 'event',
      value: num(e?.properties?.value), currency: e?.properties?.currency || null,
      params: e || {}, dedupId: e?.event_id || null,
    }));
  }
  // ---- Snapchat ----
  if (/snapchat\.com$/.test(host) && /^\/p\b/.test(path) && bodyJson && !bodyJson.ev) return [hit('Snapchat', { event: 'telemetry', params: bodyJson, noise: true })];
  if (/snapchat\.com$/.test(host) && /^\/p\b|\/cm\/[pi]/.test(path)) {
    const q = { ...p, ...(b && !bodyJson ? qs(b) : {}) };
    return [hit('Snapchat', { account: q.pid, event: q.ev, value: num(q.p_a ?? q.price), currency: q.cur || null, params: q })];
  }
  // ---- Microsoft UET ----
  if (/bat\.bing\.com$/.test(host) && /^\/action/.test(path)) {
    const ev = p.evt === 'custom' ? (p.ea || 'custom') : p.evt;
    return [hit('Microsoft Ads (UET)', { account: p.ti, event: ev, value: num(p.gv ?? p.ev), currency: p.gc || null, params: p })];
  }
  // ---- LinkedIn ----
  if (/px\.ads\.linkedin\.com$/.test(host) && /\/collect/.test(path)) {
    return [hit('LinkedIn', {
      account: p.pid, event: p.conversionId ? 'conversion ' + p.conversionId : 'page_view',
      value: num(p.value), params: p,
    })];
  }
  // ---- Reddit ----
  if (/alb\.reddit\.com$/.test(host) || (/reddit/.test(host) && /\/rp\.gif/.test(path))) {
    return [hit('Reddit', { account: p.id, event: p.event, value: num(p['m.value'] ?? p.value), currency: p['m.currency'] || null, params: p })];
  }
  // ---- Pinterest ----
  if (/ct\.pinterest\.com$/.test(host)) {
    const ed = tryJson(p.ed || '') || {};
    return [hit('Pinterest', { account: p.tid, event: p.event, value: num(ed.value), currency: ed.currency || null, params: { ...p, ed } })];
  }
  // ---- Twitter / X ----
  if ((/analytics\.twitter\.com$/.test(host) || host === 't.co') && /adsct/.test(path)) {
    const ev = tryJson(p.events || '');
    return [hit('Twitter / X', {
      account: p.txn_id || p.pl_id || null, event: Array.isArray(ev) ? ev.map((e) => e[0]).join(',') : (p.events || 'pageview'),
      value: num(p.tw_sale_amount), params: p,
    })];
  }
  // ---- AdRoll ----
  if (/adroll\.com$/.test(host)) {
    if (/^\/cm\//.test(path)) return [hit('AdRoll / NextRoll', { event: 'cookie sync', params: p, noise: true })];
    m = path.match(/^\/(pixel|pex|ipixel|consent\/check|segment)\/([A-Z0-9]+)/);
    if (m) return [hit('AdRoll / NextRoll', {
      account: m[2], event: p.name || p.segment_name || m[1], value: num(p.conv_value), currency: p.currency || null, params: p,
    })];
  }
  // ---- The Trade Desk ----
  if (/adsrvr\.org$/.test(host) && /\/track\//.test(path)) {
    return [hit('The Trade Desk', {
      account: p.adv || p.advertiser_id, event: p.ct || path.split('/').pop(), value: num(p.v), currency: p.vf || null,
      params: p, noise: /cei|up_loader/.test(path),
    })];
  }
  // ---- Beeswax ----
  if (/bidr\.io$/.test(host)) {
    return [hit('Beeswax', { account: p.buzz_key, event: `conversion tag ${p.tag_id || '?'}`, value: num(p.value), params: p })];
  }
  // ---- Adobe Analytics ----
  m = path.match(/\/b\/ss\/([^/]+)\//);
  if (m) {
    const q = { ...p, ...(b && !bodyJson ? qs(b) : {}) };
    let rev = null;
    if (q.products) rev = q.products.split(',').reduce((s, prod) => s + (num(prod.split(';')[3]) || 0), 0) || null;
    return [hit('Adobe Analytics', {
      account: m[1], event: q.pe === 'lnk_o' ? 'link: ' + (q.pev2 || '') : (q.events ? `${q.pageName || 'page'} [${q.events}]` : q.pageName || 'page'),
      value: rev, params: q,
    })];
  }
  // ---- Adobe Experience Platform Web SDK ----
  if (/\/ee\/.*\/v\d\/interact|\/ee\/v\d\/(interact|collect)|adobedc\.net$/.test(path + ' ' + host) && bodyJson) {
    const evs = bodyJson.events || [];
    return evs.map((e) => hit('Adobe Analytics', { account: p.configId, event: e?.xdm?.eventType || 'event', params: e }));
  }
  // ---- Segment / Hightouch / RudderStack-style CDPs ----
  if (/segment\.(io|com)$|hightouch-events\.com$|rudderstack/.test(host) && bodyJson) {
    const vendor = /segment/.test(host) ? 'Segment' : /hightouch/.test(host) ? 'Hightouch' : 'RudderStack';
    const evs = Array.isArray(bodyJson.batch) ? bodyJson.batch : [bodyJson];
    return evs.map((e) => hit(vendor, {
      account: e?.writeKey ? String(e.writeKey).slice(0, 10) + '…' : null, event: e?.event || (e?.type === 'page' ? (e?.name ? 'page: ' + e.name : 'page') : e?.type),
      value: num(e?.properties?.value ?? e?.properties?.revenue ?? e?.properties?.total), params: e,
    }));
  }
  // ---- Amplitude ----
  if (/amplitude\.com$/.test(host) && bodyJson && Array.isArray(bodyJson.events)) {
    return bodyJson.events.map((e) => hit('Amplitude', {
      account: bodyJson.api_key ? String(bodyJson.api_key).slice(0, 8) + '…' : null, event: e.event_type,
      value: num(e.event_properties?.value ?? e.revenue ?? e.price), params: e,
    }));
  }
  // ---- Clinch ----
  if (/clinch\.co$/.test(host) && /trk/.test(path)) return [hit('Clinch', { account: p.cid, event: p.type, value: num(p.value), params: p })];
  // ---- tvScientific ----
  if (/pix\.pub$/.test(host)) return [hit('tvScientific', { account: p.l, event: p.u1 || 'pageview', value: num(p.u2), params: p })];
  // ---- MNTN ----
  if (/mountain\.com$/.test(host)) return [hit('MNTN', { account: p.shaid, event: p.conv === '1' ? 'conversion' : 'pageview', value: num(p.amt ?? p.value), params: p })];
  // ---- Viant ----
  if (/ipredictive\.com$/.test(host)) return [hit('Viant', { account: p.upid, event: p.p1 || 'event', params: p })];
  // ---- Basis ----
  if (/sitescout\.com$|basis\.net$/.test(host) && !/\.js$/.test(path)) return [hit('Basis', { account: path.split('/').pop(), event: 'pageview', params: p })];

  return [];
}

const GOOGLE_HOST = /(^|\.)(google-analytics\.com|analytics\.google\.com|google\.com|doubleclick\.net)$/;

// Is this URL a script/library load (useful for the vendor list but not a "hit")?
export const isLibraryLoad = (url) => /\.js(\?|$)|\/gtag\/js|\/gtm\.js|\/signals\/config\//.test(url);
