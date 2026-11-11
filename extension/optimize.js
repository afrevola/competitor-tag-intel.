// "What they optimize to": the conversion goals each ad platform is given, read from the conversion map.
// Groups every active conversion by goal type, picks each platform's main goal, says whether values are
// sent, lists the filters on who counts, and explains the custom code those triggers rely on.

const GOALS = [
  // [id, label, test on "event + trigger events + trigger text"]
  ['purchase', 'Purchase / order', /purchase|conversion[ _-]?buy|\bbuy[ _-]?(complete|confirm)|checkout_?complet|order_?(complet|placed|confirm)|orderCompleted|transaction|\bsale\b|payment_?(success|complete)|paid|subscription_?(start|created)|\bcounter .*order|sales .*order|completepayment/i],
  ['booking', 'Booking / reservation', /book(ing)?_?(complete|confirm|made)|reservation_?(complete|confirm|made)|reserved|booked/i],
  ['lead', 'Lead / form submit', /lead|form_?submit|formSubmit|FormSubmitted|hubspot|marketo|contact|demo|quote|inquiry|enquiry|request|sales_form|submit_application|schedule/i],
  ['signup', 'Sign-up / account / trial', /\bjoin\b|sign_?up|signupClicked|register|registration|account_?created|accountCreated|user_?created|userCreated|create_?account|start_?trial|trial_?start|free_?trial|complete_?registration/i],
  ['checkout', 'Cart / checkout step', /initiate[ _-]?buy|add_?to_?cart|addToCart|begin_?checkout|initiate_?checkout|InitiateCheckout|add_?payment|add_?shipping|checkout|orderStarted|view_?cart/i],
  ['product', 'Product / content view', /view_?item|ViewContent|product_?view|view_?product|PDP|search\b/i],
  ['click', 'Click on a button or link', /gtm\.click|gtm\.linkClick|click/i],
  ['engagement', 'Engagement (scroll, time, video)', /scroll|gtm\.timer|timer|video|engaged/i],
  ['pageview', 'Page view / visit', /gtm\.js|gtm\.dom|gtm\.load|page_?view|pageview|PAGE_LOAD|PageVisit|cookiehub|consent|OneTrust|Optanon|Cookiebot/i],
  ['other', 'Other / unlabeled', /$^/],
];
const ORDER = GOALS.map((g) => g[0]);

const PAGE_EVENT_RE = /\{\{Event\}\} (?:equals|matches RegEx) (gtm\.js|gtm\.dom|gtm\.load|page_?view|cookiehub_[\w|()]+|OneTrust\w*|Optanon\w*|Cookiebot\w*|consent\w*)/i;

function goalOf(r) {
  const fire = (r.firing || []).join(' || ');
  const evs = [...fire.matchAll(/\{\{Event\}\} (?:equals|matches RegEx|contains) ([^\s|]+(?:\|[^\s|]+)*)/g)].map((m) => m[1]).join(' ');
  // Event names carry the goal for most platforms; Google Ads events are just "conversion <label>"
  const name = /^conversion /.test(r.event) ? '' : r.event;
  // Launch rule names usually say what the rule is for ("… | Conversion Buy", "… | Initiate Buy")
  const rule = (fire.match(/Launch rule "([^"]+)"/) || [])[1] || '';
  const text = `${name} ${evs} ${rule.split('|').slice(1).join(' ')}`;
  if (r.shopifyApp) {
    const e = r.shopifyEvent || '';
    if (/purchase|checkout_completed/.test(e)) return 'purchase';
    if (/checkout|cart|payment|shipping/.test(e)) return 'checkout';
    if (/view_item|search/.test(e)) return 'product';
    if (/page_view/.test(e)) return 'pageview';
  }
  for (const [id, , re] of GOALS) {
    if (id === 'click' || id === 'engagement' || id === 'pageview') continue;
    if (re.test(text)) return id;
  }
  if (/gtm\.click|gtm\.linkClick/.test(fire)) return 'click';
  if (/scrollDepth|gtm\.timer|video/i.test(fire)) return 'engagement';
  if (PAGE_EVENT_RE.test(fire) || /page ?view|pagevisit|page_load/i.test(r.event)) return 'pageview';
  for (const [id, , re] of GOALS) if (re.test(`${r.event} ${fire}`)) return id;
  return 'other';
}

function valueKind(r) {
  const v = r.valueText ?? r.value;
  if (v == null || v === '' || v === '—') return null;
  const s = String(v);
  if (/sent by Shopify/.test(s)) return 'order total (Shopify)';
  if (/^\{\{Custom JS/.test(s)) return 'computed by custom code';
  if (/^\{\{|^%.*%$|\{\{/.test(s)) return 'dynamic (from the page or data layer)';
  if (/^-?\d+(\.\d+)?$/.test(s)) return `fixed (${s})`;
  if (/^<[^>]+>$/.test(s)) return `unfilled placeholder ${s}`;
  return s.slice(0, 40);
}

// Conditions on who or what counts
function filtersOf(r) {
  const t = (r.firing || []).join(' || ');
  const out = [];
  if (/company_?size|employees/i.test(t)) {
    const m = t.match(/NOT \(\{\{[^}]*company_?size[^}]*\}\} contains ([^)]+)\)/i);
    out.push(m ? `only companies not sized "${m[1].trim()}"` : 'filtered by company size');
  }
  if (/industry|annual_?revenue|seniority|job_?(title|level)|lead_?score|is_?qualified/i.test(t)) out.push('filtered by lead details (industry, role or score)');
  const product = t.match(/\{\{[^}]*product[^}]*\}\} (?:contains|equals) ([^|)]+?)(?: AND| \|\||$)/i);
  if (product) out.push(`only for product "${product[1].trim()}"`);
  const q = t.match(/\{\{Page Query\}\} (?:contains|matches RegEx|equals) ([^\s|]+(?:\|[^\s|]+)*)/);
  if (q) out.push(`only for visitors from campaign URLs matching "${q[1]}"`);
  for (const m of t.matchAll(/\{\{Page (Path|URL|Url|Hostname|Host)\}\} (?:contains|matches RegEx|starts with|equals) (\S+)/g)) {
    const v = m[2];
    if (/Host/.test(m[1]) || /^(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[a-z]{2,})+\/?$/i.test(v)) out.push(`site: ${v.replace(/^https?:\/\/(www\.)?/, '')}`);
    else out.push(`only on pages matching "${v.slice(0, 60)}"`);
  }
  if (/GPC|Do Not Track/i.test(t)) out.push('skipped for privacy opt-outs');
  return out;
}

// Plain-English reading of custom code used in conversion triggers
function explainCode(code) {
  const c = String(code || '');
  const out = [];
  const mod = c.match(/%\s*(\d+)\s*===?\s*(\d+)/);
  if (mod && /parseInt|visitor|id/i.test(c)) out.push(`splits visitors by ID into ${mod[1]} groups and passes only group ${mod[2]}: a holdout or A/B split`);
  else if (/Math\.random/.test(c)) out.push('random sampling: only some visitors pass');
  const st = c.match(/(sessionStorage|localStorage)\.getItem\(["']([^"']+)["']\)/);
  if (st) out.push(`checks a value the site saved in the browser (${st[1]} "${st[2]}")`);
  const words = [...c.matchAll(/includes\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  if (words.length && /Page Query|search|utm|query/i.test(c)) out.push(`checks the campaign URL contains ${words.map((w) => `"${w}"`).join(' and ')}`);
  else if (words.length) out.push(`checks for ${words.map((w) => `"${w}"`).join(', ')}`);
  if (/document\.referrer/.test(c)) out.push('checks where the visitor came from (referrer)');
  if (/document\.cookie/.test(c)) out.push('reads a cookie');
  if (/innerText|textContent|querySelector/.test(c) && /\$|price|total|amount/i.test(c)) out.push('reads a price or amount from the page');
  if (/parseInt\(\{\{[^}]*visitor[^}]*\}\}\s*,\s*16\)/i.test(c)) out.push('turns the visitor ID into a number');
  return out.join('; ') || null;
}

export function analyzeOptimization(rows, gtm = []) {
  const active = rows.filter((r) => !r.paused);
  // Custom JS variables used by conversion triggers
  const vars = {};
  for (const { id, data } of gtm) for (const v of data.variables || []) if (/^Custom JS #/.test(v.label)) vars[`${id}|${v.label}`] = { container: id, label: v.label, code: v.params?.javascript || '' };
  const used = new Map();
  const platforms = {};
  for (const r of active) {
    if (r.platform === 'GA4' && !/purchase|lead|sign|qualified|submit|conversion/i.test(r.event)) continue;
    const g = goalOf(r);
    const P = (platforms[r.platform] ||= { platform: r.platform, accounts: new Set(), goals: {}, valued: {}, filters: new Set(), values: new Set(), total: 0 });
    P.total++;
    if (r.account) {
      const a = String(r.account).replace(/^\{\{Constant "(.*)"\}\}$/, '$1');
      if (!(r.platform === 'Meta Pixel' && !/^\d{12,17}$/.test(a))) P.accounts.add(a);
    }
    P.goals[g] = (P.goals[g] || 0) + 1;
    const vk = valueKind(r);
    if (vk) { P.valued[g] = (P.valued[g] || 0) + 1; P.values.add(vk); }
    for (const f of filtersOf(r)) P.filters.add(f);
    for (const m of (r.firing || []).join(' ').matchAll(/\{\{(Custom JS #\d+)\}\}/g)) {
      const k = `${r.container}|${m[1]}`;
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(r.platform);
    }
  }
  // Custom JS that conversions depend on (and the Custom JS those reference)
  const helpers = [];
  const seen = new Set();
  const visit = (key, platformsSet) => {
    if (seen.has(key) || !vars[key]) return;
    seen.add(key);
    const V = vars[key];
    helpers.push({ variable: V.label, container: V.container, usedBy: [...platformsSet], meaning: explainCode(V.code), code: V.code.replace(/\s+/g, ' ').slice(0, 220) });
    for (const m of V.code.matchAll(/\{\{(Custom JS #\d+)\}\}/g)) visit(`${V.container}|${m[1]}`, platformsSet);
  };
  for (const [k, ps] of used) visit(k, ps);

  const out = Object.values(platforms).map((P) => {
    const present = ORDER.filter((g) => P.goals[g]);
    // Main goal: the most-used high-intent goal (ties go to the deeper-funnel one), else the deepest present
    const intent = ['purchase', 'booking', 'lead', 'signup'].filter((g) => P.goals[g]);
    const main = intent.length ? intent.reduce((a, b) => (P.goals[b] > P.goals[a] ? b : a)) : present[0] || 'other';
    return {
      platform: P.platform,
      accounts: [...P.accounts].slice(0, 8),
      conversions: P.total,
      mainGoal: GOALS.find((g) => g[0] === main)?.[1] || 'Other',
      goals: present.map((g) => ({ goal: GOALS.find((x) => x[0] === g)[1], count: P.goals[g], withValue: P.valued[g] || 0 })),
      values: [...P.values],
      // Several "site:" checks (one container serving several brands) read as one line
      filters: (() => {
        const all = [...P.filters];
        const sites = all.filter((f) => f.startsWith('site: ')).map((f) => f.slice(6));
        const rest = all.filter((f) => !f.startsWith('site: '));
        return [...(sites.length ? [`split by site: ${[...new Set(sites)].join(', ')}`] : []), ...rest].slice(0, 8);
      })(),
    };
  }).sort((a, b) => ORDER.indexOf(GOALS.find((g) => g[1] === a.mainGoal)?.[0]) - ORDER.indexOf(GOALS.find((g) => g[1] === b.mainGoal)?.[0]) || b.conversions - a.conversions);

  const anyValue = out.some((p) => p.values.length);
  const headline = [];
  const weight = {};
  for (const p of out) weight[p.mainGoal] = (weight[p.mainGoal] || 0) + p.conversions;
  const topGoal = Object.entries(weight).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topGoal) headline.push(`Main goal across platforms: ${topGoal.toLowerCase()}`);
  headline.push(anyValue ? `values sent: ${[...new Set(out.flatMap((p) => p.values))].slice(0, 4).join(', ')}` : 'no conversion values are sent from the browser (counts only)');
  const allFilters = [...new Set(out.flatMap((p) => p.filters))];
  if (allFilters.some((f) => /company|lead details/.test(f))) headline.push('lead-quality filters on who counts');
  if (helpers.some((h) => /holdout|A\/B|random/.test(h.meaning || ''))) headline.push('a holdout / split test on some conversions');
  return { platforms: out, helpers, headline: headline.join('; ') };
}

// One line per repeated flag ("28 conversions may count twice")
export function summarizeFlags(rows) {
  const counts = {};
  for (const r of rows.filter((x) => !x.paused)) {
    for (const f of r.flags || []) {
      const text = Array.isArray(f) ? f[1] : f;
      const key = String(text)
        .replace(/#\d+(?:, #\d+)*/g, '#')
        .replace(/\(created by Shopify[^)]*\)/, '(Shopify Google app)')
        .replace(/on "[^"]+"/, 'on a non-purchase step')
        .replace(/Also set up in [^;]+?; both load/, 'Also set up in another container that loads')
        .replace(/\(([^)]{0,80})\)$/, '')
        .trim();
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}
