#!/usr/bin/env node
// Tag Intel CLI: turns browser captures into per-site reports and multi-site comparisons.
//
//   node intel.js extract  <part files...> [-o capture.json] [--expect domain]   reassemble a packed capture
//   node intel.js analyze  <capture.json> [-o outdir]             report.json + report.md for one site
//   node intel.js compare  <report.json ...> [-o outdir]          comparison.md / .csv / .html across sites
//   node intel.js recording <recording-file ...> [-o outdir]      analyze a funnel recording (recorder-dump.js output)
//   node intel.js store    <capture.json[.gz]> --root <dir> [--date YYYY-MM-DD]   save a dated pull + update the index
//   node intel.js index    --root <dir>                           rebuild index.json / INDEX.md from saved pulls
//   node intel.js diff     <old report.json> <new report.json> [-o changes.md]   what changed between two pulls
import fs from 'fs';
import path from 'path';
import { parseContainer } from './lib/parser.js';
import { buildConversionMap } from './lib/conversions.js';
import { extractAccountIds, siteBrand, adLibraryLinks } from './lib/ids.js';
import { buildMediaMix } from './lib/mediamix.js';
import { analyzeServerSide } from './lib/sst.js';
import { analyzePromos } from './lib/promos.js';
import { analyzeCost } from './lib/cost.js';
import { analyzeShopify } from './lib/shopify.js';
import { analyzeOptimization, summarizeFlags } from './lib/optimize.js';
import { extractPricing } from './lib/pricing.js';
import { analyzeExtras, diffExtras } from './lib/extras.js';
import { analyzeRecording, recordingCsv } from './lib/recording.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, dflt) => { const i = rest.indexOf(name); if (i < 0) return dflt; const v = rest[i + 1]; rest.splice(i, 2); return v; };
const die = (m) => { console.error(m); process.exit(1); };
const readJson = (f) => { const b = fs.readFileSync(f); return JSON.parse(/\.gz$/.test(f) || (b[0] === 0x1f && b[1] === 0x8b) ? zlib.gunzipSync(b).toString('utf8') : b.toString('utf8')); };

// ---------- extract ----------
import zlib from 'zlib';
function readToolText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try { const j = JSON.parse(raw); const arr = Array.isArray(j) ? j : [j]; const t = arr.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n'); if (t) return t; } catch {}
  return raw;
}
// Reassemble a packed capture from one or more saved tool outputs (parts can be in any order)
function extractPacked(files, tag, expect = null) {
  // Group parts by capture ID so parts from different captures (or tabs) can never be mixed
  const caps = {};
  const re = new RegExp('__' + tag + '_PART_(\\d+)_OF_(\\d+)(?:_ID_([A-Za-z0-9]+)_HOST_([^_\\s]*))?__([A-Za-z0-9+/=]+)__' + tag + '_PART_END__', 'g');
  for (const f of files) {
    const t = readToolText(f);
    for (const m of t.matchAll(re)) {
      const id = m[3] || 'legacy';
      const c = (caps[id] ||= { host: m[4] || null, total: +m[2], parts: {}, files: new Set() });
      c.parts[+m[1]] = m[5];
      c.files.add(f);
    }
  }
  let ids = Object.keys(caps);
  if (!ids.length) return { error: 'no parts found' };
  const norm = (h) => String(h || '').replace(/^www\./, '');
  if (expect) {
    const wrong = ids.filter((id) => caps[id].host && !norm(caps[id].host).endsWith(norm(expect)));
    ids = ids.filter((id) => !wrong.includes(id));
    if (!ids.length) return { error: `these files hold a capture of ${wrong.map((id) => caps[id].host).join(', ')}, not ${expect}. The tab was showing a different site: open a new tab, check location.host, and capture again.` };
  }
  const complete = ids.filter((id) => Object.keys(caps[id].parts).length === caps[id].total);
  if (!complete.length) {
    const c = caps[ids[0]];
    const missing = [...Array(c.total).keys()].filter((i) => !(i in c.parts));
    return { error: `missing part(s) ${missing.join(', ')} of ${c.total}${c.host ? ' (capture of ' + c.host + ')' : ''}. In the same browser tab run __tiPart(${missing[0]})${missing.length > 1 ? ' … __tiPart(' + missing[missing.length - 1] + ')' : ''} and pass every saved file to extract.` };
  }
  if (complete.length > 1) console.error(`note: ${complete.length} complete captures in these files; using the last one (${caps[complete[complete.length - 1]].host || 'unknown host'}).`);
  const c = caps[complete[complete.length - 1]];
  const buf = Buffer.from([...Array(c.total).keys()].map((i) => c.parts[i]).join(''), 'base64');
  const data = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  if (expect && data.page?.host && !norm(data.page.host).endsWith(norm(expect)) && !norm(data.url || '').includes(norm(expect))) return { error: `capture is of ${data.page.host}, not ${expect}` };
  return { data };
}
function extractMarked(file, begin, end) {
  const raw = fs.readFileSync(file, 'utf8');
  const candidates = [raw];
  // Tool results are often saved as [{type, text}] where text is a JSON-encoded string
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : [j];
    for (const x of arr) if (x && typeof x.text === 'string') candidates.unshift(x.text);
  } catch {}
  for (let t of candidates) {
    for (let pass = 0; pass < 3; pass++) {
      const a = t.indexOf(begin), b = t.lastIndexOf(end);
      if (a >= 0 && b > a) {
        const inner = t.slice(a + begin.length, b);
        try { return JSON.parse(inner); } catch {}
        try { return JSON.parse(JSON.parse('"' + inner + '"')); } catch {}
      }
      // Unwrap one level of JSON string encoding and try again
      const s = t.trim().replace(/\n\n\(captured at origin[\s\S]*$/, '').replace(/\n\nTab Context:[\s\S]*$/, '');
      try { const u = JSON.parse(s); if (typeof u === 'string') { t = u; continue; } } catch {}
      break;
    }
  }
  return null;
}

// ---------- analyze ----------
function dataLayerSummary(page) {
  const out = [];
  for (const L of page.dataLayers || []) {
    if (L.kind !== 'array') { out.push({ name: L.name, kind: 'object', keys: Object.keys(L.snapshot || {}).slice(0, 30) }); continue; }
    const ev = {};
    for (const e of L.entries || []) {
      const name = e && typeof e === 'object' ? (e.event || (Array.isArray(e.gtag) ? 'gtag:' + e.gtag[0] : null)) : null;
      if (!name) continue;
      const x = (ev[name] ||= { count: 0, keys: new Set() });
      x.count++;
      Object.keys(e).forEach((k) => k !== 'event' && k !== 'gtm.uniqueEventId' && x.keys.add(k));
    }
    out.push({ name: L.name, kind: 'array', pushes: (L.entries || []).length, events: Object.entries(ev).map(([n, x]) => ({ event: n, count: x.count, keys: [...x.keys].slice(0, 25) })) });
  }
  return out;
}

function analyze(cap) {
  const page = cap.page;
  const gtm = [];
  const containerSummary = [];
  for (const [id, text] of Object.entries(cap.containers || {})) {
    if (!text) { containerSummary.push({ id, error: 'not downloaded' }); continue; }
    try {
      const data = parseContainer(text);
      gtm.push({ id, data });
      const active = data.tags.filter((t) => t.category === 'tag' && !t.paused);
      containerSummary.push({
        id, version: data.version, activeTags: active.length, pausedTags: data.tags.filter((t) => t.paused).length,
        triggers: data.triggers.length, variables: data.variables.length,
        tagTypes: Object.entries(active.reduce((m, t) => ((m[t.type] = (m[t.type] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 15),
      });
    } catch (e) { containerSummary.push({ id, error: e.message }); }
  }
  const launch = page.launch || null;
  const conversions = buildConversionMap({ gtm, launch, page });
  const accountIds = extractAccountIds({ page, gtm, launch });
  const mediaMix = buildMediaMix({ page, gtm, launch });
  const serverSide = analyzeServerSide(page, gtm, launch);
  const promos = cap.promos && !cap.promos.error ? analyzePromos(cap.promos, new Date(cap.capturedAt)) : null;
  const cost = analyzeCost(page);
  const shopify = analyzeShopify(page);
  const optimization = analyzeOptimization(conversions, gtm);
  const flagSummary = summarizeFlags(conversions);
  const pricing = cap.promos?.pages ? extractPricing(cap.promos.pages) : [];
  const extras = analyzeExtras(cap, conversions);
  const { domain, brand } = siteBrand(page.host);
  const libraries = adLibraryLinks({ domain, brand }, accountIds.map((p) => p.platform).concat(mediaMix.channels.flatMap((c) => c.vendors.map((v) => v.name))));
  if (cost) delete cost.fmt;
  return {
    site: domain, url: page.url, host: page.host, capturedAt: cap.capturedAt,
    tagManagers: [...new Set([...(gtm.length ? ['Google Tag Manager'] : []), ...(launch ? ['Adobe Launch'] : []), ...(shopify?.pixels.length ? ['Shopify customer events (app pixels)'] : [])])],
    shopify,
    optimization,
    pricing,
    extras,
    containers: containerSummary,
    googleTags: page.containers.filter((c) => !/^GTM-/.test(c.id)).map((c) => c.id),
    launch: launch ? { property: launch.property, built: launch.buildInfo?.buildDate || null, rules: launch.rules.length, dataElements: launch.dataElements.length, extensions: launch.extensions.map((e) => e.name) } : null,
    mediaMix, accountIds, adLibraries: libraries,
    conversions: {
      active: conversions.filter((r) => !r.paused).length,
      flagged: conversions.filter((r) => r.flags.some((f) => f[0] === 'bad' || f[0] === 'warn')).length,
      flagSummary,
      byPlatform: Object.entries(conversions.filter((r) => !r.paused).reduce((m, r) => ((m[r.platform] = (m[r.platform] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]),
      rows: conversions.map((r) => ({ platform: r.platform, account: r.account, event: r.event, value: r.valueText, currency: r.currency || null, firesOn: r.firing, source: `${r.container} ${r.tag}`, paused: r.paused, flags: r.flags.map((f) => f[1]) })),
    },
    serverSide: serverSide.filter((f) => f.verdict === 'yes' || f.verdict === 'likely'),
    dataLayers: dataLayerSummary(page),
    consent: { cookiesAtLoad: page.network.cookies || [] },
    promos, cost,
  };
}

// ---------- markdown ----------
const md = {
  table(head, rows) {
    const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    return `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n` + rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n') + '\n';
  },
};
const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round((b || 0) / 1024) + ' KB');

function reportMd(R) {
  let s = `# ${R.site}: marketing & tag intel\n\nCaptured ${R.capturedAt} from ${R.url}\n\n`;
  s += `## Snapshot\n\n` + md.table(['', ''], [
    ['Tag management', R.tagManagers.join(', ') || 'none found'],
    ['Containers', R.containers.map((c) => c.error ? `${c.id} (${c.error})` : `${c.id} v${c.version}: ${c.activeTags} active tags, ${c.pausedTags} paused`).join('; ') || '—'],
    ['Adobe Launch', R.launch ? `${R.launch.property}, ${R.launch.rules} rules, built ${String(R.launch.built || '').slice(0, 10)}` : '—'],
    ['Marketing vendors', `${R.mediaMix.total} across ${R.mediaMix.channels.length} channels`],
    ['Read', R.mediaMix.notes.join('; ') || '—'],
    ['Agency signals', R.mediaMix.agencies.map((a) => a.name).join(', ') || 'none'],
    ['Optimizes to', R.optimization?.headline || '—'],
    ['Headline', R.extras?.messaging?.h1?.[0] || R.extras?.messaging?.title || '—'],
    ['Experiments running', R.extras?.experiments?.length ? R.extras.experiments.slice(0, 4).map((e) => `${e.tool}: ${e.name}`).join('; ') + (R.extras.experiments.length > 4 ? ` (+${R.extras.experiments.length - 4})` : '') : 'none visible'],
    ['Ratings', R.extras?.ratings?.length ? R.extras.ratings.slice(0, 2).map((r) => `${r.name}: ${r.rating}/${r.best}${r.count ? ` (${r.count.toLocaleString('en-US')} reviews)` : ''}`).join('; ') : '—'],
    ['Pricing', R.pricing?.length ? R.pricing.slice(0, 2).map((pg) => pg.tiers.slice(0, 5).map((t) => `${t.name} ${t.price}${t.unit ? '/' + t.unit.replace(/ \/ /g, '/') : ''}`).join(', ')).join(' · ') : 'no pricing page read'],
    ['Conversion tags', `${R.conversions.active} active, ${R.conversions.flagged} flagged`],
    ['Server-side signals', R.serverSide.map((f) => f.signal).join('; ') || 'none detected'],
    ['Promos', R.promos ? `${R.promos.offers.filter((o) => o.status === 'active').length} active, ${R.promos.offers.filter((o) => o.status === 'upcoming').length} upcoming; fiscal tags: ${R.promos.fiscalPeriods.join(', ') || '—'}` : 'not scanned'],
    ['Tracking cost', R.cost ? `${R.cost.shares.marketingRequests}% of requests, ${kb(R.cost.totals.marketing.jsBytes)} of tracking JavaScript${R.cost.shares.marketingJs != null ? ` (${R.cost.shares.marketingJs}% of all JS)` : ''}` : '—'],
  ]);
  const X = R.extras || {};
  if (X.messaging) {
    const M = X.messaging;
    s += `\n## Messaging\n\n` + md.table(['', ''], [
      ['Page title', M.title || '—'],
      ['Description', (M.description || '—').slice(0, 200)],
      ['Headline (H1)', (M.h1 || []).join(' | ') || '—'],
      ['Subheads (H2)', (M.h2 || []).slice(0, 8).join(' | ') || '—'],
      ['Calls to action', (M.ctas || []).slice(0, 15).join(' · ') || '—'],
      ['Announcement bar', M.announcement || '—'],
      ['Sign-up / first-order offer', (M.signupOffers || []).join('; ') || 'none found in the page'],
    ]);
  }
  if (X.experiments?.length) s += `\n## Experiments running\n\n` + md.table(['Tool', 'Test', 'Variant this visit saw'], X.experiments.map((e) => [e.tool, e.name, e.variant || '—']));
  s += `\n## Media mix\n\n` + md.table(['Channel', 'Vendors'], R.mediaMix.channels.map((c) => [c.channel, c.vendors.map((v) => v.name).join(', ')]));
  if (R.mediaMix.syncPartners?.length) s += `\n_Cookie-sync partners (ID-matching pixels fired by their ad vendors; not bought directly): ${R.mediaMix.syncPartners.join(', ')}._\n`;
  if (R.mediaMix.agencies.length) s += `\n**Agency signals**\n\n` + R.mediaMix.agencies.map((a) => `- **${a.name}**: ${a.evidence[0]}`).join('\n') + '\n';
  s += `\n## Ad accounts & pixel IDs\n\n` + md.table(['Platform', 'IDs'], R.accountIds.map((p) => [p.platform, p.ids.map((i) => i.id).join(', ')]));
  s += `\nAd libraries: ` + R.adLibraries.map((l) => `[${l.name}](${l.url})`).join(' · ') + '\n';
  if (R.optimization?.platforms?.length) {
    const O = R.optimization;
    s += `\n## What they optimize to\n\n**${O.headline.charAt(0).toUpperCase() + O.headline.slice(1)}.**\n\n`;
    s += md.table(['Platform', 'Main goal', 'All goals (count, with value)', 'Values sent', 'Who counts'], O.platforms.map((p) => [
      p.platform + (p.accounts.length ? ` (${p.accounts.slice(0, 3).join(', ')}${p.accounts.length > 3 ? ', …' : ''})` : ''),
      p.mainGoal,
      p.goals.map((g) => `${g.goal}: ${g.count}${g.withValue ? ` (${g.withValue} valued)` : ''}`).join('; '),
      p.values.join(', ') || 'none',
      p.filters.join('; ') || 'everyone',
    ]));
    if (O.helpers.length) s += `\n**Custom code behind these conversions**\n\n` + O.helpers.map((h) => `- \`${h.variable}\` (${h.container}, used by ${h.usedBy.join(', ')}): ${h.meaning || 'see code'}. \`${h.code.slice(0, 160)}\``).join('\n') + '\n';
  }
  s += `\n## Conversions\n\n` + md.table(['Platform', 'Active tags'], R.conversions.byPlatform);
  if (R.conversions.flagSummary?.length) s += `\n**Flags at a glance**\n\n` + R.conversions.flagSummary.slice(0, 12).map(([f, n]) => `- ${n} × ${f}`).join('\n') + '\n';
  const flaggedAll = R.conversions.rows.filter((r) => r.flags.length && !r.paused);
  const flagged = flaggedAll.slice(0, 40);
  if (flaggedAll.length > flagged.length) s += `\n_Showing ${flagged.length} of ${flaggedAll.length} flagged conversions; all are in report.json._\n`;
  if (flagged.length) s += `\n**Flagged**\n\n` + md.table(['Platform', 'Event', 'Value sent', 'Flags', 'Source'], flagged.map((r) => [r.platform, r.event.slice(0, 60), String(r.value).slice(0, 50), r.flags.join('; '), r.source]));
  if (R.shopify) {
    const Sh = R.shopify;
    s += `\n## Shopify\n\nStore ${Sh.shop || '—'}${Sh.theme?.schema ? ` · theme ${Sh.theme.schema}${Sh.theme.name && Sh.theme.name !== Sh.theme.schema ? ` ("${Sh.theme.name}")` : ''}` : ''}${Sh.currency ? ` · ${Sh.currency}` : ''}. Pixels set up inside Shopify fire on Shopify's standard customer events (page view, product view, add to cart, checkout, purchase); purchase values come from the order.\n\n`;
    if (Sh.pixels.length) s += md.table(['App pixel', 'Data use', 'Events sent'], Sh.pixels.map((p) => [p.app, (p.purposes || []).join(', ').toLowerCase() || '—', p.events.length ? [...new Set(p.events)].join(', ') : 'Shopify standard events']));
    const conv = R.conversions.rows.filter((r) => /^Shopify/.test(r.source) && r.platform !== 'GA4');
    if (conv.length) s += `\n**Conversions from Shopify app pixels**\n\n` + md.table(['Platform', 'Account', 'Event', 'Value sent'], conv.map((r) => [r.platform, r.account || '', r.event, r.value || '—']));
    if (Sh.apps.length) s += `\n**Theme app embeds:** ${Sh.apps.map((a) => a.vendor ? `${a.vendor} (${a.handle})` : a.handle).join(', ')}\n`;
  }
  if (R.serverSide.length) s += `\n## Server-side / first-party tracking\n\n` + R.serverSide.map((f) => `- **${f.signal}** (${f.verdict}): ${f.detail}${f.evidence[0] ? ` — e.g. \`${f.evidence[0].slice(0, 120)}\`` : ''}`).join('\n') + '\n';
  if (R.promos) {
    const P = R.promos;
    if (R.pricing?.length) {
      s += `\n## Pricing\n\n`;
      for (const pg of R.pricing) {
        s += `**${pg.title || pg.url}** (${pg.url})\n\n` + md.table(['Plan / option', 'Price', 'Per'], pg.tiers.map((t) => [t.name, t.price, t.unit || '—']));
        if (pg.alsoOn?.length) pg.notes.push(`same table on ${pg.alsoOn.length} more page${pg.alsoOn.length > 1 ? 's' : ''}`);
        if (pg.notes.length) s += `\n_${pg.notes.join(' · ')}_\n`;
        s += '\n';
      }
    }
    s += `\n## Promos & campaigns\n\nRead ${P.pagesRead} promo pages (${P.candidates} candidates; sitemap has ${P.sitemapUrlCount} URLs).\n\n`;
    if (P.sitewidePrices?.length) s += `_Left out of the table: ${P.sitewidePrices.join(', ')} ${P.sitewidePrices.length > 1 ? 'appear' : 'appears'} on most pages read (site-wide text such as a free-shipping threshold, or standard prices)._\n\n`;
    if (P.offers.length) s += md.table(['Offer', 'Status', 'Dates', 'Prices', 'Restriction', 'URL'], P.offers.map((o) => [o.name + (o.copies > 1 ? ` (×${o.copies}${o.variants ? ': ' + o.variants.slice(0, 6).join(', ') + (o.variants.length > 6 ? ', …' : '') : ''})` : ''), o.status, o.start || o.end ? `${o.start || '…'} → ${o.end || '…'}` : '', [...o.prices, ...o.percentOff].join(' '), o.restriction || '', o.url]));
    if (P.campaignFolders.length) s += `\n**Campaign asset folders**\n\n` + md.table(['Folder', 'Tokens', 'Files'], P.campaignFolders.slice(0, 15).map((f) => [f.folder, f.tokens.join(', '), `${f.fileCount}: ${f.files.slice(0, 3).join(', ')}`]));
    if (P.recent.length) s += `\n**Recently updated pages (sitemap)**\n\n` + P.recent.slice(0, 12).map((r) => `- ${r.lastmod.slice(0, 10)} ${r.url}`).join('\n') + '\n';
  }
  if (X.landingPages || X.campaignTokens?.length) {
    const L = X.landingPages || {};
    s += `\n## Landing pages & campaigns\n\n`;
    if (L.count) s += `${L.count} landing-page style URLs in the sitemap sample. Folders: ${L.folders.map(([f, n]) => `\`${f}\` (${n})`).join(', ')}.\n\nExamples: ${L.examples.slice(0, 10).map((e) => `\`${e}\``).join(', ')}\n\n`;
    if (L.hiddenFromSearch?.length) s += `Kept out of search engines (robots.txt), often paid landing pages: ${L.hiddenFromSearch.map((e) => `\`${e}\``).join(', ')}\n\n`;
    if (X.campaignTokens?.length) s += `**Campaign names and URL patterns their tags check for**\n\n` + md.table(['Pattern', 'Used by'], X.campaignTokens.map((t) => [t.token, t.platforms.join(', ')]));
    if (!L.count && !L.hiddenFromSearch?.length && !X.campaignTokens?.length) s += 'None found.\n';
  }
  if (X.footprint?.sitemapUrls || X.locales?.length || X.ratings?.length || X.social?.length) {
    s += `\n## Site footprint, reviews & social\n\n`;
    if (X.footprint?.sitemapUrls) s += `Sitemap: ${X.footprint.sitemapUrls.toLocaleString('en-US')} URLs read. Biggest sections: ${X.footprint.sections.map(([f, n]) => `/${f} (${n.toLocaleString('en-US')})`).join(', ')}.\n\n`;
    if (X.locales?.length) s += `Language / country versions (${X.locales.length}): ${X.locales.join(', ')}\n\n`;
    if (X.ratings?.length) s += md.table(['Rated item', 'Type', 'Rating', 'Reviews'], X.ratings.map((r) => [r.name, r.type, `${r.rating} / ${r.best}`, r.count ? r.count.toLocaleString('en-US') : '—'])) + '\n';
    if (X.social?.length) s += `Profiles the site lists: ${X.social.join(', ')}\n`;
  }
  if (R.cost) {
    const C = R.cost;

    s += `\n## Third-party cost (this page load)\n\n` + md.table(['Bucket', 'Requests', 'Transferred', 'JavaScript'], [
      ['First-party', C.totals.first.requests, kb(C.totals.first.bytes), kb(C.totals.first.jsBytes)],
      ['Marketing & tag managers', C.totals.marketing.requests, kb(C.totals.marketing.bytes), kb(C.totals.marketing.jsBytes)],
      ['Other third-party (CDN, fonts, maps, payments)', C.totals.infra.requests, kb(C.totals.infra.bytes), kb(C.totals.infra.jsBytes)],
      ['Unclassified third-party', C.totals.other3p.requests, kb(C.totals.other3p.bytes), kb(C.totals.other3p.jsBytes)],
    ]);
    s += `\nTop vendors by weight: ` + C.vendors.slice(0, 8).map((v) => `${v.vendor} ${kb(v.bytes)} (${v.requests} req)`).join(', ') + '\n';
    if (C.timing) s += `\nTiming: first byte ${C.timing.ttfb} ms, DOM ready ${C.timing.dcl} ms, load ${C.timing.load} ms.\n`;
    if (C.note) s += `\n_${C.note}_\n`;
  }
  const dl = R.dataLayers.filter((l) => l.kind === 'array');
  if (dl.length) s += `\n## Data layer at page load\n\n` + dl.map((l) => `- \`${l.name}\`: ${l.pushes} pushes; events: ${l.events.map((e) => e.event).slice(0, 20).join(', ') || '—'}`).join('\n') + '\n';
  s += `\n## Containers\n\n` + R.containers.map((c) => c.error ? `- ${c.id}: ${c.error}` : `- **${c.id}** v${c.version}: ${c.activeTags} active / ${c.pausedTags} paused tags, ${c.triggers} trigger rules, ${c.variables} variables. Top types: ${c.tagTypes.slice(0, 6).map(([t, n]) => `${t} ×${n}`).join(', ')}`).join('\n') + '\n';
  return s;
}

// ---------- compare ----------
function compareRows(reports) {
  const has = (R, ch) => (R.mediaMix.channels.find((c) => c.channel === ch)?.vendors || []).map((v) => v.name);
  const ids = (R, p) => (R.accountIds.find((x) => x.platform === p)?.ids || []).map((i) => i.id);
  return [
    ['Tag management', (R) => R.tagManagers.join(' + ') || '—'],
    ['Active tags (GTM)', (R) => R.containers.reduce((s, c) => s + (c.activeTags || 0), 0) || '—'],
    ['Adobe Launch rules', (R) => R.launch?.rules ?? '—'],
    ['Marketing vendors', (R) => R.mediaMix.total],
    ['Search', (R) => has(R, 'Search').join(', ') || '—'],
    ['Social', (R) => has(R, 'Social').join(', ') || '—'],
    ['Programmatic', (R) => has(R, 'Programmatic').join(', ') || '—'],
    ['CTV / TV', (R) => has(R, 'CTV / TV').join(', ') || '—'],
    ['Retargeting', (R) => has(R, 'Retargeting').join(', ') || '—'],
    ['Affiliate & partners', (R) => has(R, 'Affiliate & Partners').join(', ') || '—'],
    ['Attribution', (R) => has(R, 'Attribution').join(', ') || '—'],
    ['CDP & data', (R) => has(R, 'CDP & Data').join(', ') || '—'],
    ['Email & CRM', (R) => has(R, 'Email & CRM').join(', ') || '—'],
    ['Testing & personalization', (R) => has(R, 'Testing & Personalization').join(', ') || '—'],
    ['Agency signals', (R) => R.mediaMix.agencies.map((a) => a.name.split(' (')[0]).join(', ') || '—'],
    ['Google Ads accounts', (R) => ids(R, 'Google Ads').length || '—'],
    ['Floodlight advertisers', (R) => ids(R, 'Floodlight / CM360').length || '—'],
    ['GA4 properties', (R) => ids(R, 'GA4').length || '—'],
    ['Meta pixels', (R) => ids(R, 'Meta Pixel').length || '—'],
    ['Conversion tags (active / flagged)', (R) => `${R.conversions.active} / ${R.conversions.flagged}`],
    ['Server-side signals', (R) => R.serverSide.map((f) => f.signal).join('; ') || '—'],
    ['Active promos', (R) => R.promos ? R.promos.offers.filter((o) => o.status === 'active').map((o) => o.name).join('; ') || 'none dated' : 'not scanned'],
    ['Upcoming promos', (R) => R.promos ? R.promos.offers.filter((o) => o.status === 'upcoming').map((o) => o.name).join('; ') || '—' : '—'],
    ['Fiscal / campaign tags', (R) => R.promos ? [...R.promos.fiscalPeriods, ...R.promos.phases].join(', ') || '—' : '—'],
    ['Tracking share of requests', (R) => (R.cost ? R.cost.shares.marketingRequests + '%' : '—')],
    ['Tracking JavaScript', (R) => (R.cost ? `${kb(R.cost.totals.marketing.jsBytes)}${R.cost.shares.marketingJs != null ? ` (${R.cost.shares.marketingJs}%)` : ''}` : '—')],
    ['Page load (ms)', (R) => R.cost?.timing?.load || '—'],
  ];
}

function compareOut(reports, dir) {
  const rows = compareRows(reports);
  const head = ['', ...reports.map((R) => R.site)];
  const body = rows.map(([label, f]) => [label, ...reports.map((R) => f(R))]);
  // Vendor presence matrix
  const vendorSet = new Map();
  reports.forEach((R, i) => R.mediaMix.channels.forEach((c) => c.vendors.forEach((v) => {
    if (!vendorSet.has(v.name)) vendorSet.set(v.name, { channel: c.channel, on: new Set() });
    vendorSet.get(v.name).on.add(i);
  })));
  const matrix = [...vendorSet.entries()].sort((a, b) => a[1].channel.localeCompare(b[1].channel) || b[1].on.size - a[1].on.size || a[0].localeCompare(b[0]))
    .map(([name, x]) => [x.channel, name, ...reports.map((_, i) => (x.on.has(i) ? '●' : ''))]);

  // Account IDs that appear on more than one site (shared owner, agency or account)
  const idSites = new Map();
  reports.forEach((R) => R.accountIds.forEach((p) => p.ids.forEach((i) => {
    if (p.platform === 'Google Tag Manager') return;
    const k = p.platform + '|' + i.id;
    if (!idSites.has(k)) idSites.set(k, new Set());
    idSites.get(k).add(R.site);
  })));
  const shared = [...idSites.entries()].filter(([, s]) => s.size > 1).map(([k, s]) => [...k.split('|'), [...s].join(', ')]);

  let m = `# Competitor tag & marketing comparison\n\n${reports.length} sites, captured ${[...new Set(reports.map((R) => R.capturedAt.slice(0, 10)))].join(', ')}\n\n`;
  m += md.table(head, body);
  if (shared.length) m += `\n## Shared account IDs\n\nThe same ad account or pixel on more than one site usually means a common owner, agency or buying account.\n\n` + md.table(['Platform', 'ID', 'Sites'], shared);
  m += `\n## Vendor matrix\n\n` + md.table(['Channel', 'Vendor', ...reports.map((R) => R.site)], matrix);
  fs.writeFileSync(path.join(dir, 'comparison.md'), m);

  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(dir, 'comparison.csv'), [head, ...body].map((r) => r.map(cell).join(',')).join('\n') + '\n\n' + [['Channel', 'Vendor', ...reports.map((R) => R.site)], ...matrix].map((r) => r.map(cell).join(',')).join('\n'));
  fs.writeFileSync(path.join(dir, 'comparison.html'), compareHtml(reports, head, body, matrix, shared));
}

function compareHtml(reports, head, body, matrix, shared = []) {
  const e = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tbl = (h, rows, cls = '') => `<div class="scroll"><table class="${cls}"><thead><tr>${h.map((x) => `<th>${e(x)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x, i) => (i === 0 ? `<th scope="row">${e(x)}</th>` : `<td>${e(x)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div>`;
  const siteSections = reports.map((R) => {
    const P = R.promos;
    const flagged = R.conversions.rows.filter((r) => r.flags.length && !r.paused).slice(0, 12);
    return `<section class="site"><h2>${e(R.site)}</h2><p class="muted">${e(R.url)} · captured ${e(R.capturedAt.slice(0, 16).replace('T', ' '))}</p>
      <p>${e(R.mediaMix.notes.join(' · ') || '')}</p>
      <h3>Ad accounts</h3>${tbl(['Platform', 'IDs'], R.accountIds.map((p) => [p.platform, p.ids.map((i) => i.id).join(', ')]))}
      <p class="links">${R.adLibraries.map((l) => `<a href="${e(l.url)}" target="_blank" rel="noopener">${e(l.name)}</a>`).join(' · ')}</p>
      ${flagged.length ? `<h3>Flagged conversions</h3>${tbl(['Platform', 'Event', 'Value', 'Flags'], flagged.map((r) => [r.platform, r.event.slice(0, 50), String(r.value).slice(0, 40), r.flags.join('; ')]))}` : ''}
      ${P && P.offers.length ? `<h3>Promos</h3>${tbl(['Offer', 'Status', 'Dates', 'Prices'], P.offers.slice(0, 15).map((o) => [o.name, o.status, o.start || o.end ? `${o.start || '…'} → ${o.end || '…'}` : '', [...o.prices, ...o.percentOff].join(' ')]))}` : ''}
      ${P && P.campaignFolders.length ? `<h3>Campaign folders</h3><ul>${P.campaignFolders.slice(0, 8).map((f) => `<li><code>${e(f.folder)}</code> <span class="muted">${e(f.files.slice(0, 2).join(', '))}</span></li>`).join('')}</ul>` : ''}
    </section>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Competitor Tag Comparison</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1f22;--muted:#626a73;--line:#e2e4e8;--card:#fff;--accent:#2457c5;--dot:#2457c5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15171a;--fg:#e7e9ec;--muted:#9aa2ab;--line:#2c3036;--card:#1d2024;--accent:#8db0ff;--dot:#8db0ff}}
:root[data-theme="dark"]{--bg:#15171a;--fg:#e7e9ec;--muted:#9aa2ab;--line:#2c3036;--card:#1d2024;--accent:#8db0ff;--dot:#8db0ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:20px;margin:40px 0 4px}h3{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:24px 0 8px}
.muted{color:var(--muted)}.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}thead th{position:sticky;top:0;background:var(--card);font-weight:600}
tbody th{font-weight:600;white-space:nowrap;color:var(--muted)}tr:last-child td,tr:last-child th{border-bottom:0}
.matrix td{text-align:center;color:var(--dot);font-size:16px}.matrix td:nth-child(2){text-align:left;color:var(--fg);font-size:13px}
.site{border-top:1px solid var(--line);margin-top:40px}a{color:var(--accent)}code{font-size:12px}ul{padding-left:18px}
</style></head><body><main>
<h1>Competitor tag &amp; marketing comparison</h1><p class="muted">${reports.length} sites · captured ${e([...new Set(reports.map((R) => R.capturedAt.slice(0, 10)))].join(', '))} · built from public tag containers, page data and sitemaps</p>
<h2>Side by side</h2>${tbl(head, body)}
${shared.length ? `<h2>Shared account IDs</h2><p class="muted">The same ad account or pixel on more than one site usually means a common owner, agency or buying account.</p>${tbl(['Platform', 'ID', 'Sites'], shared)}` : ''}
<h2>Vendor matrix</h2>${tbl(['Channel', 'Vendor', ...reports.map((R) => R.site)], matrix, 'matrix')}
${siteSections}
</main></body></html>`;
}


// ---------- store / index / diff ----------
function pullSummary(R, rel, date) {
  const ids = R.accountIds.reduce((s, p) => s + p.ids.length, 0);
  const offers = R.promos ? R.promos.offers : [];
  return {
    site: R.site, date, path: rel, capturedAt: R.capturedAt,
    tagManagers: R.tagManagers, containers: R.containers.map((c) => c.id + (c.version ? ' v' + c.version : '')),
    vendors: R.mediaMix.total, accountIds: ids,
    conversions: R.conversions.active, flagged: R.conversions.flagged,
    serverSide: R.serverSide.filter((x) => x.verdict === 'yes').length,
    offers: offers.length, activeOffers: offers.filter((o) => /active|upcoming/.test(o.status)).length,
    marketingRequests: R.cost?.totals?.marketing?.requests ?? null,
  };
}
function writeIndex(root, entries) {
  entries.sort((a, b) => a.site.localeCompare(b.site) || b.date.localeCompare(a.date));
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ updated: new Date().toISOString(), pulls: entries }, null, 1));
  let s = `# Competitor tag intel: saved pulls\n\nUpdated ${new Date().toISOString().slice(0, 10)}. Each pull is in \`pulls/<site>/<date>/\` (report.md, report.json, capture.json.gz). Comparisons are in \`comparisons/\`.\n\n`;
  s += md.table(['Site', 'Date', 'Containers', 'Vendors', 'Account IDs', 'Conversions (flagged)', 'Server-side signals', 'Offers (active/upcoming)', 'Marketing requests', 'Report'],
    entries.map((e) => [e.site, e.date, e.containers.join(', ') || '—', e.vendors, e.accountIds, `${e.conversions} (${e.flagged})`, e.serverSide, `${e.offers} (${e.activeOffers})`, e.marketingRequests ?? '—', `[report](${e.path}/report.md)`]));
  fs.writeFileSync(path.join(root, 'INDEX.md'), s + '\n');
}
function loadIndex(root) {
  try { return readJson(path.join(root, 'index.json')).pulls || []; } catch { return []; }
}
function storePull(capFile, root, date) {
  const cap = readJson(capFile);
  const R = analyze(cap);
  date = date || (R.capturedAt || new Date().toISOString()).slice(0, 10);
  let rel = `pulls/${R.site}/${date}`, n = 2;
  while (fs.existsSync(path.join(root, rel, 'report.json'))) rel = `pulls/${R.site}/${date}-${n++}`;
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'capture.json.gz'), zlib.gzipSync(JSON.stringify(cap)));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(R, null, 1));
  fs.writeFileSync(path.join(dir, 'report.md'), reportMd(R));
  const files = ['capture.json.gz', 'report.json', 'report.md'];
  if (cap.promos?.sitemapPaths?.length) { fs.writeFileSync(path.join(dir, 'sitemap.txt'), cap.promos.sitemapPaths.join('\n') + '\n'); files.push('sitemap.txt'); }
  const entries = loadIndex(root).filter((e) => e.path !== rel);
  const prev = entries.filter((e) => e.site === R.site).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  entries.push(pullSummary(R, rel, rel.split('/').pop()));
  writeIndex(root, entries);
  return { R, rel, prev, files: files.map((f) => rel + '/' + f).concat(['index.json', 'INDEX.md']) };
}
// Pages in the newer sitemap that weren't in the older one, grouped by folder
function newPagesMd(oldFile, newFile) {
  if (!fs.existsSync(oldFile) || !fs.existsSync(newFile)) return '';
  const read = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[0]);
  const before = new Set(read(oldFile));
  const added = read(newFile).filter((p) => !before.has(p));
  if (!added.length) return '\n## New pages\n\nNo new pages in the sitemap sample.\n';
  const by = {};
  for (const p of added) (by['/' + (p.split('/').filter(Boolean)[0] || '')] ||= []).push(p);
  return `\n## New pages (${added.length})\n\n` + Object.entries(by).sort((a, b) => b[1].length - a[1].length).slice(0, 12)
    .map(([f, l]) => `- **${f}** (${l.length}): ${l.slice(0, 8).map((x) => '`' + x + '`').join(', ')}${l.length > 8 ? ', …' : ''}`).join('\n') + '\n';
}
function rebuildIndex(root) {
  const entries = [];
  const base = path.join(root, 'pulls');
  for (const site of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    for (const d of fs.readdirSync(path.join(base, site))) {
      const f = path.join(base, site, d, 'report.json');
      if (fs.existsSync(f)) entries.push(pullSummary(readJson(f), `pulls/${site}/${d}`, d));
    }
  }
  writeIndex(root, entries);
  return entries.length;
}
function diffReports(A, B) {
  const setDiff = (a, b) => ({ added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) });
  const vendors = (R) => new Set(R.mediaMix.channels.flatMap((c) => c.vendors.map((v) => `${v.name} (${c.channel})`)));
  const ids = (R) => new Set(R.accountIds.flatMap((p) => p.ids.map((i) => `${p.platform} ${i.id}`)));
  const convs = (R) => new Set(R.conversions.rows.filter((r) => !r.paused).map((r) => `${r.platform} ${r.account || ''} · ${r.event} · value ${r.value ?? '—'}`));
  const sst = (R) => new Set(R.serverSide.filter((x) => x.verdict === 'yes').map((x) => x.signal));
  const offers = (R) => new Map((R.promos?.offers || []).map((o) => [o.key || o.name, { label: o.name, v: `${o.status}${o.start || o.end ? ` (${o.start || '?'} → ${o.end || '?'})` : ''}${o.prices?.length ? ' ' + o.prices.join('/') : ''}${o.copies > 1 ? ` ×${o.copies}` : ''}` }]));
  const conts = (R) => new Map(R.containers.map((c) => [c.id, c]));
  const sections = [];
  const add = (title, d) => { if (d.added.length || d.removed.length) sections.push(`## ${title}\n\n${d.added.map((x) => '- **Added:** ' + x).join('\n')}${d.added.length && d.removed.length ? '\n' : ''}${d.removed.map((x) => '- **Removed:** ' + x).join('\n')}`); };
  const ca = conts(A), cb = conts(B), cl = [];
  for (const [id, c] of cb) {
    const o = ca.get(id);
    if (!o) cl.push(`- **New container:** ${id} v${c.version}`);
    else if (o.version !== c.version) cl.push(`- **${id} republished:** v${o.version} → v${c.version}; active tags ${o.activeTags} → ${c.activeTags}, paused ${o.pausedTags} → ${c.pausedTags}, triggers ${o.triggers} → ${c.triggers}`);
  }
  for (const id of ca.keys()) if (!cb.has(id)) cl.push(`- **Container gone:** ${id}`);
  if (cl.length) sections.push('## Containers\n\n' + cl.join('\n'));
  add('Vendors', setDiff(vendors(A), vendors(B)));
  add('Ad accounts and pixel IDs', setDiff(ids(A), ids(B)));
  add('Conversion tags', setDiff(convs(A), convs(B)));
  add('Server-side signals', setDiff(sst(A), sst(B)));
  const oa = offers(A), ob = offers(B), ol = [];
  for (const [k, b] of ob) { const a = oa.get(k); if (!a) ol.push(`- **New offer:** ${b.label}: ${b.v}`); else if (a.v !== b.v) ol.push(`- **Changed:** ${b.label}: ${a.v} → ${b.v}`); }
  for (const [k, a] of oa) if (!ob.has(k)) ol.push(`- **No longer found:** ${a.label}`);
  if (ol.length) sections.push('## Promos\n\n' + ol.join('\n'));
  const ma = A.cost?.totals?.marketing, mb = B.cost?.totals?.marketing;
  if (ma && mb && (ma.requests !== mb.requests)) sections.push(`## Tracking weight\n\n- Marketing requests per page load: ${ma.requests} → ${mb.requests}`);
  const xd = diffExtras(A.extras, B.extras);
  if (xd) sections.push(xd);
  return `# ${B.site}: changes from ${(A.capturedAt || '').slice(0, 10)} to ${(B.capturedAt || '').slice(0, 10)}\n\n` + (sections.join('\n\n') || 'No changes in containers, vendors, accounts, conversions, server-side signals, promos or tracking weight.') + '\n';
}

// ---------- main ----------
if (cmd === 'extract') {
  const out = opt('-o', null) || 'capture.json';
  const expect = opt('--expect', null);
  if (!rest.length) die('usage: extract <tool-output-file> [more part files ...] [-o capture.json] [--expect domain.com]');
  const r = extractPacked(rest, 'TAGINTEL', expect);
  let cap = r.data;
  if (!cap) cap = extractMarked(rest[0], '__TAGINTEL_BEGIN__', '__TAGINTEL_END__');
  if (!cap) die('No capture found: ' + r.error);
  fs.writeFileSync(out, JSON.stringify(cap));
  console.log(`extracted ${cap.page.host}: ${cap.page.containers.length} tag IDs, ${Object.keys(cap.containers).length} GTM containers, promos: ${cap.promos ? (cap.promos.pages || []).length + ' pages' : 'no'} -> ${out}`);
} else if (cmd === 'analyze') {
  const out = opt('-o', null);
  const file = rest[0] || die('usage: analyze <capture.json> [-o outdir]');
  const cap = readJson(file);
  const R = analyze(cap);
  const dir = out || path.join('out', R.site);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(R, null, 1));
  fs.writeFileSync(path.join(dir, 'report.md'), reportMd(R));
  console.log(`${R.site}: ${R.mediaMix.total} vendors, ${R.accountIds.reduce((s, p) => s + p.ids.length, 0)} IDs, ${R.conversions.active} conversion tags (${R.conversions.flagged} flagged), promos: ${R.promos ? R.promos.offers.length : 'n/a'} -> ${dir}/report.md`);
} else if (cmd === 'compare') {
  const out = opt('-o', null) || 'out/comparison';
  if (!rest.length) die('usage: compare <report.json ...> [-o outdir]');
  const reports = rest.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  fs.mkdirSync(out, { recursive: true });
  compareOut(reports, out);
  console.log(`compared ${reports.length} sites -> ${out}/comparison.{md,csv,html}`);
} else if (cmd === 'recording') {
  const out = opt('-o', null) || 'out/recording';
  if (!rest.length) die('usage: recording <recorder-output-file ...> [-o outdir]');
  const items = [];
  // Each page load's recording is packed separately; group files by which recording they belong to
  for (const f of rest) {
    const r = extractPacked([f], 'TAGINTELREC');
    if (r.data) { items.push(...r.data.items); continue; }
    if (/missing part/.test(r.error)) die(f + ': ' + r.error);
    const old = extractMarked(f, '__TAGINTEL_REC_BEGIN__', '__TAGINTEL_REC_END__');
    if (!old) die('No recording found in ' + f);
    items.push(...old.items);
  }
  items.sort((a, b) => a.t - b.t);
  const A = analyzeRecording({ started: items[0]?.t, items });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'recording.csv'), recordingCsv(A));
  let s = `# Funnel recording\n\n${items.length} items, ${A.timeline.filter((r) => r.type === 'page').length} pages\n\n## Things to check\n\n${A.anomalies.map((a) => '- ' + a.text).join('\n') || '- none'}\n\n## Funnel (site events in order)\n\n`;
  s += A.funnel.map((f, i) => `${i + 1}. ${f.label}${f.values.length ? ' — ' + f.values.map(([k, v]) => `${k.split('.').pop()}=${v}`).join(', ') : ''}`).join('\n');
  s += `\n\n## Pixels by platform\n\n` + md.table(['Platform', 'Accounts', 'Events (count, values)'], Object.entries(A.platforms).map(([v, p]) => [v, [...p.accounts].join(', '), Object.entries(p.events).map(([e, x]) => `${e} ×${x.count}${x.values.size ? ' [' + [...x.values].join('|') + ']' : ''}`).join('; ')]));
  fs.writeFileSync(path.join(out, 'recording.md'), s);
  console.log(`recording: ${items.length} items -> ${out}/recording.{md,csv}`);
} else if (cmd === 'store') {
  const root = opt('--root', null) || die('usage: store <capture.json[.gz]> --root <store dir> [--date YYYY-MM-DD]');
  const date = opt('--date', null);
  const r = storePull(rest[0] || die('usage: store <capture.json[.gz]> --root <dir>'), root, date);
  if (r.prev) {
    let t = diffReports(readJson(path.join(root, r.prev.path, 'report.json')), r.R);
    t += newPagesMd(path.join(root, r.prev.path, 'sitemap.txt'), path.join(root, r.rel, 'sitemap.txt'));
    fs.writeFileSync(path.join(root, r.rel, 'changes.md'), t);
    r.files.push(r.rel + '/changes.md');
  }
  console.log(`stored ${r.R.site} -> ${path.join(root, r.rel)}${r.prev ? ` (changes since ${r.prev.date} in changes.md)` : ''}\nwritten:\n` + r.files.map((f) => '  ' + f).join('\n'));
} else if (cmd === 'index') {
  const root = opt('--root', null) || die('usage: index --root <store dir>');
  console.log(`indexed ${rebuildIndex(root)} pulls -> ${root}/INDEX.md`);
} else if (cmd === 'diff') {
  const out = opt('-o', null);
  if (rest.length < 2) die('usage: diff <old report.json> <new report.json> [-o changes.md]');
  let t = diffReports(readJson(rest[0]), readJson(rest[1]));
  t += newPagesMd(path.join(path.dirname(rest[0]), 'sitemap.txt'), path.join(path.dirname(rest[1]), 'sitemap.txt'));
  if (out) { fs.writeFileSync(out, t); console.log('-> ' + out); } else console.log(t);
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).join('\n'));
}
