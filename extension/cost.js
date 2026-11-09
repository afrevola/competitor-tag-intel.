// What marketing and other third-party code costs a page: requests, bytes, JavaScript weight, timing.
import { detectVendors, channelOf } from './vendors.js';

const INFRA = [
  ['Google Tag Manager', /googletagmanager\.com\/gtm\.js/i, 'Tag management'],
  ['Google tag (gtag.js)', /googletagmanager\.com\/gtag\/js/i, 'Tag management'],
  ['Adobe Launch', /assets\.adobedtm\.com|\/launch-[a-z0-9]+(\.min)?\.js/i, 'Tag management'],
  ['Tealium', /tags\.tiqcdn\.com/i, 'Tag management'],
  ['Google Fonts', /fonts\.(googleapis|gstatic)\.com/i, 'Fonts & libraries'],
  ['Adobe Fonts', /use\.typekit\.net/i, 'Fonts & libraries'],
  ['Public JS CDN', /cdnjs\.cloudflare|cdn\.jsdelivr|unpkg\.com|code\.jquery|ajax\.googleapis/i, 'Fonts & libraries'],
  ['Site CDN / CMS assets', /cloudfront\.net|akamaihd|akamaized|fastly|ctfassets\.net|cloudinary|imgix|sanity\.io|cdn\.shopify|azureedge|b-cdn\.net|wp\.com|squarespace-cdn|wixstatic|storyblok|contentstack|prismic|edgekey|edgesuite/i, 'Site assets (CDN / CMS)'],
  ['Google Maps', /maps\.(googleapis|gstatic)\.com/i, 'Site features'],
  ['YouTube / Vimeo', /youtube\.com|ytimg\.com|vimeo/i, 'Site features'],
  ['Sentry', /sentry\.io|sentry-cdn/i, 'Site features'],
  ['Payments', /cybersource|cardconnect|stripe\.com|braintree|paypal|adyen|afterpay|cash\.app|pay\.google|applepay/i, 'Site features'],
  ['Auth', /okta|auth0|cognito/i, 'Site features'],
  ['Chat / support', /intercom|zendesk|livechat|drift\.com|salesforce-sites|liveperson/i, 'Site features'],
];

const site = (host) => {
  const p = String(host || '').split('.');
  const two = p.slice(-2).join('.');
  return /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(two) ? p.slice(-3).join('.') : two;
};
const isJs = (r) => r.type === 'script' || /\.m?js(\?|$)/i.test(r.u);
const kb = (b) => Math.round(b / 1024);

export function analyzeCost(page) {
  const res = page?.network?.resources || [];
  if (!res.length) return null;
  const own = site(page.host);
  const groups = {}; // vendor -> stats
  const tot = { first: blank(), marketing: blank(), infra: blank(), other3p: blank() };
  function blank() { return { requests: 0, bytes: 0, jsBytes: 0, hidden: 0, afterLoad: 0 }; }
  const load = page.network.timing?.load || null;

  for (const r of res) {
    let host = '';
    try { host = new URL(r.u).hostname; } catch { continue; }
    if (/^(data|blob):/.test(r.u)) continue;
    const bytes = r.transfer || r.encoded || 0;
    const first = site(host) === own;
    let vendor = null, channel = null, bucket;
    const infra = INFRA.find(([, re]) => re.test(r.u));
    const mk = detectVendors(host + new URL(r.u).pathname + ' ' + r.u.slice(0, 200))[0];
    if (mk) { vendor = mk; channel = channelOf(mk); bucket = 'marketing'; }
    else if (infra) { vendor = infra[0]; channel = infra[2]; bucket = infra[2] === 'Tag management' ? 'marketing' : 'infra'; }
    else if (first) { bucket = 'first'; vendor = 'First-party (' + own + ')'; channel = 'Site'; }
    else { bucket = 'other3p'; vendor = site(host); channel = 'Other third-party'; }
    // First-party hosts used as tracking proxies (e.g. metrics.brand.com/g/collect) count as marketing
    if (first && bucket === 'first' && /\/g\/collect|\/collect\?|\/b\/ss\/|\/tr\/?\?|\/events?\b|\/track/i.test(r.u)) { bucket = 'marketing'; vendor = 'First-party tracking endpoint'; channel = 'Analytics'; }

    const t = tot[bucket];
    t.requests++; t.bytes += bytes; if (isJs(r)) t.jsBytes += bytes;
    if (!bytes && !first) t.hidden++;
    if (load && r.start > load) t.afterLoad++;
    if (bucket !== 'first') {
      const g = (groups[vendor] ||= { vendor, channel, bucket, requests: 0, bytes: 0, jsBytes: 0, hidden: 0, maxDur: 0, hosts: new Set() });
      g.requests++; g.bytes += bytes; if (isJs(r)) g.jsBytes += bytes; if (!bytes) g.hidden++;
      g.maxDur = Math.max(g.maxDur, r.dur || 0); g.hosts.add(host);
    }
  }
  const all = Object.values(tot).reduce((a, t) => ({ requests: a.requests + t.requests, bytes: a.bytes + t.bytes, jsBytes: a.jsBytes + t.jsBytes }), { requests: 0, bytes: 0, jsBytes: 0 });
  const docBytes = page.network.timing?.docTransfer || page.network.timing?.docEncoded || 0;
  const vendors = Object.values(groups).map((g) => ({ ...g, hosts: [...g.hosts].slice(0, 4) }))
    .sort((a, b) => b.bytes - a.bytes || b.requests - a.requests);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  // If most non-marketing scripts hide their size, a JavaScript share would be misleading
  const otherScripts = res.filter((r) => isJs(r) && !detectVendors(r.u).length && !/googletagmanager|adobedtm|tiqcdn/.test(r.u));
  const hiddenOther = otherScripts.filter((r) => !(r.transfer || r.encoded)).length;
  const jsShareReliable = !otherScripts.length || hiddenOther / otherScripts.length < 0.3;
  return {
    totals: tot,
    all: { ...all, docBytes },
    shares: {
      marketingRequests: pct(tot.marketing.requests, all.requests),
      marketingBytes: pct(tot.marketing.bytes, all.bytes + docBytes),
      marketingJs: jsShareReliable ? pct(tot.marketing.jsBytes, all.jsBytes) : null,
      thirdPartyRequests: pct(tot.marketing.requests + tot.infra.requests + tot.other3p.requests, all.requests),
    },
    timing: page.network.timing || null,
    vendors,
    note: tot.marketing.hidden + tot.other3p.hidden
      ? `${tot.marketing.hidden + tot.other3p.hidden} third-party requests don't expose their size to the page (no Timing-Allow-Origin header), so byte totals are a minimum.`
      : null,
    fmt: { kb },
  };
}

export function costCsv(c) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Vendor', 'Channel', 'Requests', 'KB transferred', 'JS KB', 'Size hidden (requests)', 'Slowest request ms', 'Hosts']];
  for (const v of c.vendors) rows.push([v.vendor, v.channel, v.requests, kb(v.bytes), kb(v.jsBytes), v.hidden, v.maxDur, v.hosts.join(' ')]);
  return rows.map((r) => r.map(cell).join(',')).join('\n');
}
