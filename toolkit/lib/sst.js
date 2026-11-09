// Looks for client-side fingerprints of server-side / first-party tracking setups.

const GOOGLE_HOST = /(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|google\.com|google\.[a-z.]+|doubleclick\.net|googleadservices\.com|googlesyndication\.com|gstatic\.com)$/i;

const SST_VENDORS = [
  [/stape\.(io|net)|\.stape\./i, 'Stape (hosted server-side GTM)'],
  [/taggrs/i, 'TAGGRS (hosted server-side GTM)'],
  [/addingwell/i, 'Addingwell (hosted server-side GTM)'],
  [/jentis/i, 'JENTIS (server-side tracking)'],
  [/api\.segment\.io|cdn\.segment\.com/i, 'Segment (CDP, forwards events server-side)'],
  [/rudderstack|rudderlabs/i, 'RudderStack (CDP)'],
  [/mparticle\.com/i, 'mParticle (CDP, forwards events server-side)'],
  [/hightouch/i, 'Hightouch (CDP / reverse ETL)'],
  [/collect\.tealiumiq\.com/i, 'Tealium EventStream (server-side)'],
  [/edge\.adobedc\.net/i, 'Adobe Experience Platform Edge (Web SDK; can forward server-side)'],
  [/metarouter/i, 'MetaRouter (server-side)'],
  [/snowplow/i, 'Snowplow'],
  [/freshpaint/i, 'Freshpaint'],
  [/elevar/i, 'Elevar (server-side for Shopify)'],
];

const COLLECT_PATH = /\/(g\/collect|j\/collect|mp\/collect|collect|tr|event|events|track|b\/ss\/|ee\/v\d|i\/adsct)\b/i;

function site(host) {
  const p = host.split('.');
  const two = p.slice(-2).join('.');
  return /^(co|com|org|net|gov|ac|ne)\.[a-z]{2}$/.test(two) ? p.slice(-3).join('.') : two;
}

const short = (u) => (u.length > 160 ? u.slice(0, 157) + '…' : u);

export function analyzeServerSide(page, gtm, launch) {
  const F = [];
  const add = (signal, verdict, detail, evidence = []) =>
    F.push({ signal, verdict, detail, evidence: [...new Set(evidence.map(short))].slice(0, 8) });

  const urls = page.network.urls.map((u) => { try { return new URL(u); } catch { return null; } }).filter(Boolean);
  const own = site(page.host);
  const isOwn = (u) => site(u.hostname) === own;

  // 1. Google tag / GTM loaded from a non-Google host
  const fpLoaders = [...page.network.scripts, ...page.network.urls].filter((u) => {
    try {
      const x = new URL(u);
      return /^(GTM|G|AW|DC)-/i.test(x.searchParams.get('id') || '') && !GOOGLE_HOST.test(x.hostname);
    } catch { return false; }
  });
  if (fpLoaders.length) add('Google tags loaded first-party', 'yes', 'GTM / gtag.js is served from the brand’s own domain or a proxy, the hallmark of server-side GTM or Google tag gateway.', fpLoaders);
  else add('Google tags loaded first-party', 'no', 'GTM / gtag.js load directly from googletagmanager.com.');

  // 2. Where GA4 hits go
  const ga4 = urls.filter((u) => /^G-/.test(u.searchParams.get('tid') || '') && (/\/g\/collect$/.test(u.pathname) || (/\/collect$/.test(u.pathname) && u.searchParams.get('v') === '2')));
  const ga4Other = ga4.filter((u) => !GOOGLE_HOST.test(u.hostname));
  if (ga4Other.length) add('GA4 hits routed through a server', 'yes', `GA4 events are sent to ${[...new Set(ga4Other.map((u) => u.hostname))].join(', ')} instead of Google, so a server container receives them first.`, ga4Other.map(String));
  else if (ga4.length) add('GA4 hits routed through a server', 'no', `${ga4.length} GA4 hit(s) seen, all sent straight to Google.`);
  else add('GA4 hits routed through a server', 'info', 'No GA4 hits observed on this page load.');

  // 3. Server container URLs configured in GTM
  for (const c of gtm) {
    if (c.data?.serverUrls?.length) add(`${c.id} config: server container URL`, 'yes', 'The Google tag in this container is configured to send data to a server container.', c.data.serverUrls);
    else if (c.data?.serverUrlViaVariable) add(`${c.id} config: server container URL`, 'likely', 'A server container / transport URL is set via a variable.');
  }

  // 4. Cookies set by server-side GTM
  if (page.network.cookies.includes('FPLC')) add('Server-set GA cookies (FPLC)', 'yes', 'The FPLC cookie is set by server-side GTM to issue a first-party GA client ID (FPID itself is HttpOnly and invisible to the page).');

  // 5. Meta: Conversions API signals
  const fb = urls.filter((u) => /facebook\.com$/.test(u.hostname) && u.pathname.startsWith('/tr'));
  const fbEid = fb.filter((u) => u.searchParams.get('eid'));
  const capig = urls.filter((u) => /capig/i.test(u.hostname + u.pathname));
  const fbProxy = urls.filter((u) => isOwn(u) && /\/tr\/?$/.test(u.pathname) && u.searchParams.get('ev'));
  if (capig.length) add('Meta Conversions API Gateway', 'yes', 'Requests go to a Meta CAPI Gateway endpoint.', capig.map(String));
  if (fbProxy.length) add('Meta Pixel proxied first-party', 'yes', 'Meta Pixel events are sent to the brand’s own domain.', fbProxy.map(String));
  if (fbEid.length) add('Meta Conversions API (dedup event IDs)', 'likely', `${fbEid.length} of ${fb.length} Meta Pixel hits carry an event ID. Event IDs exist to de-duplicate browser events against server-side Conversions API events.`, fbEid.map(String));
  else if (fb.length) add('Meta Conversions API (dedup event IDs)', 'no', `${fb.length} Meta Pixel hit(s) seen without event IDs on this page. Check a conversion page to be sure.`);

  // 6. Google Ads enhanced conversions / hashed user data
  const ecUrls = urls.filter((u) => /googleadservices\.com|google\.com|doubleclick\.net/.test(u.hostname) && (u.searchParams.get('em') || /[;&]em=/.test(u.search)));
  const ecGtm = gtm.filter((c) => c.data?.enhancedConversions).map((c) => c.id);
  if (ecUrls.length || ecGtm.length) add('Google Ads enhanced conversions', 'yes', 'Hashed customer data (email/phone) is sent with Google Ads conversions.', [...ecGtm.map((id) => `${id}: user-provided-data / enhanced conversion tags`), ...ecUrls.map(String)]);

  // 7. TikTok Events API dedup
  const ttDedup = gtm.flatMap((c) => (c.data?.tags || []).filter((t) => t.vendors?.includes('TikTok') && /event_?id/i.test(JSON.stringify(t.params))).map((t) => `${c.id} tag #${t.id}`));
  if (ttDedup.length) add('TikTok Events API (dedup event IDs)', 'likely', 'TikTok tags pass an event ID, used to de-duplicate against server-side Events API events.', ttDedup);

  // 8. Adobe Analytics / Web SDK collection endpoints
  const aa = urls.filter((u) => /\/b\/ss\//.test(u.pathname));
  if (aa.length) {
    const hosts = [...new Set(aa.map((u) => u.hostname))];
    const fp = hosts.filter((h) => site(h) === own);
    add('Adobe Analytics tracking server', fp.length ? 'yes' : 'info', fp.length
      ? `Adobe Analytics hits go to a first-party CNAME (${fp.join(', ')}), which keeps cookies first-party and survives some ad blockers.`
      : `Adobe Analytics hits go to ${hosts.join(', ')}.`, aa.map(String));
  }
  const webSdk = urls.filter((u) => /\/ee\/(v\d|[a-z]+\/v\d)\//.test(u.pathname) || /adobedc\.net/.test(u.hostname));
  if (webSdk.length) add('Adobe Experience Platform Web SDK', 'yes', 'Data goes to the Adobe Edge Network, which can forward it server-side (Event Forwarding).', webSdk.map(String));
  if (launch?.extensions?.some((e) => /event forwarding|conversions api|server/i.test(e.name))) {
    add('Launch server-side extensions', 'yes', 'Adobe Launch has a server-side related extension installed.', launch.extensions.filter((e) => /event forwarding|conversions api|server/i.test(e.name)).map((e) => e.name));
  }

  // 9. Known server-side / CDP vendors
  for (const [re, name] of SST_VENDORS) {
    const ev = [...page.network.urls, ...page.network.scripts].filter((u) => re.test(u));
    if (ev.length) add(name, 'yes', 'This vendor’s endpoints were seen on the page.', ev);
  }

  // 10. Other first-party collection endpoints
  const fpCollect = urls.filter((u) => isOwn(u) && u.hostname !== page.host && COLLECT_PATH.test(u.pathname));
  if (fpCollect.length) add('First-party collection endpoints', 'info', 'Requests to the brand’s own subdomains on tracking-style paths. Worth a look: often a proxy or server container.', fpCollect.map(String));

  return F;
}
