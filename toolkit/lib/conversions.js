// Builds a per-platform conversion map from GTM containers and Adobe Launch rules,
// with flags for setups that mislead bidding or reporting.
import { decodeHit } from './pixels.js';

const PURCHASE_EVENT = /purchase|conversion|complete|order|checkout_complete|booking_completed|transaction|sale/i;
const PURCHASE_TRIGGER = /purchase|complet|confirm|thank|order|success|paid|payment|transaction|receipt|booked/i;
const LEAD_EVENT = /lead|submit|sign_?up|subscribe|register|contact|form|request|schedule/i;
const PAGE_EVENTS = /^(gtm\.js|gtm\.dom|gtm\.load|gtm\.init|gtm\.historyChange|pageview|page_view|OneTrustGroupsUpdated|OneTrustLoaded|OptanonLoaded)$/i;
const triggerEvents = (f) => [...f.matchAll(/\{\{Event\}\} (?:equals|matches RegEx|contains) (\S+)/g)].map((m) => m[1]);
const urlConds = (f) => [...f.replace(/NOT \([^)]*\)\)?/g, '').matchAll(/\{\{(?:Page (?:Url|URL|Path|Host)|Custom JS #\d+)\}\} (?:contains|equals|matches RegEx|starts with) (\S+)/g)].map((m) => m[1]).filter((x) => !/^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\/?$|staging|\bdev\b/.test(x)); // skip bare host / environment checks

const CALL_FNS = { fbq: 'Meta Pixel', snaptr: 'Snapchat', pintrk: 'Pinterest', rdt: 'Reddit', twq: 'Twitter / X', clq: 'Clinch', oaiq: 'OpenAI (oaiq)', qp: 'Quora', ndp: 'Nextdoor', lintrk: 'LinkedIn', spdt: 'Spotify Ads', saq: 'StackAdapt' };
const VALUE_IN_OBJ = /(?:^|[,{\s])["']?(value|price|revenue|conv_value|event_value|revenue_value|amount|total|tw_sale_amount|gv)["']?\s*:\s*([^,}\n]+)/;

function valueFromObj(obj) {
  if (!obj) return null;
  const m = obj.match(VALUE_IN_OBJ);
  return m ? m[2].trim().replace(/^parseFloat\((.*)\)$/, '$1').replace(/^["']|["']$/g, '') : null;
}

// Find tracking calls in custom code (GTM Custom HTML or Launch custom code)
const stripComments = (code) => String(code || '')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');

export function callsInCode(code) {
  const all = rawCalls(stripComments(code));
  const best = new Map();
  for (const c of all) {
    const k = c.platform + '|' + c.event + '|' + (c.account || '');
    const prev = best.get(k);
    if (!prev || (prev.value == null && c.value != null)) best.set(k, c);
  }
  return [...best.values()];
}
function rawCalls(code) {
  const out = [];
  if (!code) return out;
  let m;
  const generic = /\b(fbq|snaptr|pintrk|rdt|twq|clq|oaiq|qp|ndp|spdt|saq)\(\s*["'](track|trackCustom|trackSingle|event|conv)["']\s*,\s*["']([^"']+)["']\s*(?:,\s*["']?[^,{)]*["']?\s*)?(?:,\s*(\{[^}]*\}))?/g;
  while ((m = generic.exec(code))) out.push({ platform: CALL_FNS[m[1]], event: m[3], value: valueFromObj(m[4] || code.slice(m.index, m.index + 400)), how: `${m[1]}("${m[2]}")` });
  const ttq = /ttq\.track\(\s*["']([^"']+)["']\s*(?:,\s*(\{[^}]*\}))?/g;
  while ((m = ttq.exec(code))) out.push({ platform: 'TikTok', event: m[1], value: valueFromObj(m[2]), how: 'ttq.track' });
  const gtagConv = /gtag\(\s*["']event["']\s*,\s*["']conversion["']\s*,\s*(\{[^}]*\})/g;
  while ((m = gtagConv.exec(code))) {
    const to = ((m[1].match(/send_to["']?\s*:\s*["']([^"']+)/) || [])[1] || '').trim();
    out.push({ platform: /^DC-/.test(to) ? 'Floodlight / CM360' : 'Google Ads', account: to.split('/')[0] || null, event: 'conversion ' + (to.split('/')[1] || ''), value: valueFromObj(m[1]), how: 'gtag conversion' });
  }
  const uet = /uetq[^;]*?\.push\(\s*(?:["']event["']\s*,\s*["']([^"']+)["']\s*,\s*(\{[^}]*\})|(\{[^}]*\}))/g;
  while ((m = uet.exec(code))) {
    const obj = m[2] || m[3] || '';
    const ea = m[1] || (obj.match(/\bea["']?\s*:\s*["']([^"']+)/) || [])[1] || 'event';
    out.push({ platform: 'Microsoft Ads (UET)', event: ea, value: valueFromObj(obj.replace(/revenue_value|gv/, 'value')), how: 'uetq.push' });
  }
  const li = /lintrk\(\s*["']track["']\s*,\s*\{[^}]*conversion_id\s*:\s*["']?(\d+)/g;
  while ((m = li.exec(code))) out.push({ platform: 'LinkedIn', event: 'conversion ' + m[1], value: null, how: 'lintrk' });
  const adroll = /adroll\.track\(\s*["']([^"']+)["']\s*(?:,\s*(\{[^}]*\}))?/g;
  while ((m = adroll.exec(code))) {
    const seg = m[2] && (m[2].match(/segment_name\s*:\s*["']([^"']+)/) || [])[1];
    out.push({ platform: 'AdRoll / NextRoll', event: m[1] + (seg ? ` (segment ${seg})` : ''), value: valueFromObj(m[2] && m[2].replace(/conversion_value/, 'value')), how: 'adroll.track' });
  }
  const nb = /Northbeam\.(firePurchaseEvent|fireCustomGoal)\(\s*["']?([^"',)]*)/g;
  while ((m = nb.exec(code))) out.push({ platform: 'Northbeam', event: m[1] === 'firePurchaseEvent' ? 'purchase' : 'goal: ' + m[2], value: null, how: 'Northbeam' });
  // Image pixels inside HTML
  const img = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((m = img.exec(code))) for (const h of decodeHit(m[1].replace(/&amp;/g, '&'))) {
    if (h.noise) continue;
    out.push({ platform: h.vendor, account: h.account, event: h.event, value: h.value ?? rawValueParam(m[1]), how: 'image pixel' });
  }
  return out;
}
const rawValueParam = (u) => (u.match(/[?&;](?:value|cost|conv_value|v|amt|revenue)=([^&;]+)/) || [])[1] || null;

function valueKind(value, variables) {
  if (value == null || value === '') return { text: '—', fixed: null, scraped: false };
  const v = String(value);
  if (/^-?\d+(\.\d+)?$/.test(v)) return { text: v, fixed: Number(v), scraped: false };
  // Follow Custom JS variables to see if the value is scraped from the page
  const scraped = (() => {
    const seen = new Set();
    const check = (txt, depth) => {
      if (depth > 4) return false;
      for (const mm of String(txt).matchAll(/\{\{Custom JS #(\d+)\}\}/g)) {
        const i = +mm[1];
        if (seen.has(i)) continue;
        seen.add(i);
        const code = String(variables?.[i]?.params?.javascript || '');
        if (/querySelector|getElementBy|innerText|textContent|innerHTML/.test(code)) return true;
        if (check(code, depth + 1)) return true;
      }
      return false;
    };
    return check(v, 0);
  })();
  return { text: v, fixed: null, scraped };
}

const unConst = (v) => { const m = String(v ?? '').match(/^\{\{Constant "([^"]+)"\}\}$/); return m ? m[1] : v; };

export function buildConversionMap({ gtm = [], launch = null }) {
  const rows = [];
  const push = (r) => rows.push({ flags: [], ...r });

  for (const { id: cid, data } of gtm) {
    if (!data) continue;
    for (const t of data.tags) {
      if (t.category !== 'tag') continue;
      const P = t.params;
      const base = { container: cid, tag: `#${t.id}`, tagType: t.type, paused: t.paused, firing: t.firing, blocking: t.blocking, variables: data.variables };
      if (t.fn === '__awct') push({ ...base, platform: 'Google Ads', account: 'AW-' + unConst(P.conversionId), event: 'conversion ' + (P.conversionLabel || ''), label: P.conversionLabel, value: P.conversionValue, currency: P.currencyCode, enhanced: !!P.enableEnhancedConversion });
      else if (t.fn === '__fls') push({ ...base, platform: 'Floodlight / CM360', account: 'DC-' + unConst(P.advertiserId), event: `sales ${P.groupTag}/${P.activityTag}`, label: P.activityTag, value: P.revenue, counting: P.countingMethod });
      else if (t.fn === '__flc') push({ ...base, platform: 'Floodlight / CM360', account: 'DC-' + unConst(P.advertiserId), event: `counter ${P.groupTag}/${P.activityTag}`, label: P.activityTag, value: null, counting: P.countingMethod || P.ordinalType, counter: true });
      else if (t.fn === '__gaawe') {
        const ev = String(P.eventName || '');
        const ps = Array.isArray(P.eventSettingsTable) ? P.eventSettingsTable : Array.isArray(P.eventParameters) ? P.eventParameters : [];
        const vp = ps.find((x) => x && (x.parameter === 'value' || x.name === 'value'));
        const value = vp ? (vp.parameterValue ?? vp.value) : null;
        if (value != null || PURCHASE_EVENT.test(ev) || LEAD_EVENT.test(ev) || /begin_checkout|add_to_cart|add_payment_info/.test(ev)) {
          push({ ...base, platform: 'GA4', account: unConst(P.measurementIdOverride || P.measurementId || ''), event: ev, label: ev, value });
        }
      } else if (t.fn === '__baut') push({ ...base, platform: 'Microsoft Ads (UET)', account: P.tagId, event: P.eventAction || P.eventType || 'event', label: P.eventAction, value: P.goalValue || P.revenueValue });
      else if (t.fn === '__pntr') push({ ...base, platform: 'Pinterest', account: P.tagId, event: P.eventName || 'event', label: P.eventName, value: P.value || P.orderValue });
      else if (t.fn.startsWith('__cvt_')) {
        if (!t.vendors.length || /consent|K8GSG/i.test(t.fn) || 'command' in P) continue;
        const ev = P.event || P.eventName || P.event_type || P.eventType || P.standardEventName || P.customEventName || 'event';
        const value = P.value ?? P.transactionValue ?? P.price ?? P.revenue ?? P.orderSubTotal ?? P.conversionValue ?? null;
        const acct = P.pixel_code || P.pixelCode || P.pixel_id || P.pixelId || P.partnerId || P.id || null;
        push({ ...base, platform: t.vendors[0], account: typeof acct === 'string' ? acct : null, event: String(ev), label: String(ev), value });
      } else if (t.fn === '__html' || t.fn === '__img') {
        const code = t.fn === '__html' ? String(P.html || '') : `<img src="${P.url || ''}">`;
        for (const c of callsInCode(code)) {
          if (/^(PageView|page_view|pageview|pageLoad|ViewContent)$/i.test(c.event) && !c.value) continue;
          push({ ...base, platform: c.platform, account: c.account || null, event: c.event, label: c.event, value: c.value, how: c.how });
        }
      }
    }
  }

  // Adobe Launch rules
  for (const r of launch?.rules || []) {
    const firing = [`Launch rule "${r.name}" (${r.events.map((e) => e.type).join(', ')})`];
    for (const a of r.actions || []) {
      for (const c of callsInCode(a.code)) {
        if (/^(PageView|page_view|pageview|pageLoad|ViewContent)$/i.test(c.event) && !c.value) continue;
        push({ container: 'Adobe Launch', tag: r.name, tagType: 'Custom code', paused: false, firing, blocking: [], platform: c.platform, account: c.account || null, event: c.event, label: c.event, value: c.value, how: c.how });
      }
      if (a.ext === 'adobe-analytics' && a.type === 'set-variables') {
        const evs = (a.settings?.trackerProperties?.events || []).map((e) => e.name).filter(Boolean);
        if (evs.length) push({ container: 'Adobe Launch', tag: r.name, tagType: 'Adobe Analytics', paused: false, firing, blocking: [], platform: 'Adobe Analytics', account: null, event: evs.join(', '), label: evs.join(','), value: null });
      }
    }
  }

  // ---- Flags ----
  for (const r of rows) {
    const trig = (r.firing || []).join(' | ');
    const vk = valueKind(r.value, r.variables);
    r.valueText = vk.text;
    const isPurchase = PURCHASE_EVENT.test(r.event) && !/^counter /.test(r.event);
    if (r.paused) r.flags.push(['paused', 'Paused']);
    if (!r.firing?.length && !r.paused) r.flags.push(['warn', 'No firing trigger']);
    if (vk.fixed != null) r.flags.push([vk.fixed <= 1 ? 'warn' : 'info', vk.fixed <= 1 ? `Fixed value ${vk.fixed} (counts conversions, not revenue)` : `Fixed value ${vk.fixed}`]);
    if (vk.scraped) r.flags.push(['warn', 'Value scraped from the page (breaks if the page layout changes)']);
    if (isPurchase && r.valueText === '—' && !r.counter && r.platform !== 'GA4') r.flags.push(['warn', 'No value sent (counted, not valued)']);
    if (/purchase/i.test(r.event) && r.firing?.length && !r.firing.some((f) => PURCHASE_TRIGGER.test(f))) r.flags.push(['bad', '"Purchase" fires on non-purchase steps']);
    if (r.firing?.length && !r.counter && r.platform !== 'GA4' && !/^(page_?visit|page_?view|view_?content|pageload|page)$/i.test(r.event)) {
      const pageOnly = r.firing.every((f) => { const ev = triggerEvents(f); return ev.length ? ev.every((e) => PAGE_EVENTS.test(e)) : /\(always\)/.test(f); });
      if (pageOnly && !r.firing.some((f) => PURCHASE_TRIGGER.test(f))) {
        const urls = [...new Set(r.firing.flatMap(urlConds))].slice(0, 3);
        r.flags.push(['bad', urls.length ? `Counts a page visit as a conversion (${urls.join(', ')})` : 'Fires on every page view']);
      }
    }
    r.triggerText = trig;
  }
  // Duplicates and overlaps
  const groups = {};
  for (const r of rows) {
    if (r.paused) continue;
    const trig = [...new Set(r.firing || [])].sort().join(' | ');
    (groups[`${r.platform}|${r.account}|${r.label}|${trig}`] ||= []).push(r);
    (groups[`overlap|${r.platform}|${r.account}|${trig}`] ||= []).push(r);
  }
  for (const [k, list] of Object.entries(groups)) {
    if (list.length < 2) continue;
    const exact = !k.startsWith('overlap|');
    for (const r of list) {
      const others = list.filter((x) => x !== r).map((x) => x.tag).join(', ');
      if (exact) r.flags.push(['bad', `Duplicate of ${others} (same event, same trigger)`]);
      else if (!r.flags.some((f) => f[1].startsWith('Duplicate')) && r.platform !== 'GA4' && !/^counter/.test(r.event) && (PURCHASE_EVENT.test(r.event) || LEAD_EVENT.test(r.event) || r.platform === 'Google Ads')) {
        r.flags.push(['info', `Same trigger as ${others} (different conversion); both may count`]);
      }
    }
  }
  rows.forEach((r) => delete r.variables);
  return rows;
}

export function conversionCsv(rows) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const out = [['Platform', 'Account', 'Event / Conversion', 'Value sent', 'Currency', 'Fires on', 'Container', 'Tag', 'Status', 'Flags']];
  for (const r of rows) out.push([r.platform, r.account, r.event, r.valueText, r.currency, r.triggerText, r.container, r.tag, r.paused ? 'Paused' : 'Active', r.flags.map((f) => f[1]).join('; ')]);
  return out.map((r) => r.map(cell).join(',')).join('\n');
}
