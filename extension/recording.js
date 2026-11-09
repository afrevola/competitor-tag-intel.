// Turns raw recorder items into a timeline, per-platform pixel summary, funnel path and anomalies.
import { decodeHit, isLibraryLoad } from './pixels.js';
import { detectVendors } from './vendors.js';

const SYSTEM = /^(gtm\.(js|dom|load|timer|scrollDepth|historyChange|init|init_consent|linkClick|click|formSubmit|elementVisibility|video)|OneTrust|Optanon|nextroll|consent)/;
const VALUE_KEY = /^(value|revenue|price|total|subtotal|amount|totalReservationPrice|TotalReservationPrice|GameplayPrice|DepositAmount|UpgradePrice|tax|shipping|conversion_value|order_total|transactiontotal)$/i;

export function dlLabel(e) {
  if (e && typeof e === 'object') {
    if (e.event) return String(e.event);
    if (Array.isArray(e.gtag)) return 'gtag: ' + e.gtag.slice(0, 2).map((x) => (typeof x === 'string' ? x : '{…}')).join(' ');
    if (e[0] === 'consent' || (e['0'] && e['1'])) return `gtag: ${e[0]} ${e[1] || ''}`.trim();
    const keys = Object.keys(e).filter((k) => k !== 'gtm.uniqueEventId');
    return keys.length ? '{' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? ', …' : '') + '}' : '(empty)';
  }
  return String(e);
}

export function findValues(o, path = '', out = [], depth = 0) {
  if (!o || typeof o !== 'object' || depth > 6 || out.length >= 8) return out;
  for (const [k, v] of Object.entries(o)) {
    const p = path ? `${path}.${k}` : k;
    if (VALUE_KEY.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())))) out.push([p, Number(v)]);
    else if (v && typeof v === 'object') findValues(v, p, out, depth + 1);
  }
  return out;
}

const stripIds = (e) => JSON.stringify(e, (k, v) => (k === 'gtm.uniqueEventId' || k === 'gtm.start' ? undefined : v));

export function analyzeRecording(rec) {
  const items = (rec && rec.items) || [];
  // Body-captured requests supersede the resource-timing entry for the same URL on the same page
  const bodyUrls = new Set(items.filter((i) => i.kind === 'req' && i.body !== undefined).map((i) => i.page + ' ' + i.u));

  const rows = [];
  const libraries = new Set();
  const urls = [];
  for (const it of items) {
    if (it.kind === 'nav' || it.kind === 'route') {
      rows.push({ type: 'page', t: it.t, url: it.url, how: it.kind === 'nav' ? 'page load' : it.how, page: it.page });
      continue;
    }
    if (it.kind === 'dl') {
      let e = it.e;
      let label;
      if (typeof e === 'string' && it.truncated) {
        // Very large push (stored cut short): recover the event name from the raw text
        const m = e.match(/"event"\s*:\s*"([^"]+)"/) || e.match(/^\{\\?"event\\?"\s*:\s*\\?"([^"\\]+)/);
        label = m ? m[1] : '(large push)';
        e = { event: label, note: 'Very large push; shown cut short', raw: e.slice(0, 3000) };
      } else label = dlLabel(e);
      rows.push({
        type: 'dl', t: it.t, url: it.url, page: it.page, layer: it.layer, label, e, pre: it.pre,
        system: SYSTEM.test(label) || label.startsWith('gtag:'), values: findValues(e), key: it.page + '|' + stripIds(e),
      });
      continue;
    }
    if (it.kind === 'req') {
      urls.push(it.u);
      if (it.body === undefined && bodyUrls.has(it.page + ' ' + it.u)) continue;
      if (isLibraryLoad(it.u)) {
        detectVendors(it.u).forEach((v) => libraries.add(v));
        continue;
      }
      const hits = decodeHit(it.u, it.body);
      for (const h of hits) {
        rows.push({
          type: 'hit', t: it.t, url: it.url, page: it.page, vendor: h.vendor, event: h.event, account: h.account,
          value: h.value, currency: h.currency, params: h.params, transport: h.transport, noise: !!h.noise,
          dedupId: h.dedupId, req: it.u, body: it.body, key: it.page + '|' + h.vendor + '|' + h.account + '|' + h.event + '|' + h.value,
        });
      }
    }
  }

  // Collapse consecutive identical rows (same page, same payload) into one with a count
  const timeline = [];
  for (const r of rows) {
    const last = timeline[timeline.length - 1];
    if (last && r.type !== 'page' && last.type === r.type && last.key === r.key) {
      last.count++;
      last.tEnd = r.t;
    } else timeline.push({ ...r, count: 1, tEnd: r.t });
  }

  // Per-platform pixel summary
  const platforms = {};
  for (const r of rows.filter((x) => x.type === 'hit' && !x.noise)) {
    const p = (platforms[r.vendor] ||= { accounts: new Set(), events: {} });
    if (r.account) p.accounts.add(r.account);
    const ev = (p.events[r.event] ||= { count: 0, values: new Set(), withEventId: 0 });
    ev.count++;
    if (r.value != null) ev.values.add(r.value + (r.currency ? ' ' + r.currency : ''));
    if (r.dedupId) ev.withEventId++;
  }

  // Funnel path: first occurrence of each non-system data layer event, in order
  const funnel = [];
  const firstSeen = new Set();
  for (const r of rows.filter((x) => x.type === 'dl' && !x.system && !x.pre)) {
    if (firstSeen.has(r.label)) continue;
    firstSeen.add(r.label);
    funnel.push({ label: r.label, t: r.t, values: r.values });
  }

  // Anomalies
  const anomalies = [];
  const burst = (list, labelOf, what) => {
    const byLabel = {};
    for (const r of list) (byLabel[labelOf(r)] ||= []).push(r.t);
    for (const [label, ts] of Object.entries(byLabel)) {
      ts.sort((a, b) => a - b);
      let best = 0;
      for (let i = 0, j = 0; i < ts.length; i++) {
        while (ts[i] - ts[j] > 5000) j++;
        best = Math.max(best, i - j + 1);
      }
      if (best >= 5) anomalies.push({ kind: 'burst', text: `${what} "${label}" fired ${best}× within 5 seconds (${ts.length}× total). Reports and audiences built on it will be inflated.` });
    }
  };
  burst(rows.filter((x) => x.type === 'dl' && !/^gtm\.(timer|scrollDepth)/.test(x.label) && !x.pre), (r) => r.label, 'Data layer event');
  burst(rows.filter((x) => x.type === 'hit' && !x.noise), (r) => `${r.vendor}: ${r.event}`, 'Pixel');

  for (const [vendor, p] of Object.entries(platforms)) {
    for (const [ev, s] of Object.entries(p.events)) {
      if (/purchase|conversion|complete|checkout_complete|order/i.test(ev) && s.count > 1) {
        anomalies.push({ kind: 'dup', text: `${vendor} "${ev}" fired ${s.count}× in this recording. If this was one transaction, the platform counts it more than once unless it de-duplicates (event IDs on ${s.withEventId} of ${s.count}).` });
      }
      if (/purchase|conversion|complete/i.test(ev) && s.values.size === 0) {
        anomalies.push({ kind: 'novalue', text: `${vendor} "${ev}" was sent without a value.` });
      }
    }
    if (p.accounts.size > 1 && !['GA4', 'Adobe Analytics'].includes(vendor)) {
      anomalies.push({ kind: 'accounts', text: `${vendor} fired to ${p.accounts.size} different accounts: ${[...p.accounts].join(', ')}.` });
    }
  }

  return { timeline, platforms, funnel, anomalies, libraries: [...libraries], urls, started: rec?.started, dropped: rec?.dropped };
}

export function recordingCsv(analysis) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Time', 'Page', 'Type', 'Layer / Platform', 'Event', 'Account', 'Value', 'Currency', 'Count', 'Details']];
  for (const r of analysis.timeline) {
    const time = new Date(r.t).toISOString();
    if (r.type === 'page') rows.push([time, r.url, 'page', '', r.how, '', '', '', '', '']);
    else if (r.type === 'dl') rows.push([time, r.url, 'data layer', r.layer, r.label, '', r.values.map(([k, v]) => `${k}=${v}`).join(' '), '', r.count, JSON.stringify(r.e)]);
    else rows.push([time, r.url, 'pixel', r.vendor, r.event, r.account, r.value, r.currency, r.count, r.req + (r.body ? ' BODY ' + r.body : '')]);
  }
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}
