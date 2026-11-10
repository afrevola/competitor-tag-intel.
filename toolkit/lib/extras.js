// Pull add-ons: live experiments, messaging, landing pages & campaign structure, reviews & social
// profiles from structured data, language versions and the site's footprint by section.

const flat = (x, out = []) => {
  if (Array.isArray(x)) x.forEach((y) => flat(y, out));
  else if (x && typeof x === 'object') { out.push(x); if (x['@graph']) flat(x['@graph'], out); for (const v of Object.values(x)) if (v && typeof v === 'object') flat(v, out); }
  return out;
};
const typeOf = (o) => [].concat(o['@type'] || []).join(',');

// Experiment names also show up in data layer pushes from testing tools
function dataLayerExperiments(dataLayers = []) {
  const out = [];
  const seen = new Set();
  for (const dl of dataLayers) {
    for (const e of dl.entries || []) {
      if (!e || typeof e !== 'object') continue;
      const s = JSON.stringify(e);
      if (!/experiment|variant|variation|ab_?test|split_?test|test_?name/i.test(s)) continue;
      const name = e.experiment_name || e.experimentName || e.exp_name || e.test_name || e.testName || e.campaign_name || e.experiment_id || e.exp_variant_string || e.event;
      const variant = e.variant_name || e.variantName || e.variation_name || e.variationName || e.variant || e.variation || null;
      const key = `${name}|${variant}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({ tool: 'data layer', name: String(name).slice(0, 80), variant: variant ? String(variant).slice(0, 60) : null });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

// A path segment that marks a landing page: exactly "lp", "landing", "go", "campaigns"…, or starting "lp-", "landing-", "ppc-"…
const LP_SEG = /^(lp|lps|landing|landing-?pages?|go|campaigns?|ppc|sem|paid|ads|try|get-started|welcome)$|^(lp|landing|ppc|sem|campaign|paid)[-_]/i;
const LP = { test: (p) => !/^\/?(blogs?|news|articles?|stories)\//i.test(p) && String(p).split('/').some((seg) => LP_SEG.test(seg)) };

export function analyzeExtras(cap, conversionRows = []) {
  const page = cap.page || {};
  const promos = cap.promos || {};

  // ---- experiments
  const experiments = [...(page.experiments || []), ...dataLayerExperiments(page.dataLayers)];

  // ---- messaging (homepage or the page that was pulled)
  // Drop navigation and housekeeping buttons from the calls to action
  const messaging = page.messaging ? { ...page.messaging, ctas: (page.messaging.ctas || []).filter((c) => !/^(skip|close|menu|search|open|toggle|previous|next|prev|back|more|less|clear|view all|×|x)\b|skip to|cart|sign ?in|log ?in|account|profile|orders?$|language|currency|country|accept|reject|cookie|\d+ items?|^\d/i.test(c)) } : null;

  // ---- structured data: ratings, social profiles, organization
  const objs = flat(page.structured || []);
  for (const p of promos.pages || []) if (p.ld) flat(p.ld, objs);
  const ratings = [];
  const seenR = new Set();
  for (const o of objs) {
    const r = o.aggregateRating;
    if (!r || !r.ratingValue) continue;
    const key = `${o.name}|${r.ratingValue}|${r.reviewCount || r.ratingCount}`;
    if (seenR.has(key)) continue;
    seenR.add(key);
    ratings.push({ name: String(o.name || typeTypeName(o)).slice(0, 60), type: typeOf(o), rating: Number(r.ratingValue), count: Number(r.reviewCount || r.ratingCount || 0) || null, best: Number(r.bestRating || 5) });
    if (ratings.length >= 12) break;
  }
  const org = objs.find((o) => /Organization|Corporation|LocalBusiness|Store|Restaurant|SoftwareApplication|Brand/.test(typeOf(o)) && (o.sameAs || o.name));
  const social = [...new Set(objs.flatMap((o) => [].concat(o.sameAs || [])).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)))].slice(0, 20);
  const appOffers = objs.filter((o) => /SoftwareApplication|MobileApplication/.test(typeOf(o)) && o.offers).map((o) => ({ name: o.name, offers: [].concat(o.offers).map((f) => `${f.priceCurrency || ''} ${f.price ?? ''}`.trim()).slice(0, 4) }));

  // ---- language / country versions
  const locales = [...new Set((page.hreflang || []).map(([h]) => h).filter((h) => h && h !== 'x-default'))];

  // ---- site footprint from the sitemap
  const paths = (promos.sitemapPaths || []).map((x) => x.split('\t')[0]);
  const sections = {};
  for (const p of paths) {
    const seg = (p.split('/').filter(Boolean)[0] || '(home)').toLowerCase();
    sections[seg] = (sections[seg] || 0) + 1;
  }
  const footprint = {
    sitemapUrls: promos.sitemapUrlCount || 0,
    sampled: paths.length,
    sections: Object.entries(sections).sort((a, b) => b[1] - a[1]).slice(0, 15),
  };

  // ---- landing pages & campaign structure
  const lpPaths = paths.filter((p) => LP.test(p));
  const lpFolders = {};
  for (const p of lpPaths) {
    const segs = p.split('/').filter(Boolean);
    const i = segs.findIndex((s) => LP_SEG.test(s));
    const folder = '/' + segs.slice(0, Math.max(1, i + 1)).join('/') + '/';
    lpFolders[folder] = (lpFolders[folder] || 0) + 1;
  }
  const hiddenLp = [...new Set((promos.robots?.disallow || []).filter((d) => LP.test(d)))].slice(0, 15);
  // Campaign names and URL patterns that tags check for
  const tokens = new Map();
  for (const r of conversionRows) {
    for (const f of r.firing || []) {
      for (const m of String(f).matchAll(/\{\{(?:Page Query|Page URL|Page Url|[^}]*utm[^}]*|[^}]*campaign[^}]*)\}\} (?:contains|matches RegEx|equals|starts with) ([^\s|)]+(?:\|[^\s|)]+)*)/gi)) {
        const v = m[1];
        if (/^\^?https?:|\.(com|net|org|io|co)\b/.test(v) || v.length < 3) continue;
        if (!tokens.has(v)) tokens.set(v, new Set());
        tokens.get(v).add(r.platform);
      }
    }
  }
  const campaignTokens = [...tokens.entries()].map(([t, ps]) => ({ token: t.slice(0, 80), platforms: [...ps] })).slice(0, 20);

  return {
    experiments,
    messaging,
    ratings,
    organization: org ? { name: org.name || null, type: typeOf(org) } : null,
    social,
    appOffers,
    locales,
    footprint,
    landingPages: { count: lpPaths.length, folders: Object.entries(lpFolders).sort((a, b) => b[1] - a[1]).slice(0, 12), examples: lpPaths.slice(0, 15), hiddenFromSearch: hiddenLp },
    campaignTokens,
  };
}
function typeTypeName(o) { return typeOf(o) || 'item'; }

// What changed in the add-ons between two reports
export function diffExtras(A = {}, B = {}) {
  const out = [];
  // Only compare what both pulls recorded (older pulls predate these fields)
  if (!A.messaging && !(A.experiments || []).length) return '';
  const ma = A.messaging || {}, mb = B.messaging || {};
  if ((ma.h1 || []).join(' | ') !== (mb.h1 || []).join(' | ') && (mb.h1 || []).length) out.push(`- **Headline:** "${(ma.h1 || []).join(' | ') || '—'}" → "${(mb.h1 || []).join(' | ')}"`);
  if ((ma.title || '') !== (mb.title || '') && mb.title) out.push(`- **Page title:** "${ma.title || '—'}" → "${mb.title}"`);
  if ((ma.announcement || '') !== (mb.announcement || '') && (ma.announcement || mb.announcement)) out.push(`- **Announcement bar:** "${ma.announcement || '—'}" → "${mb.announcement || '—'}"`);
  const so = (x) => (x.signupOffers || []).join('; ');
  if (so(ma) !== so(mb)) out.push(`- **Sign-up offer:** "${so(ma) || '—'}" → "${so(mb) || '—'}"`);
  const ctaA = new Set(ma.ctas || []), ctaB = new Set(mb.ctas || []);
  const newCta = [...ctaB].filter((c) => !ctaA.has(c)), goneCta = [...ctaA].filter((c) => !ctaB.has(c));
  if (newCta.length || goneCta.length) out.push(`- **Calls to action:** ${newCta.length ? 'new ' + newCta.slice(0, 8).map((c) => `"${c}"`).join(', ') : ''}${newCta.length && goneCta.length ? '; ' : ''}${goneCta.length ? 'removed ' + goneCta.slice(0, 8).map((c) => `"${c}"`).join(', ') : ''}`);
  const ex = (x) => new Set((x.experiments || []).map((e) => `${e.tool}: ${e.name}`));
  const ea = ex(A), eb = ex(B);
  for (const e of eb) if (!ea.has(e)) out.push(`- **New experiment:** ${e}`);
  for (const e of ea) if (!eb.has(e)) out.push(`- **Experiment ended or hidden:** ${e}`);
  const ra = new Map((A.ratings || []).map((r) => [r.name, r])), rb = new Map((B.ratings || []).map((r) => [r.name, r]));
  for (const [n, r] of rb) { const o = ra.get(n); if (o && (o.rating !== r.rating || o.count !== r.count)) out.push(`- **Rating, ${n}:** ${o.rating} (${o.count ?? '?'} reviews) → ${r.rating} (${r.count ?? '?'} reviews)`); }
  const la = new Set(A.locales || []), lb = new Set(B.locales || []);
  const newL = [...lb].filter((l) => !la.has(l));
  if (newL.length) out.push(`- **New language / country versions:** ${newL.join(', ')}`);
  return out.length ? '## Messaging, experiments & reviews\n\n' + out.join('\n') : '';
}
