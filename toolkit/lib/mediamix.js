// Summarizes every marketing vendor seen on the site by channel, plus agency fingerprints.
import { CHANNELS, channelOf, detectVendors, AGENCY_SIGNALS } from './vendors.js';

const BUILTIN = {
  __awct: 'Google Ads', __sp: 'Google Ads', __awud: 'Google Ads', __awcc: 'Google Ads', __gclidw: 'Google Ads',
  __flc: 'Floodlight / CM360', __fls: 'Floodlight / CM360', __gaawe: 'GA4', __gaawc: 'GA4',
  __baut: 'Microsoft Ads (UET)', __bzi: 'LinkedIn', __pntr: 'Pinterest', __hjtc: 'Hotjar', __asp: 'AdRoll / NextRoll',
  __crto: 'Criteo', __qcm: 'Quantcast', __twitter_website_tag: 'Twitter / X',
};

export function buildMediaMix({ page, gtm = [], launch = null, extraUrls = [] }) {
  const vendors = new Map(); // name -> Set(where)
  const add = (name, where) => {
    if (!name) return;
    if (!vendors.has(name)) vendors.set(name, new Set());
    vendors.get(name).add(where);
  };

  for (const { id, data } of gtm) {
    if (!data) continue;
    for (const t of data.tags) {
      if (t.category !== 'tag' || t.paused) continue;
      if (BUILTIN[t.fn]) add(BUILTIN[t.fn], `GTM ${id}`);
      if (t.fn === '__googtag') {
        const tid = String(t.params.tagId || '');
        add(/^AW-/.test(tid) ? 'Google Ads' : /^DC-/.test(tid) ? 'Floodlight / CM360' : 'GA4', `GTM ${id}`);
      }
      for (const v of t.vendors || []) add(v, `GTM ${id}`);
    }
  }
  for (const r of launch?.rules || []) {
    for (const a of r.actions || []) {
      if (a.ext === 'adobe-analytics') add('Adobe Analytics', 'Adobe Launch');
      if (a.ext && a.ext.startsWith('adobe-target')) add('Adobe Target', 'Adobe Launch');
      detectVendors((a.code || '') + ' ' + (a.external || '')).forEach((v) => add(v, 'Adobe Launch'));
    }
  }
  for (const c of page?.containers || []) {
    if (/^AW-/.test(c.id)) add('Google Ads', 'page');
    if (/^DC-/.test(c.id)) add('Floodlight / CM360', 'page');
    if (/^G-/.test(c.id)) add('GA4', 'page');
  }
  const urls = [...(page?.network?.urls || []), ...(page?.network?.scripts || []), ...extraUrls];
  for (const u of urls) {
    let host = '';
    try { host = new URL(u).hostname; } catch {}
    detectVendors(host + new URL(u, 'https://x').pathname + ' ' + u.slice(0, 300)).forEach((v) => add(v, extraUrls.includes(u) ? 'recording' : 'network'));
  }

  const byChannel = {};
  for (const [name, where] of vendors) {
    const ch = channelOf(name);
    (byChannel[ch] ||= []).push({ name, where: [...where] });
  }
  const channels = CHANNELS.filter((c) => byChannel[c]).map((c) => ({ channel: c, vendors: byChannel[c].sort((a, b) => a.name.localeCompare(b.name)) }));

  // Agency fingerprints from URLs and tag code
  const corpus = [];
  for (const { data } of gtm) for (const t of data?.tags || []) if (t.category === 'tag') corpus.push([JSON.stringify(t.params), `GTM tag #${t.id}`]);
  for (const r of launch?.rules || []) for (const a of r.actions || []) corpus.push([(a.code || '') + (a.external || ''), `Launch rule "${r.name}"`]);
  for (const u of urls) corpus.push([u, 'network']);
  const agencies = [];
  for (const [name, re] of AGENCY_SIGNALS) {
    const ev = corpus.filter(([txt]) => re.test(txt)).map(([txt, where]) => {
      const m = txt.match(re);
      const i = m ? txt.indexOf(m[0]) : 0;
      return `${where}: …${txt.slice(Math.max(0, i - 40), i + 50).replace(/\s+/g, ' ')}…`;
    });
    if (ev.length) agencies.push({ name, evidence: [...new Set(ev)].slice(0, 4) });
  }

  // One-line read of the mix
  const count = (c) => (byChannel[c] || []).length;
  const notes = [];
  if (count('CTV / TV')) notes.push(`CTV/TV measurement or buying (${byChannel['CTV / TV'].map((v) => v.name).join(', ')})`);
  if (count('Programmatic') >= 3) notes.push(`heavy programmatic (${count('Programmatic')} DSP/ad-tech vendors)`);
  if (count('Social') >= 4) notes.push(`broad social (${count('Social')} platforms)`);
  if (count('CDP & Data')) notes.push(`CDP/data layer: ${byChannel['CDP & Data'].map((v) => v.name).join(', ')}`);
  if (count('Email & CRM')) notes.push(`CRM: ${byChannel['Email & CRM'].map((v) => v.name).join(', ')}`);
  if (count('Affiliate & Partners')) notes.push(`affiliate/partner tracking (${byChannel['Affiliate & Partners'].map((v) => v.name).join(', ')})`);
  if (count('Attribution')) notes.push(`third-party attribution: ${byChannel['Attribution'].map((v) => v.name).join(', ')}`);

  return { channels, agencies, notes, total: vendors.size };
}
