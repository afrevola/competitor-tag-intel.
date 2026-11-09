// Vendor fingerprints for tag code, template params and URLs, with the marketing channel each belongs to.

export const CHANNELS = [
  'Search', 'Social', 'Programmatic', 'CTV / TV', 'Retargeting', 'Affiliate & Partners',
  'Attribution', 'CDP & Data', 'Email & CRM', 'Analytics', 'Testing & Personalization',
  'Session Replay & UX', 'Surveys & Reviews', 'Consent', 'Other',
];

// [name, regex, channel]
export const VENDORS = [
  ['Meta Pixel', /fbq\(|connect\.facebook\.net|facebook\.com\/tr/i, 'Social'],
  ['TikTok', /ttq\.|analytics\.tiktok\.com|tiktok/i, 'Social'],
  ['Snapchat', /snaptr|sc-static\.net|tr\d?\.snapchat/i, 'Social'],
  ['Pinterest', /pintrk|ct\.pinterest|s\.pinimg\.com\/ct/i, 'Social'],
  ['Reddit', /rdt\(|redditstatic|alb\.reddit/i, 'Social'],
  ['LinkedIn', /lintrk|_linkedin_partner|snap\.licdn|px\.ads\.linkedin/i, 'Social'],
  ['Twitter / X', /twq\(|static\.ads-twitter|analytics\.twitter|t\.co\/i\/adsct|t\.co\/1\/i\/adsct/i, 'Social'],
  ['Nextdoor', /\bndp\(|ads\.nextdoor/i, 'Social'],
  ['Quora', /\bqp\(\s*['"]|quora/i, 'Social'],
  ['Spotify Ads', /byspotify|spdt\(/i, 'Social'],
  ['Google Ads', /googleadservices|googleads\.g\.doubleclick|\/pagead\/(conversion|viewthroughconversion)|gtag\(\s*['"]event['"]\s*,\s*['"]conversion/i, 'Search'],
  ['Microsoft Ads (UET)', /bat\.bing|uetq/i, 'Search'],
  ['Floodlight / CM360', /fls\.doubleclick|ad\.doubleclick\.net\/activity/i, 'Programmatic'],
  ['The Trade Desk', /adsrvr\.org|ttd_dom_ready/i, 'Programmatic'],
  ['Amazon Ads', /amazon-adsystem|apstag|amzn_/i, 'Programmatic'],
  ['Yahoo DSP', /analytics\.yahoo|s\.yimg\.com\/wi|\bdotq\b/i, 'Programmatic'],
  ['Epsilon / Conversant', /dotomi|conversantmedia|epsilon\.com/i, 'Programmatic'],
  ['StackAdapt', /\bsaq\(|stackadapt/i, 'Programmatic'],
  ['Quantcast', /quantserve|qcCmd/i, 'Programmatic'],
  ['Viant', /ipredictive|viant/i, 'Programmatic'],
  ['AcuityAds', /acuityAds|acuityplatform|\baap\(/i, 'Programmatic'],
  ['Simpli.fi', /simpli\.fi/i, 'Programmatic'],
  ['Basis', /basis\.net|cntrUpTag|sitescout/i, 'Programmatic'],
  ['Beeswax', /bidr\.io/i, 'Programmatic'],
  ['Blis', /blis(media)?\.com/i, 'Programmatic'],
  ['SpringServe', /springserve/i, 'Programmatic'],
  ['Intent IQ', /intentiq/i, 'Programmatic'],
  ['Taboola', /taboola/i, 'Programmatic'],
  ['Outbrain', /outbrain/i, 'Programmatic'],
  ['Clinch', /clinch\.co|\bclq\(/i, 'Programmatic'],
  ['MNTN', /dx\.mountain|mntn/i, 'CTV / TV'],
  ['tvScientific', /tvscientific|pix\.pub/i, 'CTV / TV'],
  ['Innovid', /innovid/i, 'CTV / TV'],
  ['TVSquared', /tvsquared/i, 'CTV / TV'],
  ['EDO', /edoinc|lighthouse\.edo/i, 'CTV / TV'],
  ['iSpot', /ispot\.tv/i, 'CTV / TV'],
  ['Podsights', /podsights|pdst\.fm/i, 'CTV / TV'],
  ['AdRoll / NextRoll', /adroll|nextroll/i, 'Retargeting'],
  ['Criteo', /criteo/i, 'Retargeting'],
  ['Rakuten', /rakuten|linksynergy/i, 'Affiliate & Partners'],
  ['Impact', /impactcdn|impact\.com|\bire\(\s*['"]/i, 'Affiliate & Partners'],
  ['CJ Affiliate', /emjcd|\.cj\.com/i, 'Affiliate & Partners'],
  ['Accretive Media', /accretivemedia|go2cloud\.org/i, 'Affiliate & Partners'],
  ['trkn.us', /trkn\.us/i, 'Affiliate & Partners'],
  ['Northbeam', /northbeam/i, 'Attribution'],
  ['Triple Whale', /triplewhale|triplepixel/i, 'Attribution'],
  ['GA Connector', /gaconnector/i, 'Attribution'],
  ['Hightouch', /htevents|hightouch/i, 'CDP & Data'],
  ['Segment', /segment\.(com|io)|analytics\.(track|identify|page)\(/i, 'CDP & Data'],
  ['mParticle', /mparticle/i, 'CDP & Data'],
  ['LiveRamp', /liveramp|rlcdn/i, 'CDP & Data'],
  ['ZoomInfo', /zoominfo|zi-scripts/i, 'CDP & Data'],
  ['Emarsys', /scarab|emarsys/i, 'Email & CRM'],
  ['Salesforce', /igodigital|evergage|exacttarget|salesforce/i, 'Email & CRM'],
  ['Klaviyo', /klaviyo/i, 'Email & CRM'],
  ['Braze', /braze|appboy/i, 'Email & CRM'],
  ['Attentive', /attn\.tv|attentive/i, 'Email & CRM'],
  ['HubSpot', /hs-scripts|hubspot/i, 'Email & CRM'],
  ['Adobe Analytics', /\/b\/ss\/|AppMeasurement|\bs\.t\(\)|\bs\.tl\(/i, 'Analytics'],
  ['Amplitude', /amplitude\.com/i, 'Analytics'],
  ['Datadog RUM', /datadoghq|DD_RUM/i, 'Session Replay & UX'],
  ['Hotjar', /hotjar/i, 'Session Replay & UX'],
  ['Microsoft Clarity', /clarity\.ms|\bclarity\(/i, 'Session Replay & UX'],
  ['FullStory', /fullstory/i, 'Session Replay & UX'],
  ['Quantum Metric', /quantummetric/i, 'Session Replay & UX'],
  ['Contentsquare', /contentsquare/i, 'Session Replay & UX'],
  ['Dynamic Yield', /dynamicyield/i, 'Testing & Personalization'],
  ['Optimizely', /optimizely/i, 'Testing & Personalization'],
  ['VWO', /visualwebsiteoptimizer|_vwo_/i, 'Testing & Personalization'],
  ['Adobe Target', /tt\.omtrdc\.net|adobe-target|\bmbox\b/i, 'Testing & Personalization'],
  ['Medallia', /medallia|kampyle/i, 'Surveys & Reviews'],
  ['Qualtrics', /qualtrics/i, 'Surveys & Reviews'],
  ['OneTrust', /onetrust|optanon|cookielaw/i, 'Consent'],
  ['Cookiebot', /cookiebot/i, 'Consent'],
  ['OpenAI (oaiq)', /oaiq/i, 'Other'],
];

const CHANNEL_OF = Object.fromEntries(VENDORS.map(([n, , c]) => [n, c]));
// Built-in GTM tag types and other names that don't come from regex detection
Object.assign(CHANNEL_OF, {
  'Google Ads': 'Search', 'GA4': 'Analytics', 'Google Analytics 4': 'Analytics', 'Floodlight / CM360': 'Programmatic',
  'Adobe Analytics': 'Analytics', 'Adobe Target': 'Testing & Personalization',
});
export const channelOf = (name) => CHANNEL_OF[name] || 'Other';

// Gallery template parameters that identify a vendor even when no URL is present.
const PARAM_HINTS = [
  ['TikTok', /"pixel_code"|"pixelCode"/],
  ['LinkedIn', /"partnerId"/],
  ['Meta Pixel', /"pixelIds?"/],
  ['Snapchat', /"pixel_id".*"event_type"|"event_type".*"pixel_id"/],
  ['Reddit', /"id":"[at]2_[a-z0-9]+"|"dataProcessingOptions".*"eventType"|"eventType".*"dataProcessingOptions"/],
];

export function detectVendors(text, { params = false } = {}) {
  if (!text) return [];
  const found = new Set();
  for (const [name, re] of VENDORS) if (re.test(text)) found.add(name);
  if (params) for (const [name, re] of PARAM_HINTS) if (re.test(text)) found.add(name);
  return [...found];
}

// Fingerprints that hint at which agency holding company or trading desk buys the media.
export const AGENCY_SIGNALS = [
  ['Dentsu (incl. Amnet / Merkle)', /dentsu|amnet|merkle/i],
  ['WPP Media (GroupM, Xaxis, Wavemaker, Mindshare)', /xaxis|groupm|wavemaker|mindshare|essencemediacom|choreograph/i],
  ['Publicis (Epsilon, Starcom, Spark, Zenith)', /epsilon|conversant|dotomi|starcom|sparkfoundry|spark-foundry|zenithmedia|publicis/i],
  ['Omnicom (Accuen, OMD, PHD, Hearts & Science)', /accuen|annalect|omnicom|\bomd\b|hearts-?and-?science/i],
  ['IPG Mediabrands (Cadreon, UM, Initiative)', /cadreon|mediabrands|magnaglobal|initiative\.com/i],
  ['Horizon Media', /horizonmedia|horizonnext/i],
  ['Havas', /havas/i],
  ['Accretive Media', /accretivemedia/i],
];
