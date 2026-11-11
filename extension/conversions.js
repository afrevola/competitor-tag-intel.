// Builds a per-platform conversion map from GTM containers and Adobe Launch rules,
// with flags for setups that mislead bidding or reporting.
import { decodeHit } from './pixels.js';
import { unwrapCode } from './vendors.js';
import { analyzeShopify } from './shopify.js';

const PURCHASE_EVENT = /purchase|complete|order|checkout_complete|booking_completed|transaction|\bsale\b|payment|paid|subscri/i;
const PURCHASE_TRIGGER = /purchase|complet|confirm|thank|order|success|paid|payment|transaction|receipt|booked/i;
const LEAD_EVENT = /lead|submit|sign_?up|subscribe|register|contact|form|request|schedule/i;
// Page loads, plus consent-banner events that fire on every page once consent is known
const PAGE_EVENTS = /^(gtm\.js|gtm\.dom|gtm\.load|gtm\.init|gtm\.init_consent|gtm\.historyChange|pageview|page_view|OneTrust\w*|Optanon\w*|cookiehub_\w+|cookiehub_\(ready\|modified\)|Cookiebot\w*|cookie_?consent\w*|consent_?(ready|update|given|loaded|default)\w*|CookieScript\w*|usercentrics\w*|didomi\w*|tcf\w*)$/i;
const triggerEvents = (f) => [...f.matchAll(/\{\{Event\}\} (?:equals|matches RegEx|contains) (\S+)/g)].map((m) => m[1]);
const urlConds = (f) => [...f.replace(/NOT \([^)]*\)\)?/g, '').matchAll(/\{\{(?:Page (?:Url|URL|Path|Host)|Custom JS #\d+)\}\} (?:contains|equals|matches RegEx|starts with) (\S+)/g)].map((m) => m[1]).filter((x) => !/^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+\/?$|staging|\bdev\b|^(true|false|undefined|null|\d+)$/i.test(x)); // skip bare host / environment checks

const CALL_FNS = { fbq: 'Meta Pixel', snaptr: 'Snapchat', pintrk: 'Pinterest', rdt: 'Reddit', twq: 'Twitter / X', clq: 'Clinch', oaiq: 'OpenAI (oaiq)', qp: 'Quora', ndp: 'Nextdoor', lintrk: 'LinkedIn', spdt: 'Spotify Ads', saq: 'StackAdapt' };
const VALUE_IN_OBJ = /(?:^|[,{\s])["']?(value|price|revenue|conv_value|event_value|revenue_value|amount|total|tw_sale_amount|gv)["']?\s*:\s*([^,}\n]+)/;

function valueFromObj(obj) {
  if (!obj) return null;
  const m = obj.match(VALUE_IN_OBJ);
  if (!m) return null;
  const v = m[2].trim().replace(/^parseFloat\((.*)\)$/, '$1');
  // A bare variable name (value: r) is computed in the code; quoted text is kept as written
  if (/^[A-Za-z_$][\w$.]*$/.test(v) && !/^(true|false|null|undefined)$/.test(v)) return `{{code variable ${v}}}`;
  return v.replace(/^["']|["']$/g, '');
}

// Find tracking calls in custom code (GTM Custom HTML or Launch custom code)
const stripComments = (code) => String(code || '')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');

export function callsInCode(code) {
  const all = rawCalls(stripComments(unwrapCode(code)));
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
  while ((m = generic.exec(code))) {
    // fbq("trackSingle", "<pixel id>", "Event", {…}): the second argument is the pixel
    if (m[2] === 'trackSingle' || m[2] === 'trackSingleCustom') {
      const ts = code.slice(m.index).match(/^\w+\(\s*["']trackSingle(?:Custom)?["']\s*,\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']\s*(?:,\s*(\{[^}]*\}))?/);
      if (ts) { out.push({ platform: CALL_FNS[m[1]], account: ts[1], event: ts[2], value: valueFromObj(ts[3]), how: `${m[1]}("trackSingle")` }); continue; }
    }
    out.push({ platform: CALL_FNS[m[1]], event: m[3], value: valueFromObj(m[4] || code.slice(m.index, m.index + 400)), how: `${m[1]}("${m[2]}")` });
  }
  // Impact: ire("trackConversion", <action tracker id>, {…})
  const ire = /\bire\(\s*["']trackConversion["']\s*,\s*["']?(\d+)/g;
  while ((m = ire.exec(code))) out.push({ platform: 'Impact', event: 'sale (action tracker ' + m[1] + ')', value: valueFromObj(code.slice(m.index, m.index + 600).replace(/orderSubTotal\w*|orderTotal/, 'value')), how: 'ire trackConversion' });
  const ttq = /ttq\.track\(\s*["']([^"']+)["']\s*(?:,\s*(\{[^}]*\}))?/g;
  while ((m = ttq.exec(code))) out.push({ platform: 'TikTok', event: m[1], value: valueFromObj(m[2]), how: 'ttq.track' });
  // gtag("event", "conversion" | "purchase" | …, { send_to: "AW-…/label" | "DC-…/group/activity+counting" })
  const gtagConv = /gtag\(\s*["']event["']\s*,\s*["']([\w-]+)["']\s*,\s*(\{[^}]*\})/g;
  while ((m = gtagConv.exec(code))) {
    const to = ((m[2].match(/send_to["']?\s*:\s*["']([^"']+)/) || [])[1] || '').trim();
    if (!/^(AW|DC)-/.test(to) && m[1] !== 'conversion') continue;
    const dc = /^DC-/.test(to);
    const label = to.split('/').slice(1).join('/');
    out.push({ platform: dc ? 'Floodlight / CM360' : 'Google Ads', account: to.split('/')[0] || null, event: dc ? `${/\+(transactions|items_sold)/.test(label) ? 'sales' : 'counter'} ${label}` : `${m[1] === 'conversion' ? 'conversion' : m[1]} ${label}`.trim(), value: valueFromObj(m[2]), how: `gtag ${m[1]}` });
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
  // Image pixels inside HTML, or built in JavaScript (new Image().src = "https://…")
  const img = /(?:<img[^>]+src=|\.src\s*=\s*)["'](https?:\/\/[^"']+)["']/gi;
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

export function buildConversionMap({ gtm = [], launch = null, page = null }) {
  const rows = [];
  const push = (r) => rows.push({ flags: [], ...r });

  // Shopify app pixels (fired by Shopify on its standard customer events)
  for (const c of analyzeShopify(page)?.conversions || []) {
    push({ container: 'Shopify', tag: c.platform === 'Google Ads' || c.platform === 'GA4' ? 'Google & YouTube app' : c.platform + ' app', tagType: 'Shopify app pixel', paused: false, firing: [`{{Event}} equals ${c.shopifyEvent}`], blocking: [], shopifyApp: true, ...c });
  }

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
  // Accounts configured in Launch's "Google Global Site Tag (gtag)" extension: key -> { type, id, name }
  const gtagAccounts = {};
  for (const e of launch?.extensions || []) {
    for (const [k, v] of Object.entries(e.settings?.accounts || {})) {
      const id = v?.accounts?.production || v?.accounts?.staging || null;
      if (id) gtagAccounts[k] = { type: v.type, id, name: v.name || '' };
    }
  }
  // Launch rule triggers written like GTM triggers, so the same flags apply
  const launchFiring = (r) => {
    const ev = r.events.map((e) => {
      const st = e.settings || {};
      if (/datalayerPushListener|dataLayerPush|customEvent/i.test(e.type) && (st.eventKey || st.eventName || st.type)) return `{{Event}} equals ${st.eventKey || st.eventName || st.type}`;
      if (/libraryLoaded|pageBottom|domReady|windowLoaded/i.test(e.type)) return '{{Event}} equals gtm.js';
      if (/directCall/i.test(e.type)) return `{{Event}} equals ${st.identifier || 'direct call'}`;
      return e.type;
    });
    // Privacy opt-out checks (Global Privacy Control, Do Not Track) are noted, not treated as triggers
    const privacy = r.conditions.filter((c) => /%(GPC|DoNotTrack|DNT)%/i.test(String(c.settings?.leftOperand || '')));
    const conds = r.conditions.filter((c) => !privacy.includes(c)).map((c) => {
      const st = c.settings || {};
      if (c.type === 'valueComparison') {
        const left = String(st.leftOperand || '').replace(/^%Page (Path|URL|Url)%$/, '{{Page $1}}').replace(/^\{\{Page Url\}\}$/, '{{Page URL}}');
        const op = { equals: 'equals', contains: 'contains', startsWith: 'starts with', matchesRegex: 'matches RegEx', doesNotEqual: 'does not equal' }[st.comparison?.operator] || st.comparison?.operator;
        return `${left} ${op} ${st.rightOperand}`;
      }
      return c.type + (c.negate ? ' (not)' : '');
    });
    return [ev.join(' or ') + (conds.length ? ' AND ' + conds.join(' AND ') : '') + (privacy.length ? ' (skipped for GPC / Do Not Track opt-outs)' : '')];
  };
  for (const r of launch?.rules || []) {
    for (const a of r.actions || []) {
      if (!/gtag/i.test(a.ext || '') || a.type !== 'event') continue;
      const st = a.settings || {};
      const opts = Object.fromEntries((st.options || []).filter((o) => Array.isArray(o)));
      for (const [k, acc] of Object.entries(st.accounts || {})) {
        if (acc && acc.enabled === false) continue;
        const A = gtagAccounts[k] || {};
        const label = acc?.label || '';
        const base = { container: 'Adobe Launch', tag: r.name, tagType: 'gtag extension', paused: false, firing: launchFiring(r), blocking: [], how: 'Launch gtag extension', accountName: A.name };
        if (A.type === 'dc' || /^DC-/.test(A.id || '')) {
          const [act, counting] = label.split('+');
          const sales = /transactions|items_sold/i.test(counting || '');
          push({ ...base, platform: 'Floodlight / CM360', account: A.id, event: `${sales ? 'sales' : 'counter'} ${act}${counting ? ' (' + counting + ')' : ''}`, label: act, value: sales ? opts.value ?? null : null, counter: !sales, counting });
        } else if (A.type === 'aw' || /^AW-/.test(A.id || '')) {
          push({ ...base, platform: 'Google Ads', account: A.id, event: `${st.name || 'conversion'} (${label})`, label, value: opts.value ?? null, currency: opts.currency, newCustomer: 'new_customer' in opts });
        } else if (/^G-/.test(A.id || '')) {
          push({ ...base, platform: 'GA4', account: A.id, event: st.name || 'event', label: st.name, value: opts.value ?? null });
        }
      }
    }
  }
  for (const r of launch?.rules || []) {
    const firing = [`Launch rule "${r.name}" (${r.events.map((e) => e.type).join(', ')})`];
    for (const a of r.actions || []) {
      // Code that waits for an order-confirmation message fires on the purchase itself, whatever the rule's trigger
      const code = unwrapCode(a.code || '');
      const waitsForOrder = /addEventListener\(\s*["']message["']/.test(code) && /order|purchas|transaction/i.test(code);
      for (const c of callsInCode(a.code)) {
        if (/^(PageView|page_view|pageview|pageLoad|ViewContent)$/i.test(c.event) && !c.value) continue;
        push({ container: 'Adobe Launch', tag: r.name, tagType: 'Custom code', paused: false, firing: waitsForOrder ? [`${firing[0]}, on an order-confirmation message (purchase)`] : firing, blocking: [], platform: c.platform, account: c.account || null, event: c.event, label: c.event, value: c.value, how: c.how });
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
    // Google Ads events are just "conversion <label>", so judge them by what triggers them
    const evText = /^conversion /.test(r.event) ? (r.firing || []).flatMap(triggerEvents).join(' ') : r.event;
    const isPurchase = PURCHASE_EVENT.test(evText) && !/^counter /.test(r.event);
    if (/company_?size|employees|industry|annual_?revenue|seniority|job_?(title|level)|lead_?score|is_?qualified/i.test(trig)) r.flags.push(['info', 'Counts only leads that match firmographic rules (company size, industry or similar): a lead-quality filter']);
    if (/\{\{(Page Query|Page URL|Page Url)\}\}[^|]*brand/i.test(trig)) r.flags.push(['info', 'Only for visitors arriving from brand-search ads']);
    if (r.paused) r.flags.push(['paused', 'Paused']);
    if (!r.firing?.length && !r.paused) r.flags.push(['warn', 'No firing trigger']);
    if (/^<[^>]+>$|\{\{\s*\w+\s*\}\}$|^%\w+%$|^\$\{/.test(String(r.value ?? '')) && !/^\{\{(Constant|Custom JS|DLV|dlv)/.test(String(r.value))) r.flags.push(['bad', `Sends a template placeholder (${r.value}) instead of a real value`]);
    if (vk.fixed != null) r.flags.push([vk.fixed <= 1 ? 'warn' : 'info', vk.fixed <= 1 ? `Fixed value ${vk.fixed} (counts conversions, not revenue)` : `Fixed value ${vk.fixed}`]);
    if (vk.scraped) r.flags.push(['warn', 'Value scraped from the page (breaks if the page layout changes)']);
    if (isPurchase && r.valueText === '—' && !r.counter && r.platform !== 'GA4') r.flags.push(['warn', 'No value sent (counted, not valued)']);
    if (/purchase/i.test(r.event) && r.firing?.length && !r.firing.some((f) => PURCHASE_TRIGGER.test(f))) r.flags.push(['bad', '"Purchase" fires on non-purchase steps']);
    if (r.shopifyApp && r.platform === 'Google Ads' && !/purchase/.test(r.shopifyEvent)) r.flags.push(['info', `Google Ads conversion on "${r.shopifyEvent}" (created by Shopify's Google & YouTube app; usually secondary, so check before reading it as a bidding goal)`]);
    if (r.shopifyApp) { r.triggerText = trig; continue; }
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
  // The same conversion set up in two containers that both load: it can fire once per container
  const byConv = {};
  for (const r of rows) {
    if (r.paused || !r.label || r.container === 'Shopify') continue;
    (byConv[`${r.platform}|${r.account}|${r.label}|${r.event}`] ||= []).push(r);
  }
  for (const list of Object.values(byConv)) {
    const conts = [...new Set(list.map((r) => r.container))];
    if (conts.length < 2) continue;
    for (const r of list) r.flags.push(['bad', `Also set up in ${conts.filter((c) => c !== r.container).join(', ')}; both load on this page, so it may count twice`]);
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
