import { parseContainer } from './parser.js';
import { collectPage } from './collector.js';
import { detectVendors } from './vendors.js';
import { analyzeServerSide } from './sst.js';
import { buildConversionMap, conversionCsv } from './conversions.js';
import { extractAccountIds, siteBrand, adLibraryLinks } from './ids.js';
import { buildMediaMix } from './mediamix.js';
import { analyzeRecording, recordingCsv } from './recording.js';
import { scanPromos } from './promo-collect.js';
import { analyzePromos, promosCsv } from './promos.js';
import { analyzeCost, costCsv } from './cost.js';

const $ = (s) => document.querySelector(s);
const state = {
  tabId: null, page: null, views: [], current: 0,
  gtm: {},                       // id -> { data, error, url }
  sub: { gtm: 'tags', launch: 'rules' },
  dl: 0, showSys: false, showGtmEvents: false,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '');
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const chips = (arr) => (arr || []).map((v) => `<span class="chip">${esc(v)}</span>`).join('');
const matches = (obj, q) => !q || JSON.stringify(obj).toLowerCase().includes(q);
const query = () => ($('#q')?.value || '').trim().toLowerCase();

function setStatus(msg, kind = '') {
  const el = $('#status');
  el.textContent = msg;
  el.className = kind;
  el.hidden = !msg;
}

const defaultUrl = (id) =>
  id.startsWith('GTM-') ? `https://www.googletagmanager.com/gtm.js?id=${id}` : `https://www.googletagmanager.com/gtag/js?id=${id}`;

// ---------- Collection ----------

async function collect() {
  setStatus('Reading the page…');
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, world: 'MAIN', func: collectPage });
  state.page = result;
  const conts = [...result.containers].sort((a, b) => (b.id.startsWith('GTM-') - a.id.startsWith('GTM-')) || a.id.localeCompare(b.id));
  const views = [
    { kind: 'overview', label: 'Overview' },
    { kind: 'conv', label: 'Conversions' },
    { kind: 'rec', label: '● Recorder' },
    { kind: 'promos', label: 'Promos' },
    { kind: 'cost', label: 'Cost' },
    ...conts.map((c) => ({ kind: 'gtm', id: c.id, src: c.src, label: c.id })),
  ];
  if (result.launch) views.push({ kind: 'launch', label: 'Adobe Launch' });
  views.push({ kind: 'dl', label: 'Data Layer' });
  views.push({ kind: 'sst', label: 'Server-side' });
  const prev = state.views[state.current];
  state.views = views;
  const keep = prev ? views.findIndex((v) => v.kind === prev.kind && v.id === prev.id) : -1;
  state.current = keep >= 0 ? keep : 0;
  state.noContainers = !(conts.length || result.launch);
  setStatus('');
  renderNav();
  await selectView(state.current);
}

async function loadGtm(id, src) {
  if (state.gtm[id]) return state.gtm[id];
  const entry = (state.gtm[id] = { data: null, error: null, url: src || defaultUrl(id) });
  try {
    let text = null;
    try {
      const r = await fetch(entry.url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text = await r.text();
    } catch {
      // First-party / server-side GTM domains: fetch from inside the page instead.
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: state.tabId }, world: 'MAIN', args: [entry.url],
        func: async (u) => { try { const r = await fetch(u); return r.ok ? await r.text() : null; } catch { return null; } },
      });
      text = result;
    }
    if (!text) throw new Error(`Couldn't download ${entry.url}`);
    entry.data = parseContainer(text);
  } catch (e) {
    entry.error = e.message;
  }
  return entry;
}

// ---------- Navigation ----------

function renderNav() {
  const nav = $('#views');
  nav.innerHTML = state.views.map((v, i) =>
    `<button data-i="${i}" class="${v.kind === 'gtm' ? 'gtm' : ''}${i === state.current ? ' active' : ''}">${esc(v.label)}</button>`).join('');
  nav.querySelectorAll('button').forEach((b) => (b.onclick = () => selectView(+b.dataset.i)));
}

async function selectView(i) {
  state.current = i;
  renderNav();
  const v = state.views[i];
  if (!v) return;
  if (v.kind === 'gtm' && !state.gtm[v.id]?.data && !state.gtm[v.id]?.error) {
    $('#main').hidden = true;
    setStatus(`Downloading ${v.id}…`);
    await loadGtm(v.id, v.src);
  }
  if (v.kind === 'sst' || v.kind === 'overview' || v.kind === 'conv') {
    $('#main').hidden = true;
    setStatus('Downloading containers…');
    await Promise.all(state.views.filter((x) => x.kind === 'gtm' && x.id.startsWith('GTM-')).map((x) => loadGtm(x.id, x.src)));
  }
  if (v.kind === 'rec' || v.kind === 'overview') await loadRecording();
  if (v.kind === 'promos') await loadPromos();
  if (state.views[state.current] !== v) return;
  if (v.kind === 'gtm' && state.gtm[v.id].error) {
    $('#main').hidden = true;
    $('#toolbar').innerHTML = $('#list').innerHTML = $('#summary').innerHTML = '';
    return setStatus(`${v.id}: ${state.gtm[v.id].error}`, 'err');
  }
  setStatus('');
  $('#main').hidden = false;
  renderView();
}

const VIEWS = {};

function renderView() {
  const v = state.views[state.current];
  VIEWS[v.kind].header(v);
  const q = $('#q');
  if (q) q.oninput = () => VIEWS[v.kind].list(v);
  $('#toolbar').querySelectorAll('[data-sub]').forEach((b) => (b.onclick = () => { state.sub[v.kind] = b.dataset.sub; renderView(); }));
  VIEWS[v.kind].list(v);
}

function toolbar({ tabs = [], active, filter = true, extra = '', actions = '' }) {
  $('#toolbar').innerHTML =
    (tabs.length ? `<div class="tabs">${tabs.map(([k, l]) => `<button data-sub="${k}" class="${k === active ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>` : '') +
    (filter ? '<input id="q" type="search" placeholder="Filter…">' : '') +
    extra +
    `<div class="actions">${actions}</div>`;
}

function paramsTable(params) {
  const rows = Object.entries(params || {});
  if (!rows.length) return '<div class="empty">No settings</div>';
  return `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td><pre>${esc(trunc(show(v), 4000))}</pre></td></tr>`).join('')}</table>`;
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileBase = () => (state.page?.host || 'site').replace(/^www\./, '');
const exportJson = (name, obj) => download(`${fileBase()}_${name}.json`, JSON.stringify(obj, null, 2), 'application/json');

function countBy(arr) {
  const m = {};
  arr.forEach((x) => (m[x] = (m[x] || 0) + 1));
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

// ---------- GTM view ----------

const KEY_PARAMS = ['eventName', 'measurementIdOverride', 'measurementId', 'tagId', 'conversionId', 'conversionLabel', 'trackingId', 'url', 'html'];
function keyParam(t) {
  for (const k of KEY_PARAMS) if (t.params[k] != null) return `${k}: ${show(t.params[k]).replace(/\s+/g, ' ').slice(0, 90)}`;
  return '';
}

VIEWS.gtm = {
  header(v) {
    const { data } = state.gtm[v.id];
    const active = data.tags.filter((t) => t.category === 'tag' && !t.paused);
    const paused = data.tags.filter((t) => t.paused).length;
    const vendors = countBy(active.flatMap((t) => t.vendors));
    $('#summary').innerHTML =
      `<b>${esc(v.id)}</b> · version <b>${esc(data.version ?? '?')}</b> · <b>${active.length}</b> active tags` +
      (paused ? ` · ${paused} paused` : '') +
      ` · <b>${data.triggers.length}</b> trigger rules · <b>${data.variables.length}</b> variables` +
      (vendors.length ? `<div class="chips">${chips(vendors.map(([n, c]) => `${n} ×${c}`))}</div>` : '');
    toolbar({
      tabs: [['tags', 'Tags'], ['vars', 'Variables']], active: state.sub.gtm,
      extra: state.sub.gtm === 'tags' ? `<label class="check"><input type="checkbox" id="showSys" ${state.showSys ? 'checked' : ''}> listeners & internal</label>` : '',
      actions: '<button id="csv">CSV</button><button id="json">JSON</button>',
    });
    const sys = $('#showSys');
    if (sys) sys.onchange = () => { state.showSys = sys.checked; this.list(v); };
    $('#csv').onclick = () => exportGtmCsv(v.id);
    $('#json').onclick = () => {
      const e = state.gtm[v.id];
      exportJson(v.id, { container: v.id, source: e.url, page: state.page.host, version: e.data.version, tags: e.data.tags, triggers: e.data.triggers, variables: e.data.variables, raw: e.data.resource });
    };
  },
  list(v) {
    const { data } = state.gtm[v.id];
    const q = query();
    if (state.sub.gtm === 'vars') {
      const vars = data.variables.filter((x) => matches(x, q));
      $('#list').innerHTML = vars.length
        ? vars.map((x) => `<details><summary><span class="type">${esc(x.label)}</span><span class="meta">${esc(x.type || '')}</span></summary>
            <div class="body"><h4>Settings</h4>${paramsTable(x.params)}</div></details>`).join('')
        : '<div class="empty">No variables match.</div>';
      return;
    }
    const tags = data.tags.filter((t) => (state.showSys || t.category === 'tag') && matches(t, q));
    $('#list').innerHTML = tags.length
      ? tags.map((t) => `
        <details>
          <summary>
            <span class="type">${esc(t.type)}</span><span class="meta">#${esc(t.id)} · ${esc(t.fn)}</span>
            ${t.paused ? '<span class="badge">paused</span>' : ''}
            ${t.category !== 'tag' ? `<span class="badge">${t.category}</span>` : ''}
            ${!t.firing.length && t.category === 'tag' && !t.paused ? '<span class="badge">no trigger</span>' : ''}
            ${t.vendors.length && !t.type.includes(t.vendors[0]) ? `<div>${chips(t.vendors)}</div>` : ''}
            <div class="sub">${esc(keyParam(t))}</div>
          </summary>
          <div class="body">
            <h4>Fires on (any of)</h4>
            ${t.firing.length ? `<ul>${t.firing.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<div class="empty">No firing trigger (may run as a setup/cleanup tag)</div>'}
            ${t.blocking.length ? `<h4>Exceptions</h4><ul>${t.blocking.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
            <h4>Firing frequency</h4><div>${esc(t.once)}</div>
            <h4>Settings</h4>${paramsTable(t.params)}
          </div>
        </details>`).join('') +
        '<div class="note">GTM strips tag and trigger names from published containers, so tags are shown by type and ID.</div>'
      : '<div class="empty">No tags match.</div>';
  },
};

function exportGtmCsv(id) {
  const { data } = state.gtm[id];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Tag ID', 'Type', 'Vendor', 'Function', 'Status', 'Fires On', 'Exceptions', 'Key Setting', 'All Settings']];
  data.tags.filter((t) => t.category === 'tag').forEach((t) =>
    rows.push([t.id, t.type, t.vendors.join(' / '), t.fn, t.paused ? 'Paused' : 'Active', t.firing.join(' | '), t.blocking.join(' | '), keyParam(t), JSON.stringify(t.params)]));
  download(`${fileBase()}_${id}_tags.csv`, rows.map((r) => r.map(cell).join(',')).join('\n'), 'text/csv');
}

// ---------- Adobe Launch view ----------

const compVendors = (c) => detectVendors((c.code || '') + ' ' + (c.external || '') + ' ' + JSON.stringify(c.settings || {}));
const compLabel = (c) => `${c.negate ? 'NOT ' : ''}${c.ext}: ${c.type}`;
const compBrief = (c) => {
  const s = JSON.stringify(c.settings || {});
  return s === '{}' ? '' : trunc(s, 160);
};
function ruleVendors(r) {
  return [...new Set(r.actions.flatMap(compVendors).concat(r.actions.some((a) => a.ext === 'adobe-analytics') ? ['Adobe Analytics'] : []).concat(r.actions.some((a) => a.ext.startsWith('adobe-target')) ? ['Adobe Target'] : []))];
}
function compBlock(c) {
  const vend = compVendors(c);
  const brief = compBrief(c);
  return `<div class="action"><span class="type">${esc(compLabel(c))}</span>${vend.length ? ' ' + chips(vend) : ''}
    ${brief ? `<pre>${esc(brief)}</pre>` : ''}
    ${c.code ? `<pre>${esc(trunc(c.code, 4000))}</pre>` : c.external ? `<div class="note">External code: ${esc(c.external)} (couldn't fetch)</div>` : ''}</div>`;
}

VIEWS.launch = {
  header() {
    const L = state.page.launch;
    const built = L.buildInfo?.buildDate ? new Date(L.buildInfo.buildDate).toLocaleDateString() : '?';
    const vendors = countBy(L.rules.flatMap(ruleVendors));
    $('#summary').innerHTML =
      `<b>${esc(L.property || 'Adobe Launch')}</b> · ${esc(L.environment || '')} · built <b>${esc(built)}</b> · <b>${L.rules.length}</b> rules · <b>${L.dataElements.length}</b> data elements` +
      `<div class="chips">${chips(L.extensions.map((e) => e.name))}</div>` +
      (vendors.length ? `<div class="chips">${chips(vendors.map(([n, c]) => `${n} ×${c}`))}</div>` : '');
    toolbar({
      tabs: [['rules', 'Rules'], ['de', 'Data Elements'], ['ext', 'Extensions']], active: state.sub.launch,
      actions: '<button id="json">JSON</button>',
    });
    $('#json').onclick = () => exportJson('adobe-launch', L);
  },
  list() {
    const L = state.page.launch;
    const q = query();
    const sub = state.sub.launch;
    if (sub === 'ext') {
      $('#list').innerHTML = L.extensions.filter((e) => matches(e, q)).map((e) =>
        `<details><summary><span class="type">${esc(e.name)}</span><span class="meta">${esc(e.id)}</span></summary>
         <div class="body"><pre>${esc(trunc(show(e.settings), 8000))}</pre></div></details>`).join('') || '<div class="empty">No extensions match.</div>';
      return;
    }
    if (sub === 'de') {
      $('#list').innerHTML = L.dataElements.filter((d) => matches(d, q)).map((d) =>
        `<details><summary><span class="type">${esc(d.name)}</span><span class="meta">${esc(d.ext)}: ${esc(d.type)}</span>
           <div class="sub">${esc(compBrief(d))}</div></summary>
         <div class="body">${compBlock(d)}${d.storageDuration ? `<div class="note">Stored for: ${esc(d.storageDuration)}</div>` : ''}</div></details>`).join('') || '<div class="empty">No data elements match.</div>';
      return;
    }
    const rules = L.rules.filter((r) => matches(r, q));
    $('#list').innerHTML = rules.length
      ? rules.map((r) => {
          const vend = ruleVendors(r);
          const when = r.events.map((e) => e.type).join(', ');
          return `<details>
            <summary><span class="type">${esc(r.name)}</span>
              <div class="sub">When: ${esc(when || '—')} · ${r.conditions.length} condition(s) · ${r.actions.length} action(s)</div>
              ${vend.length ? `<div>${chips(vend)}</div>` : ''}</summary>
            <div class="body">
              <h4>Events</h4>${r.events.map(compBlock).join('') || '<div class="empty">None</div>'}
              ${r.conditions.length ? `<h4>Conditions</h4>${r.conditions.map(compBlock).join('')}` : ''}
              <h4>Actions</h4>${r.actions.map(compBlock).join('') || '<div class="empty">None</div>'}
            </div></details>`;
        }).join('') + '<div class="note">Vendor tags are matched by fingerprints in each action’s custom code.</div>'
      : '<div class="empty">No rules match.</div>';
  },
};

// ---------- Data layer view ----------

function entryLabel(e) {
  if (e && typeof e === 'object') {
    if (e.event) return String(e.event);
    if (Array.isArray(e.gtag)) return `gtag: ${e.gtag.slice(0, 2).map((x) => (typeof x === 'string' ? x : '{…}')).join(' ')}`;
  }
  return '(no event)';
}
function keyPaths(o, prefix = '', depth = 0, out = new Set()) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 2) return out;
  for (const k of Object.keys(o)) {
    if (k === 'gtm.uniqueEventId' || k === 'event') continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && depth < 2) keyPaths(o[k], p, depth + 1, out);
    else out.add(p);
  }
  return out;
}

VIEWS.dl = {
  header() {
    const layers = state.page.dataLayers;
    if (state.dl >= layers.length) state.dl = 0;
    const L = layers[state.dl];
    $('#summary').innerHTML = layers.length
      ? `${layers.length} data layer(s) found · <b>${esc(L.name)}</b>` + (L.kind === 'array' ? ` · <b>${L.entries.length}</b> pushes` : ' · object snapshot') +
        '<div class="note" style="margin-top:2px">Tip: click through the site (booking flow, forms), then reopen the popup or hit Refresh to see the new pushes.</div>'
      : 'No data layer found (checked dataLayer, adobeDataLayer, digitalData, utag_data).';
    toolbar({
      filter: !!layers.length,
      extra: (layers.length > 1 ? `<select id="layer">${layers.map((l, i) => `<option value="${i}" ${i === state.dl ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : '') +
        (L?.kind === 'array' ? `<label class="check"><input type="checkbox" id="gtmEv" ${state.showGtmEvents ? 'checked' : ''}> gtm.* events</label>` : ''),
      actions: layers.length ? '<button id="json">JSON</button>' : '',
    });
    const sel = $('#layer');
    if (sel) sel.onchange = () => { state.dl = +sel.value; renderView(); };
    const ge = $('#gtmEv');
    if (ge) ge.onchange = () => { state.showGtmEvents = ge.checked; this.list(); };
    if ($('#json')) $('#json').onclick = () => exportJson('datalayer', state.page.dataLayers);
  },
  list() {
    const L = state.page.dataLayers[state.dl];
    if (!L) { $('#list').innerHTML = ''; return; }
    const q = query();
    if (L.kind === 'object') {
      const paths = [...keyPaths(L.snapshot)];
      $('#list').innerHTML = `<details open><summary><span class="type">Keys</span><span class="meta">${paths.length}</span></summary>
        <div class="body"><ul>${paths.filter((p) => !q || p.toLowerCase().includes(q)).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div></details>
        <details><summary><span class="type">Full snapshot</span></summary><div class="body"><pre>${esc(trunc(show(L.snapshot), 20000))}</pre></div></details>`;
      return;
    }
    const entries = L.entries.map((e, i) => ({ i, e, label: entryLabel(e) }))
      .filter((x) => state.showGtmEvents || !/^gtm\./.test(x.label))
      .filter((x) => matches(x.e, q) || x.label.toLowerCase().includes(q));
    // Event schema: each event name -> times pushed + every key path seen with it
    const schema = {};
    for (const { e, label } of entries) {
      const s = (schema[label] ||= { n: 0, keys: new Set() });
      s.n++;
      if (!Array.isArray(e?.gtag)) keyPaths(e, '', 0, s.keys);
    }
    const schemaRows = Object.entries(schema).sort((a, b) => b[1].n - a[1].n);
    $('#list').innerHTML =
      (schemaRows.length ? `<details open><summary><span class="type">Event schema</span><span class="meta">${schemaRows.length} distinct events</span></summary>
        <div class="body"><table class="schema">${schemaRows.map(([ev, s]) => `<tr><td>${esc(ev)}</td><td>×${s.n}</td><td>${esc(trunc([...s.keys].join(', '), 600) || '—')}</td></tr>`).join('')}</table></div></details>` : '') +
      (entries.length ? entries.map(({ i, e, label }) => `<details><summary><span class="type">${esc(label)}</span><span class="meta">#${i}</span>
          <div class="sub">${esc(trunc([...keyPaths(e)].join(', '), 140))}</div></summary>
          <div class="body"><pre>${esc(trunc(show(e), 12000))}</pre></div></details>`).join('')
        : '<div class="empty">No pushes match.</div>');
  },
};

// ---------- Server-side view ----------

const VERDICT = { yes: 'Detected', likely: 'Likely', no: 'Not seen', info: 'Info' };
VIEWS.sst = {
  header() {
    const gtm = state.views.filter((v) => v.kind === 'gtm').map((v) => ({ id: v.id, data: state.gtm[v.id]?.data }));
    this.findings = analyzeServerSide(state.page, gtm, state.page.launch);
    const yes = this.findings.filter((f) => f.verdict === 'yes').length;
    const likely = this.findings.filter((f) => f.verdict === 'likely').length;
    $('#summary').innerHTML = `<b>${yes}</b> server-side / first-party signals detected` + (likely ? `, <b>${likely}</b> likely` : '') +
      '<div class="note" style="margin-top:2px">Server-to-server traffic (Conversions API, Events API, offline uploads) is invisible to the browser. These are the client-side fingerprints it leaves. Conversion pages show more than the homepage.</div>';
    toolbar({ filter: false, actions: '<button id="json">JSON</button>' });
    $('#json').onclick = () => exportJson('server-side', this.findings);
  },
  list() {
    const order = { yes: 0, likely: 1, info: 2, no: 3 };
    const f = [...this.findings].sort((a, b) => order[a.verdict] - order[b.verdict]);
    $('#list').innerHTML = f.map((x) => `<details ${x.verdict === 'yes' || x.verdict === 'likely' ? 'open' : ''}>
      <summary><span class="v ${x.verdict}">${VERDICT[x.verdict]}</span><span class="type">${esc(x.signal)}</span>
        <div class="sub" style="white-space:normal">${esc(x.detail)}</div></summary>
      ${x.evidence.length ? `<div class="body"><h4>Evidence</h4><ul>${x.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    </details>`).join('');
  },
};

// ---------- Shared helpers for the intel views ----------

const gtmLoaded = () => state.views.filter((v) => v.kind === 'gtm' && state.gtm[v.id]?.data).map((v) => ({ id: v.id, data: state.gtm[v.id].data }));
const flagBadge = ([kind, text]) => `<span class="v ${kind === 'bad' ? 'bad' : kind === 'warn' ? 'likely' : kind === 'paused' ? 'no' : 'info'}">${esc(text)}</span>`;
const section = (title, meta, body, open = true) =>
  `<details ${open ? 'open' : ''}><summary><span class="type">${esc(title)}</span>${meta ? `<span class="meta">${esc(meta)}</span>` : ''}</summary><div class="body">${body}</div></details>`;
const storageGet = async (area, key) => { try { return (await chrome.storage[area].get(key))[key]; } catch { return undefined; } };

async function loadRecording() {
  state.recOn = !!(await storageGet('session', 'recState'))?.[state.tabId];
  state.rec = (await storageGet('session', 'rec_' + state.tabId)) || null;
  state.recAnalysis = state.rec ? analyzeRecording(state.rec) : null;
}

// ---------- Overview: media mix, agencies, account IDs, ad libraries ----------

VIEWS.overview = {
  header() {
    const gtm = gtmLoaded();
    const extraUrls = state.recAnalysis?.urls || [];
    this.mix = buildMediaMix({ page: state.page, gtm, launch: state.page.launch, extraUrls });
    this.ids = extractAccountIds({ page: state.page, gtm, launch: state.page.launch, extraUrls });
    const failed = state.views.filter((v) => v.kind === 'gtm' && v.id.startsWith('GTM-') && state.gtm[v.id]?.error).map((v) => v.id);
    $('#summary').innerHTML =
      `<b>${this.mix.total}</b> marketing vendors across <b>${this.mix.channels.length}</b> channels · <b>${this.ids.reduce((s, p) => s + p.ids.length, 0)}</b> account / pixel IDs` +
      (this.mix.notes.length ? `<div class="note" style="margin-top:4px;color:var(--fg)">${esc(this.mix.notes.join(' · '))}</div>` : '') +
      (this.mix.syncPartners?.length ? `<div class="note">Cookie-sync partners (fired by their ad vendors, not bought directly): ${esc(this.mix.syncPartners.join(', '))}</div>` : '') +
      (state.recAnalysis ? '<div class="note">Includes vendors seen in this tab\'s recording.</div>' : '<div class="note">Based on the tag containers and this page load. Record a funnel to catch vendors that only load on later steps.</div>') +
      (failed.length ? `<div class="note" style="color:var(--warn)">Couldn't download ${esc(failed.join(', '))}.</div>` : '');
    toolbar({ filter: false, actions: '<button id="json">JSON</button>' });
    $('#json').onclick = () => exportJson('overview', { mediaMix: this.mix, accountIds: this.ids });
  },
  async list() {
    const { domain, brand: guess } = siteBrand(state.page.host);
    const saved = await storageGet('local', 'brand_' + domain);
    const brand = saved || guess;
    const mixRows = this.mix.channels.map((c) =>
      `<tr><td>${esc(c.channel)}</td><td>${c.vendors.map((v) => `<span class="chip" title="Seen in: ${esc(v.where.join(', '))}">${esc(v.name)}</span>`).join('')}</td></tr>`).join('');
    const agencies = this.mix.agencies.length
      ? this.mix.agencies.map((a) => `<div class="action"><span class="type">${esc(a.name)}</span><ul>${a.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`).join('') +
        '<div class="note">Fingerprints in pixel URLs and tag code, such as a trading desk\'s account name. They point to who buys the media; they aren\'t proof.</div>'
      : '<div class="empty">No agency fingerprints found.</div>';
    const idRows = this.ids.map((p) =>
      `<tr><td>${esc(p.platform)}</td><td>${p.ids.map((i) => `<code class="id" title="${esc(i.sources.slice(0, 6).join('\n'))}">${esc(i.id)}</code>`).join(' ')}</td></tr>`).join('');
    const links = adLibraryLinks({ domain, brand }, this.ids.map((p) => p.platform).concat(this.mix.channels.flatMap((c) => c.vendors.map((v) => v.name))));
    $('#list').innerHTML =
      section('Media mix', `${this.mix.total} vendors`, `<table class="schema">${mixRows}</table>`) +
      section('Agency signals', `${this.mix.agencies.length}`, agencies, this.mix.agencies.length > 0) +
      section('Ad accounts & pixel IDs', `${this.ids.length} platforms`, idRows ? `<table class="schema">${idRows}</table><div class="note">Hover an ID to see where it was found.</div>` : '<div class="empty">None found.</div>') +
      section('See their ads', '', `
        <div class="toolbar" style="margin-bottom:6px"><label class="check">Brand name for searches <input id="brand" value="${esc(brand)}" style="width:160px"></label><span class="note">Domain: ${esc(domain)}</span></div>
        <div class="links">${links.map((l) => `<a class="btn${l.relevant ? ' rel' : ''}" target="_blank" href="${esc(l.url)}">${esc(l.name)}</a>`).join('')}</div>
        <div class="note">Highlighted libraries match platforms detected on this site. Google's search is by domain; the others search by the brand name above.</div>`);
    const inp = $('#brand');
    inp.onchange = async () => {
      try { await chrome.storage.local.set({ ['brand_' + domain]: inp.value.trim() }); } catch {}
      this.list();
    };
  },
};

// ---------- Conversions ----------

VIEWS.conv = {
  header() {
    this.rows = buildConversionMap({ gtm: gtmLoaded(), launch: state.page.launch, page: state.page });
    const platforms = countBy(this.rows.filter((r) => !r.paused).map((r) => r.platform));
    const flagged = this.rows.filter((r) => r.flags.some((f) => f[0] === 'bad' || f[0] === 'warn')).length;
    $('#summary').innerHTML = this.rows.length
      ? `<b>${this.rows.filter((r) => !r.paused).length}</b> active conversion tags across <b>${platforms.length}</b> platforms · <b>${flagged}</b> flagged` +
        `<div class="chips">${chips(platforms.map(([n, c]) => `${n} ×${c}`))}</div>`
      : 'No conversion tags found in this page\'s containers.' + (state.noContainers ? ' (No GTM or Adobe Launch container on this page.)' : '');
    toolbar({
      extra: `<label class="check"><input type="checkbox" id="flaggedOnly" ${state.flaggedOnly ? 'checked' : ''}> flagged only</label>`,
      actions: '<button id="csv">CSV</button>',
    });
    $('#flaggedOnly').onchange = (e) => { state.flaggedOnly = e.target.checked; this.list(); };
    $('#csv').onclick = () => download(`${fileBase()}_conversions.csv`, conversionCsv(this.rows), 'text/csv');
  },
  list() {
    const q = query();
    const rows = this.rows.filter((r) => (!state.flaggedOnly || r.flags.some((f) => f[0] !== 'info')) && matches({ ...r, firing: r.triggerText }, q));
    const byP = {};
    rows.forEach((r) => (byP[r.platform] ||= []).push(r));
    const order = Object.keys(byP).sort((a, b) => byP[b].length - byP[a].length);
    $('#list').innerHTML = order.length ? order.map((p) => section(p, `${byP[p].length}`, byP[p].map((r) => `
      <details>
        <summary><span class="type">${esc(trunc(r.event, 70))}</span><span class="meta">${esc(r.account || '')}</span>
          <div class="sub">Value: ${esc(trunc(r.valueText, 80))}${r.currency ? ' ' + esc(r.currency) : ''} · ${esc(r.container)} ${esc(r.tag)}</div>
          ${r.flags.length ? `<div>${r.flags.map(flagBadge).join('')}</div>` : ''}</summary>
        <div class="body">
          <h4>Fires on (any of)</h4>${r.firing?.length ? `<ul>${r.firing.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<div class="empty">No trigger</div>'}
          ${r.blocking?.length ? `<h4>Exceptions</h4><ul>${r.blocking.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          <h4>Value sent</h4><pre>${esc(r.valueText)}</pre>
          <h4>Source</h4><div>${esc(r.container)} · ${esc(r.tag)} · ${esc(r.tagType)}${r.how ? ' · ' + esc(r.how) : ''}</div>
        </div>
      </details>`).join(''))).join('') +
      '<div class="note">Built from the published tag setup, so it shows what each platform is told, whatever the platform\'s own settings say. Use the Recorder to see real values on a live flow.</div>'
      : '<div class="empty">Nothing matches.</div>';
  },
};

// ---------- Recorder ----------

const fmtT = (t, start) => (start ? '+' + ((t - start) / 1000).toFixed(1) + 's' : new Date(t).toLocaleTimeString());
const money = (v, c) => (v == null ? '' : `${v}${c ? ' ' + c : ''}`);

VIEWS.rec = {
  header() {
    const A = state.recAnalysis;
    const n = state.rec?.items?.length || 0;
    const pages = A ? A.timeline.filter((r) => r.type === 'page').length : 0;
    $('#summary').innerHTML = state.recOn
      ? `<span class="v bad">● Recording</span> this tab since ${new Date(state.rec?.started || Date.now()).toLocaleTimeString()} · <b>${n}</b> captured items · <b>${pages}</b> pages` +
        '<div class="note">Click through the site in this tab. You can close this popup; recording continues until you stop it or close the tab.</div>'
      : n
        ? `Stopped · <b>${n}</b> captured items · <b>${pages}</b> pages`
        : 'Records every data layer push and tracking pixel while you click through a flow (search → booking → checkout), across page loads. Nothing is saved until you press Record, and recordings are cleared when you close the tab or browser.';
    toolbar({
      tabs: n ? [['timeline', 'Timeline'], ['platforms', 'Pixels by platform'], ['funnel', 'Funnel']] : [],
      active: state.sub.rec || 'timeline',
      filter: !!n,
      extra: n && (state.sub.rec || 'timeline') === 'timeline'
        ? `<label class="check"><input type="checkbox" id="recSys" ${state.recSys ? 'checked' : ''}> system events</label><label class="check"><input type="checkbox" id="recDl" ${state.recHideDl ? '' : 'checked'}> data layer</label><label class="check"><input type="checkbox" id="recPx" ${state.recHidePx ? '' : 'checked'}> pixels</label>`
        : '',
      actions: (state.recOn ? '<button id="recStop" class="danger">■ Stop</button>' : '<button id="recStart" class="primary">● Record</button>') +
        (n ? '<button id="recClear">Clear</button><button id="csv">CSV</button><button id="json">JSON</button>' : ''),
    });
    const s = $('#recSys'); if (s) s.onchange = () => { state.recSys = s.checked; this.list(); };
    const d = $('#recDl'); if (d) d.onchange = () => { state.recHideDl = !d.checked; this.list(); };
    const p = $('#recPx'); if (p) p.onchange = () => { state.recHidePx = !p.checked; this.list(); };
    const send = async (type) => {
      const r = await chrome.runtime.sendMessage({ type, tabId: state.tabId });
      if (r && r.ok === false) setStatus(`Recorder: ${r.error}`, 'err');
      else if (r && r.injected) setStatus('Recording started. This page was open before the extension loaded, so reload it to capture from the very first event.', '');
      await loadRecording();
      renderView();
    };
    if ($('#recStart')) $('#recStart').onclick = () => send('rec-start');
    if ($('#recStop')) $('#recStop').onclick = () => send('rec-stop');
    if ($('#recClear')) $('#recClear').onclick = () => send('rec-clear');
    if ($('#csv')) $('#csv').onclick = () => download(`${fileBase()}_recording.csv`, recordingCsv(state.recAnalysis), 'text/csv');
    if ($('#json')) $('#json').onclick = () => exportJson('recording', { analysis: { ...state.recAnalysis, timeline: undefined }, raw: state.rec });
  },
  list() {
    const A = state.recAnalysis;
    if (!A || !A.timeline.length) { $('#list').innerHTML = state.recOn ? '<div class="empty">Waiting for activity…</div>' : ''; return; }
    const q = query();
    const sub = state.sub.rec || 'timeline';
    const anomalies = A.anomalies.length
      ? section('Things to check', `${A.anomalies.length}`, `<ul class="plain">${A.anomalies.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ul>`)
      : '';

    if (sub === 'platforms') {
      const ps = Object.entries(A.platforms).sort((a, b) => a[0].localeCompare(b[0]));
      $('#list').innerHTML = anomalies + (ps.length ? ps.filter(([n]) => matches(n, q) || matches(A.platforms[n].events, q)).map(([name, p]) => section(name, [...p.accounts].join(', '),
        `<table class="schema"><tr><th>Event</th><th>Count</th><th>Values sent</th></tr>${Object.entries(p.events).map(([ev, s]) =>
          `<tr><td>${esc(ev)}</td><td>×${s.count}${s.withEventId ? ` <span class="meta">(${s.withEventId} with event ID)</span>` : ''}</td><td>${esc([...s.values].join(', ') || '—')}</td></tr>`).join('')}</table>`)).join('')
        : '<div class="empty">No pixel hits recorded yet.</div>');
      return;
    }
    if (sub === 'funnel') {
      $('#list').innerHTML = anomalies + (A.funnel.length
        ? `<ol class="funnel">${A.funnel.filter((f) => matches(f, q)).map((f) => `<li><span class="type">${esc(f.label)}</span> <span class="meta">${fmtT(f.t, A.started)}</span>${f.values.length ? ' ' + chips(f.values.map(([k, v]) => `${k.split('.').pop()} = ${v}`)) : ''}</li>`).join('')}</ol>
           <div class="note">First time each custom data layer event fired, in order, with any price or value fields it carried.</div>`
        : '<div class="empty">No custom data layer events yet.</div>');
      return;
    }
    const rows = A.timeline.filter((r) => {
      if (r.type === 'page') return true;
      if (r.type === 'dl' && (state.recHideDl || (!state.recSys && r.system) || r.pre)) return false;
      if (r.type === 'hit' && (state.recHidePx || (!state.recSys && r.noise))) return false;
      return !q || matches(r.type === 'dl' ? { l: r.label, e: r.e } : { v: r.vendor, e: r.event, a: r.account, p: r.params }, q);
    }).filter((r, i, arr) => r.type !== 'page' || (arr[i + 1] && arr[i + 1].type !== 'page'));
    $('#list').innerHTML = anomalies + rows.map((r) => {
      if (r.type === 'page') return `<div class="pagehdr"><span class="meta">${fmtT(r.t, A.started)}</span> ${esc(r.how)} · <span title="${esc(r.url)}">${esc(trunc(r.url.replace(/^https?:\/\//, ''), 90))}</span></div>`;
      const count = r.count > 1 ? `<span class="badge">×${r.count}</span>` : '';
      if (r.type === 'dl') return `<details><summary><span class="meta">${fmtT(r.t, A.started)}</span> <span class="chip dl">${esc(r.layer)}</span> <span class="type">${esc(r.label)}</span>${count}
          ${r.values.length ? `<div>${chips(r.values.map(([k, v]) => `${k} = ${v}`))}</div>` : ''}</summary><div class="body"><pre>${esc(trunc(show(r.e), 12000))}</pre></div></details>`;
      return `<details><summary><span class="meta">${fmtT(r.t, A.started)}</span> <span class="chip px">${esc(r.vendor)}</span> <span class="type">${esc(r.event)}</span>${count}
          <span class="meta">${esc(r.account || '')}${r.transport && r.transport !== 'google' ? ' via ' + esc(r.transport) : ''}</span>
          ${r.value != null ? `<div>${chips([`value = ${money(r.value, r.currency)}`])}</div>` : ''}</summary>
        <div class="body"><h4>Request</h4><pre>${esc(trunc(r.req, 2000))}</pre>${r.body ? `<h4>Body</h4><pre>${esc(trunc(r.body, 4000))}</pre>` : ''}<h4>Decoded</h4><pre>${esc(trunc(show(r.params), 6000))}</pre></div></details>`;
    }).join('');
  },
};

// Live-update the recorder while the popup is open
try {
  let pendingRender = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !state.tabId) return;
    if (!changes['rec_' + state.tabId] && !changes.recState) return;
    const v = state.views[state.current];
    if (!v || (v.kind !== 'rec' && v.kind !== 'overview')) return;
    if (pendingRender) return;
    pendingRender = setTimeout(async () => {
      pendingRender = null;
      const openKeys = [...document.querySelectorAll('#list details[open] > summary')].map((s) => s.textContent);
      const scroll = document.scrollingElement.scrollTop;
      const qv = $('#q')?.value;
      await loadRecording();
      renderView();
      if ($('#q') && qv) { $('#q').value = qv; VIEWS[v.kind].list(v); }
      document.querySelectorAll('#list details > summary').forEach((s) => { if (openKeys.includes(s.textContent)) s.parentElement.open = true; });
      document.scrollingElement.scrollTop = scroll;
    }, 1000);
  });
} catch {}


// ---------- Promos & campaigns ----------

const promoKey = () => 'promos_' + siteBrand(state.page.host).domain;
async function loadPromos() {
  if (state.promoScan === undefined) state.promoScan = (await storageGet('local', promoKey())) || null;
  state.promoAnalysis = state.promoScan ? analyzePromos(state.promoScan) : null;
}
const STATUS_CLASS = { active: 'yes', upcoming: 'likely', 'ongoing / no dates': 'info', expired: 'no', 'expired (page redirects)': 'no' };
const fmtDate = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : '…');

VIEWS.promos = {
  header() {
    const A = state.promoAnalysis;
    $('#summary').innerHTML = A
      ? `<b>${A.offers.length}</b> promo pages read (of ${A.candidates} found; sitemap has ${A.sitemapUrlCount} URLs) · <b>${A.offers.filter((o) => o.status === 'active').length}</b> active · <b>${A.offers.filter((o) => o.status === 'upcoming').length}</b> upcoming · <b>${A.campaignFolders.length}</b> campaign asset folders` +
        (A.fiscalPeriods.length ? `<div class="chips">${chips(A.fiscalPeriods.map((f) => 'fiscal: ' + f))}${chips(A.phases.map((p) => 'campaign ' + p))}</div>` : '') +
        `<div class="note">Scanned ${new Date(A.scannedAt).toLocaleString()}.</div>`
      : 'Reads robots.txt and the sitemap, finds promo, deal and campaign pages (including expired ones still online), and pulls offer dates, prices and the asset folders the creative lives in. It fetches up to 25 pages from this site.';
    toolbar({
      tabs: A ? [['offers', 'Offer calendar'], ['folders', 'Campaign folders'], ['recent', 'Recently updated']] : [],
      active: state.sub.promos || 'offers',
      filter: !!A,
      actions: `<button id="scan" class="primary">${A ? '↻ Rescan' : 'Scan site'}</button>` + (A ? '<button id="csv">CSV</button><button id="json">JSON</button>' : ''),
    });
    $('#scan').onclick = async () => {
      setStatus('Scanning sitemap and promo pages… (up to ~30 seconds)');
      try {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: state.tabId }, world: 'MAIN', func: scanPromos, args: [{ maxPages: 25 }] });
        state.promoScan = result;
        try { await chrome.storage.local.set({ [promoKey()]: result }); } catch {}
        setStatus('');
      } catch (e) { setStatus('Scan failed: ' + e.message, 'err'); }
      await loadPromos();
      renderView();
    };
    if ($('#csv')) $('#csv').onclick = () => download(`${fileBase()}_promos.csv`, promosCsv(state.promoAnalysis), 'text/csv');
    if ($('#json')) $('#json').onclick = () => exportJson('promos', { analysis: state.promoAnalysis, scan: state.promoScan });
  },
  list() {
    const A = state.promoAnalysis;
    if (!A) { $('#list').innerHTML = ''; return; }
    const q = query();
    const sub = state.sub.promos || 'offers';
    if (sub === 'folders') {
      const fs = A.campaignFolders.filter((f) => matches(f, q));
      $('#list').innerHTML = (fs.length ? fs.map((f) => `<details><summary><span class="type" title="${esc(f.folder)}">${esc(trunc(f.folder, 70))}</span><span class="meta">${f.fileCount} files</span>
          <div>${chips(f.tokens)}</div></summary><div class="body"><h4>Files</h4><ul>${f.files.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <h4>Used on</h4><ul>${f.pages.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></details>`).join('')
        : '<div class="empty">No campaign-named asset folders found.</div>') +
        '<div class="note">Folders and file names often carry fiscal quarters, campaign names and phase numbers (e.g. <code>q4-fy2026</code>, <code>Holiday-Campaign_Phase-1</code>), which date the creative and hint at what\'s next.</div>' +
        (A.hiddenHints.length ? section('robots.txt hints', `${A.hiddenHints.length}`, `<ul>${A.hiddenHints.map((h) => `<li>${esc(h)}</li>`).join('')}</ul><div class="note">Paths the site asks search engines not to index; landing or test pages often live here.</div>`, false) : '');
      return;
    }
    if (sub === 'recent') {
      $('#list').innerHTML = A.recent.length ? `<table class="schema">${A.recent.filter((r) => matches(r, q)).map((r) => `<tr><td>${esc(r.lastmod.slice(0, 10))}</td><td><a target="_blank" href="${esc(r.url)}">${esc(r.url.replace(/^https?:\/\/[^/]+/, ''))}</a></td></tr>`).join('')}</table><div class="note">Most recently modified pages according to the sitemap: a quick way to spot new launches.</div>` : '<div class="empty">The sitemap has no modification dates.</div>';
      return;
    }
    const offers = A.offers.filter((o) => matches(o, q));
    $('#list').innerHTML = offers.length ? offers.map((o) => `<details>
        <summary><span class="v ${STATUS_CLASS[o.status] || 'info'}">${esc(o.status)}</span><span class="type">${esc(o.name)}</span>${o.copies > 1 ? `<span class="chip" title="${esc((o.variants || []).join(', '))}">×${o.copies}</span>` : ''}
          <span class="meta">${o.start || o.end ? esc(fmtDate(o.start) + ' – ' + fmtDate(o.end)) : ''}</span>
          <div class="sub">${esc([o.prices.join(' / '), o.percentOff.join(' '), o.free ? 'free' : ''].filter(Boolean).join(' · ') || o.summary)}</div></summary>
        <div class="body">
          ${o.summary ? `<h4>Offer</h4><div>${esc(o.summary)}</div>` : ''}
          ${o.dateText.length ? `<h4>Dates found</h4><ul>${o.dateText.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
          ${o.restriction ? `<h4>Restrictions</h4><div>${esc(o.restriction)}</div>` : ''}
          ${o.variants ? `<h4>Same offer on ${o.copies} pages</h4><div>${esc(o.variants.join(', '))}</div>` : ''}
          ${o.redirectedTo ? `<h4>Redirects to</h4><div>${esc(o.redirectedTo)}</div>` : ''}
          <h4>Page</h4><div><a target="_blank" href="${esc(o.url)}">${esc(o.url)}</a>${o.lastmod ? ` · sitemap lastmod ${esc(o.lastmod.slice(0, 10))}` : ''}</div>
        </div></details>`).join('') : '<div class="empty">No promo pages found.</div>';
  },
};

// ---------- Third-party cost ----------

const kb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');
VIEWS.cost = {
  header() {
    const C = (this.c = analyzeCost(state.page));
    if (!C) { $('#summary').innerHTML = 'No resource timing available for this page. Reload the page and reopen the popup.'; toolbar({ filter: false }); return; }
    const T = C.totals, t = C.timing;
    $('#summary').innerHTML =
      `Marketing & tag code: <b>${T.marketing.requests}</b> of ${C.all.requests} requests (<b>${C.shares.marketingRequests}%</b>) · <b>${kb(T.marketing.jsBytes)}</b> JavaScript${C.shares.marketingJs != null ? ` (<b>${C.shares.marketingJs}%</b> of ${kb(C.all.jsBytes)})` : ' (share not reliable: the site\'s own scripts hide their size)'} · ${kb(T.marketing.bytes)} total` +
      (t ? `<div class="note">Page timing: first byte ${t.ttfb} ms · DOM ready ${t.dcl} ms · load ${t.load || '…'} ms · ${T.marketing.afterLoad} marketing requests started after load.</div>` : '') +
      (C.note ? `<div class="note">${esc(C.note)}</div>` : '');
    toolbar({ actions: '<button id="csv">CSV</button>' });
    $('#csv').onclick = () => download(`${fileBase()}_third-party-cost.csv`, costCsv(C), 'text/csv');
  },
  list() {
    const C = this.c;
    if (!C) { $('#list').innerHTML = ''; return; }
    const q = query();
    const T = C.totals;
    const bucket = (name, b) => `<tr><td>${name}</td><td>${b.requests}</td><td>${kb(b.bytes)}</td><td>${kb(b.jsBytes)}</td></tr>`;
    const max = Math.max(1, ...C.vendors.map((v) => v.bytes));
    $('#list').innerHTML =
      section('Breakdown', '', `<table class="schema"><tr><th></th><th>Requests</th><th>Transferred</th><th>JavaScript</th></tr>
        ${bucket('First-party (site itself)', T.first)}${bucket('Marketing, analytics & tag managers', T.marketing)}${bucket('Other third-party (fonts, maps, payments…)', T.infra)}${bucket('Unclassified third-party', T.other3p)}
        </table><div class="note">This page load only. Resource sizes come from the browser\'s timing data; the page HTML itself is ${kb(C.all.docBytes)}.</div>`) +
      section('By vendor', `${C.vendors.length}`, `<table class="schema"><tr><th>Vendor</th><th>Requests</th><th>Size</th><th></th></tr>${C.vendors.filter((v) => matches(v, q)).map((v) =>
        `<tr><td title="${esc(v.hosts.join(', '))}">${esc(v.vendor)}<div class="meta" style="margin:0">${esc(v.channel)}</div></td><td>${v.requests}${v.hidden ? ` <span class="meta" title="size not exposed">(${v.hidden} hidden)</span>` : ''}</td><td>${kb(v.bytes)}${v.jsBytes ? ` <span class="meta">${kb(v.jsBytes)} JS</span>` : ''}</td>
         <td style="width:30%"><div class="bar" style="width:${Math.max(2, Math.round((v.bytes / max) * 100))}%"></div></td></tr>`).join('')}</table>`);
  },
};

// ---------- Init ----------

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab.id;
  try { $('#page').textContent = new URL(tab.url).hostname; } catch {}
  if (!/^https?:/.test(tab.url || '')) return setStatus('Open a regular web page to inspect it.', 'err');
  try {
    await collect();
  } catch (e) {
    setStatus(`Couldn't read this page: ${e.message}`, 'err');
  }
}

$('#refresh').onclick = async () => {
  state.gtm = {};
  try { await collect(); } catch (e) { setStatus(`Couldn't read this page: ${e.message}`, 'err'); }
};

init();
