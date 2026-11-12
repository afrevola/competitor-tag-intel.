// Parses the published GTM / gtag.js container script into readable tags, triggers and variables.
import { detectVendors } from './vendors.js';

export const TAG_TYPES = {
  __googtag: 'Google Tag',
  __gaawc: 'GA4 Configuration',
  __gaawe: 'GA4 Event',
  __ua: 'Universal Analytics',
  __awct: 'Google Ads Conversion',
  __sp: 'Google Ads Remarketing',
  __awcc: 'Google Ads Calls from Website',
  __awud: 'Google Ads User-Provided Data Event',
  __gclidw: 'Conversion Linker',
  __flc: 'Floodlight Counter',
  __fls: 'Floodlight Sales',
  __html: 'Custom HTML',
  __img: 'Custom Image',
  __baut: 'Microsoft (Bing) UET',
  __bzi: 'LinkedIn Insight',
  __hjtc: 'Hotjar',
  __pntr: 'Pinterest',
  __twitter_website_tag: 'Twitter / X',
  __crto: 'Criteo OneTag',
  __qcm: 'Quantcast',
  __asp: 'AdRoll',
  __cegg: 'Crazy Egg',
  __mf: 'Mouseflow',
  __opt: 'Google Optimize',
  __gcs: 'Google Surveys',
  __paused: 'Paused tag',
  __tg: 'Trigger Group (internal)',
  // Auto-event listeners GTM creates for triggers
  __lcl: 'Listener: Link Click',
  __cl: 'Listener: Click',
  __fsl: 'Listener: Form Submit',
  __evl: 'Listener: Element Visibility',
  __sdl: 'Listener: Scroll Depth',
  __tl: 'Listener: Timer',
  __ytl: 'Listener: YouTube Video',
  __hl: 'Listener: History Change',
  __jel: 'Listener: JavaScript Error',
};

const LISTENERS = new Set(['__lcl', '__cl', '__fsl', '__evl', '__sdl', '__tl', '__ytl', '__hl', '__jel']);

const VAR_TYPES = {
  __e: 'Event', __u: 'URL', __f: 'Referrer', __v: 'Data Layer Variable', __c: 'Constant',
  __j: 'JavaScript Variable', __jsm: 'Custom JavaScript', __k: '1st-Party Cookie', __d: 'DOM Element',
  __aev: 'Auto-Event Variable', __remm: 'RegEx Table', __smm: 'Lookup Table', __gas: 'GA Settings',
  __cid: 'Container ID', __ctv: 'Container Version', __dbg: 'Debug Mode', __r: 'Random Number',
  __t: 'Timestamp', __vis: 'Element Visibility', __uv: 'Undefined Value', __gtes: 'Google Tag: Event Settings',
  __gtcs: 'Google Tag: Config Settings', __awec: 'User-Provided Data', __dee: 'Environment Name',
};

const OPS = {
  _eq: 'equals', _cn: 'contains', _sw: 'starts with', _ew: 'ends with', _re: 'matches RegEx',
  _css: 'matches CSS selector', _lt: '<', _le: '<=', _gt: '>', _ge: '>=',
};

const NEG_OPS = {
  _eq: 'does not equal', _cn: 'does not contain', _sw: 'does not start with', _ew: 'does not end with',
  _re: 'does not match RegEx', _css: 'does not match CSS selector', _lt: 'not <', _le: 'not <=', _gt: 'not >', _ge: 'not >=',
};

const EVENT_HINTS = {
  'gtm.js': 'Page View', 'gtm.dom': 'DOM Ready', 'gtm.load': 'Window Loaded', 'gtm.init': 'Initialization',
  'gtm.init_consent': 'Consent Initialization', 'gtm.click': 'Click – All Elements', 'gtm.linkClick': 'Click – Just Links',
  'gtm.formSubmit': 'Form Submission', 'gtm.historyChange': 'History Change', 'gtm.scrollDepth': 'Scroll Depth',
  'gtm.timer': 'Timer', 'gtm.elementVisibility': 'Element Visibility', 'gtm.video': 'YouTube Video',
  'gtm.pageError': 'JavaScript Error',
};

// Pull the {"resource": {...}} object out of the script with a string-aware bracket matcher.
export function extractResource(src) {
  let i = src.indexOf('"resource"');
  if (i < 0) throw new Error('No container data found in the script.');
  i = src.indexOf('{', i);
  const start = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  throw new Error('Container data was cut off or malformed.');
}

const str = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

export function parseContainer(src) {
  const resource = extractResource(src);
  // A gallery template's own code (published in the container's runtime) names the hosts it sends to
  const tplCache = {};
  const templateUrls = (fn) => {
    if (fn in tplCache) return tplCache[fn];
    const k = src.indexOf('[50,"' + fn + '"');
    if (k < 0) return (tplCache[fn] = '');
    const e = src.indexOf('[50,"__', k + 10);
    const code = src.slice(k, e > 0 ? Math.min(e, k + 60000) : k + 60000);
    return (tplCache[fn] = [...new Set(code.match(/https?:\/\/[^"'\s,\]\\]+/g) || [])].join(' '));
  };
  const macros = resource.macros || [];
  const tags = resource.tags || [];
  const preds = resource.predicates || [];
  const rules = resource.rules || [];

  const varLabel = (i) => {
    const m = macros[i];
    if (!m) return `var #${i}`;
    const name = typeof m.vtp_name === 'string' ? m.vtp_name : null;
    switch (m.function) {
      case '__e': return 'Event';
      case '__v': return name ? `DLV - ${name}` : 'Data Layer Variable';
      case '__j': return name ? `JS - ${name}` : 'JavaScript Variable';
      case '__k': return name ? `Cookie - ${name}` : 'Cookie';
      case '__u': return m.vtp_component ? `Page ${cap(m.vtp_component)}` : 'Page URL';
      case '__aev': return m.vtp_varType ? `Click/Form ${cap(m.vtp_varType)}` : 'Auto-Event Variable';
      case '__c': return `Constant "${str(m.vtp_value)}"`;
      case '__jsm': return `Custom JS #${i}`;
      case '__smm': return `Lookup Table #${i}`;
      case '__remm': return `RegEx Table #${i}`;
      default: return VAR_TYPES[m.function] || m.function?.replace(/^__/, '') || `var #${i}`;
    }
  };
  const tagId = (i) => (tags[i] ? tags[i].tag_id ?? i : i);
  const ctx = { varLabel, tagId };
  const fmt = (v) => formatValue(v, ctx);

  const predText = (i) => {
    const p = preds[i];
    if (!p) return `condition #${i}`;
    const left = str(fmt(p.arg0));
    const right = str(fmt(p.arg1));
    const op = p.negate ? (NEG_OPS[p.function] || `not ${p.function}`) : (OPS[p.function] || p.function);
    let text = `${left} ${op} ${right}`;
    if (p.ignore_case) text += ' (ignore case)';
    if (left === '{{Event}}' && EVENT_HINTS[right]) text += `  [${EVENT_HINTS[right]}]`;
    return text;
  };

  const firing = tags.map(() => []);
  const blocking = tags.map(() => []);
  const triggers = rules.map((rule) => {
    const ifs = [], unless = [], adds = [], blocks = [];
    for (const [op, ...ix] of rule) {
      if (op === 'if') ifs.push(...ix);
      else if (op === 'unless') unless.push(...ix);
      else if (op === 'add') adds.push(...ix);
      else if (op === 'block') blocks.push(...ix);
    }
    const conds = [...ifs.map(predText), ...unless.map((i) => `NOT (${predText(i)})`)];
    const text = conds.length ? conds.join('  AND  ') : '(always)';
    adds.forEach((t) => firing[t]?.push(text));
    blocks.forEach((t) => blocking[t]?.push(text));
    return { conditions: conds, fires: adds.map(tagId), blocks: blocks.map(tagId) };
  });

  const outTags = tags.map((t, i) => {
    const fn = t.function || '';
    const params = {};
    for (const [k, v] of Object.entries(t)) {
      if (k.startsWith('vtp_')) params[k.slice(4)] = fmt(v);
    }
    if (t.consent) params['(consent required)'] = fmt(t.consent);
    if (t.setup_tags) params['(setup tag)'] = fmt(t.setup_tags);
    if (t.teardown_tags) params['(cleanup tag)'] = fmt(t.teardown_tags);
    if (t.priority) params['(priority)'] = t.priority;
    let vendors = [];
    if (fn === '__html' || fn === '__img' || fn.startsWith('__cvt_')) vendors = detectVendors(JSON.stringify(params) + (fn.startsWith('__cvt_') ? ' ' + templateUrls(fn) : ''), { params: fn.startsWith('__cvt_') });
    let category = 'tag';
    if (LISTENERS.has(fn)) category = 'listener';
    else if (/^__(ogt|ccd)_/.test(fn) || fn === '__tg') category = 'internal';
    return {
      index: i,
      id: t.tag_id ?? i,
      fn,
      type: TAG_TYPES[fn] || (fn.startsWith('__cvt_') ? (vendors.length ? `Custom Template · ${vendors[0]}` : `Custom Template (${fn.replace(/^__cvt_/, '')})`) : fn.replace(/^__/, '')),
      vendors,
      category,
      paused: fn === '__paused' || !!t.paused,
      once: t.once_per_load ? 'Once per page' : t.once_per_event ? 'Once per event' : 'Unlimited',
      params,
      firing: firing[i],
      blocking: blocking[i],
    };
  });

  const variables = macros.map((m, i) => {
    const params = {};
    for (const [k, v] of Object.entries(m)) if (k.startsWith('vtp_')) params[k.slice(4)] = fmt(v);
    return {
      index: i,
      label: varLabel(i),
      fn: m.function,
      type: VAR_TYPES[m.function] || (m.function?.startsWith('__cvt_') ? 'Custom Template' : m.function),
      params,
    };
  });

  // Server-side tagging settings (Google tag "server_container_url" / "transport_url")
  const raw = JSON.stringify(resource);
  const serverUrls = new Set();
  for (const m of raw.matchAll(/"(?:server_container_url|transport_url)","parameterValue","([^"]+)"/g)) serverUrls.add(m[1]);
  for (const m of raw.matchAll(/"vtp_(?:serverContainerUrl|transportUrl|server_container_url|transport_url)":"([^"]+)"/g)) serverUrls.add(m[1]);
  const serverUrlViaVariable = /"(?:server_container_url|transport_url)","parameterValue",\["macro"/.test(raw);
  const enhancedConversions = tags.some((t) => t.function === '__awud' || t.vtp_enableEnhancedConversion === true || t.vtp_userDataVariable != null);

  return { resource, version: resource.version, tags: outTags, variables, triggers, serverUrls: [...serverUrls], serverUrlViaVariable, enhancedConversions };
}

function formatValue(v, ctx) {
  if (!Array.isArray(v)) return v;
  const [kind, ...rest] = v;
  switch (kind) {
    case 'macro': return `{{${ctx.varLabel(rest[0])}}}`;
    case 'escape': return formatValue(rest[0], ctx);
    case 'template': return rest.map((x) => { const f = formatValue(x, ctx); return typeof f === 'string' ? f : str(f); }).join('');
    case 'list': return rest.map((x) => formatValue(x, ctx));
    case 'map': {
      const o = {};
      for (let i = 0; i < rest.length; i += 2) o[str(formatValue(rest[i], ctx))] = formatValue(rest[i + 1], ctx);
      return o;
    }
    case 'tag': return `tag #${ctx.tagId(rest[0])}`;
    default: return v.map((x) => formatValue(x, ctx));
  }
}

function cap(s) {
  s = String(s).toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
