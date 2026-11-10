// Pulls ad-platform account / pixel IDs out of containers, tag code and network traffic,
// and builds links to each platform's public ad library.

const CODE_PATTERNS = [
  ['Meta Pixel', /fbq\(\s*['"]init['"]\s*,\s*['"](\d{10,20})['"]/g],
  ['TikTok', /ttq\.load\(\s*['"]([A-Z0-9]{15,25})['"]/g],
  ['Snapchat', /snaptr\(\s*['"]init['"]\s*,\s*['"]([0-9a-f-]{36})['"]/g],
  ['Pinterest', /pintrk\(\s*['"]load['"]\s*,\s*['"](\d{8,16})['"]/g],
  ['LinkedIn', /_linkedin_partner_id\s*=\s*["']?(\d{4,10})/g],
  ['Microsoft Ads (UET)', /\bti\s*:\s*["']?(\d{5,10})["']?/g],
  ['Reddit', /rdt\(\s*['"]init['"]\s*,\s*['"]([A-Za-z0-9_]+)['"]/g],
  ['Twitter / X', /twq\(\s*['"](?:init|config)['"]\s*,\s*['"]([a-z0-9]{4,10})['"]/g],
  ['AdRoll / NextRoll', /adroll_adv_id\s*=\s*["']([A-Z0-9]{10,30})["']/g],
  ['Microsoft Clarity', /["']clarity["']\s*,\s*["']script["']\s*,\s*["']([a-z0-9]{6,15})["']/g],
  ['Hotjar', /hjid\s*:\s*(\d{5,10})/g],
  ['The Trade Desk', /adsrvr\.org[^"'\s]*[?&]adv=([a-z0-9]{5,12})/gi],
  ['Floodlight / CM360', /src=(\d{6,9});type=/g],
  ['Google Ads', /\b(AW-\d{8,12})\b/g],
  ['GA4', /\b(G-[A-Z0-9]{8,12})\b/g],
  ['Quora', /qp\(\s*['"]init['"]\s*,\s*['"]([a-f0-9]{32})['"]/g],
  ['Nextdoor', /ndp\(\s*['"]init['"]\s*,\s*['"]([0-9a-f-]{20,40})['"]/g],
  ['Spotify Ads', /spdt\(\s*['"]conf['"]\s*,\s*\{\s*key\s*:\s*['"]([a-f0-9]{20,40})['"]/g],
  ['StackAdapt', /saq\(\s*['"](?:ts|conv|rt)['"]\s*,\s*['"]([A-Za-z0-9]{10,30})['"]/g],
  ['Criteo', /criteo[\s\S]{0,200}?account\s*:\s*["']?(\d{3,8})/gi],
];

const URL_PATTERNS = [
  ['Meta Pixel', /facebook\.com\/tr\/?\?(?:[^#]*&)?id=(\d{10,20})/],
  ['Meta Pixel', /connect\.facebook\.net\/signals\/config\/(\d{10,20})/],
  ['TikTok', /analytics\.tiktok\.com\/i18n\/pixel\/events\.js\?(?:[^#]*&)?sdkid=([A-Z0-9]{15,25})/],
  ['Snapchat', /snapchat\.com\/p\?(?:[^#]*&)?pid=([0-9a-f-]{36})/],
  ['Microsoft Ads (UET)', /bat\.bing\.com\/action\/0\?(?:[^#]*&)?ti=(\d{5,10})/],
  ['LinkedIn', /px\.ads\.linkedin\.com\/collect\/?\?(?:[^#]*&)?pid=(\d{4,10})/],
  ['Reddit', /alb\.reddit\.com\/rp\.gif\?(?:[^#]*&)?id=([A-Za-z0-9_]+)/],
  ['Pinterest', /ct\.pinterest\.com\/v3\/?\?(?:[^#]*&)?tid=(\d{8,16})/],
  ['AdRoll / NextRoll', /adroll\.com\/(?:pixel|pex|ipixel|consent\/check|segment)\/([A-Z0-9]{10,30})/],
  ['The Trade Desk', /adsrvr\.org\/track\/[^?]+\?(?:[^#]*&)?adv=([a-z0-9]{5,12})/],
  ['Floodlight / CM360', /doubleclick\.net\/activityi?;(?:[^?#]*;)?src=(\d{6,9})/],
  ['Google Ads', /\/pagead\/(?:conversion|viewthroughconversion|1p-conversion)\/(\d{8,12})/],
  ['Google Ads', /[?&]tid=(AW-\d{8,12})/],
  ['Floodlight / CM360', /[?&]tid=(DC-\d{6,9})/],
  ['GA4', /[?&]tid=(G-[A-Z0-9]{8,12})/],
  ['Microsoft Clarity', /clarity\.ms\/tag\/([a-z0-9]{6,15})/],
  ['Hotjar', /static\.hotjar\.com\/c\/hotjar-(\d{5,10})/],
  ['Twitter / X', /static\.ads-twitter\.com\/uwt\.js|[?&]txn_id=([a-z0-9]{4,10})/],
  ['Beeswax', /bidr\.io\/[^?]*\?(?:[^#]*&)?buzz_key=([a-z0-9_-]+)/i],
  ['Basis', /sitescout\.com\/iap\/([a-f0-9]{10,20})/],
  ['Viant', /ipredictive\.com\/[^?]*\?(?:[^#]*&)?upid=(\d+)/],
];

const norm = (platform, id) => {
  if (!id) return null;
  id = String(id).trim();
  const c = id.match(/^\{\{Constant "([^"]+)"\}\}$/);
  if (c) id = c[1];
  if (platform === 'Google Ads' && /^\d+$/.test(id)) return 'AW-' + id;
  if (platform === 'Floodlight / CM360' && /^\d+$/.test(id)) return 'DC-' + id;
  if (/\{\{|\}\}/.test(id)) return null; // variable reference, not a literal ID
  return id;
};

import { analyzeShopify } from './shopify.js';

export function extractAccountIds({ page, gtm = [], launch = null, extraUrls = [] }) {
  const out = new Map(); // platform -> Map(id -> Set(source))
  const add = (platform, id, source) => {
    id = norm(platform, id);
    if (!id) return;
    if (!out.has(platform)) out.set(platform, new Map());
    const m = out.get(platform);
    if (!m.has(id)) m.set(id, new Set());
    m.get(id).add(source);
  };
  const scanCode = (code, source) => {
    if (!code) return;
    for (const [platform, re] of CODE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        if (platform === 'Microsoft Ads (UET)' && !/uetq|bat\.bing/.test(code)) break;
        add(platform, m[1], source);
      }
    }
  };

  // Container IDs found on the page
  for (const c of page?.containers || []) {
    if (/^AW-/.test(c.id)) add('Google Ads', c.id, 'Google tag on page');
    else if (/^DC-/.test(c.id)) add('Floodlight / CM360', c.id, 'Google tag on page');
    else if (/^G-/.test(c.id)) add('GA4', c.id, 'Google tag on page');
    else if (/^GTM-/.test(c.id)) add('Google Tag Manager', c.id, 'on page');
  }

  // GTM tags
  for (const { id: cid, data } of gtm) {
    if (!data) continue;
    for (const t of data.tags) {
      const src = `${cid} tag #${t.id}`;
      const P = t.params;
      if (t.fn === '__googtag') { const v = String(P.tagId || ''); add(/^AW-/.test(v) ? 'Google Ads' : /^DC-/.test(v) ? 'Floodlight / CM360' : 'GA4', v, src); }
      if (t.fn === '__gaawe' || t.fn === '__gaawc') add('GA4', P.measurementIdOverride || P.measurementId, src);
      if (['__awct', '__sp', '__awud', '__awcc'].includes(t.fn)) add('Google Ads', P.conversionId, src);
      if (t.fn === '__flc' || t.fn === '__fls') add('Floodlight / CM360', P.advertiserId, src);
      if (t.fn === '__bzi') add('LinkedIn', P.id || P.partnerId, src);
      if (t.fn === '__baut') add('Microsoft Ads (UET)', P.tagId, src);
      if (t.fn === '__pntr') add('Pinterest', P.tagId, src);
      if (t.fn === '__hjtc') add('Hotjar', P.hotjar_site_id || P.siteId, src);
      if (t.fn.startsWith('__cvt_') && t.vendors?.length) {
        const v = t.vendors[0];
        const acct = P.pixel_code || P.pixelCode || P.pixel_id || P.pixelId || P.pixelIds || P.partnerId || P.id;
        (Array.isArray(acct) ? acct : [acct]).forEach((a) => add(v, typeof a === 'object' ? Object.values(a || {})[0] : a, src));
      }
      if (t.fn === '__html') scanCode(String(P.html || ''), src);
      if (t.fn === '__img') scanUrl(String(P.url || ''), src);
    }
  }

  // Adobe Launch custom code
  for (const r of launch?.rules || []) {
    for (const a of r.actions || []) scanCode(a.code, `Launch rule "${r.name}"`);
  }

  // Shopify app pixels
  for (const [platform, id, source] of analyzeShopify(page)?.ids || []) add(platform, id, source);

  // Network traffic (page load, plus a recording if there is one)
  function scanUrl(u, source) {
    for (const [platform, re] of URL_PATTERNS) {
      const m = u.match(re);
      if (m && m[1]) add(platform, m[1], source);
    }
  }
  for (const u of [...(page?.network?.urls || []), ...(page?.network?.scripts || [])]) scanUrl(u, 'network');
  for (const u of extraUrls) scanUrl(u, 'recording');

  return [...out.entries()].map(([platform, m]) => ({
    platform,
    ids: [...m.entries()].map(([id, s]) => ({ id, sources: [...s] })),
  })).sort((a, b) => a.platform.localeCompare(b.platform));
}

// Registrable domain and a best-guess brand name for ad-library searches
export function siteBrand(host) {
  const parts = String(host || '').replace(/^www\./, '').split('.');
  const two = parts.slice(-2).join('.');
  const domain = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(two) ? parts.slice(-3).join('.') : two;
  return { domain, brand: domain.split('.')[0] };
}

export function adLibraryLinks({ domain, brand }, platforms) {
  const q = encodeURIComponent(brand);
  const has = (re) => platforms.some((p) => re.test(p));
  const links = [
    { name: 'Meta Ad Library', url: `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${q}&search_type=keyword_unordered&media_type=all`, relevant: has(/Meta/) },
    { name: 'Google Ads Transparency', url: `https://adstransparency.google.com/?region=US&domain=${encodeURIComponent(domain)}`, relevant: has(/Google Ads|Floodlight/) },
    { name: 'LinkedIn Ad Library', url: `https://www.linkedin.com/ad-library/search?accountOwner=${q}`, relevant: has(/LinkedIn/) },
    { name: 'TikTok Ad Library (EU/UK ads only)', url: `https://library.tiktok.com/ads?region=all&adv_name=${q}&sort_type=last_shown_date,desc`, relevant: has(/TikTok/) },
  ];
  return links;
}
