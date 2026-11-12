// Builds the in-page scripts (capture.js, recorder-start.js, recorder-dump.js) from the shared modules in ./lib.
// Run after updating lib/: node build.js
import fs from 'fs';
import { collectPage } from './lib/collector.js';
import { scanPromos } from './lib/promo-collect.js';

const PACK = `
  const __tiPack = async (obj, tag) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const gz = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let bin = ''; for (let i = 0; i < gz.length; i += 0x8000) bin += String.fromCharCode.apply(null, gz.subarray(i, i + 0x8000));
    const b64 = btoa(bin), CH = 150000, n = Math.max(1, Math.ceil(b64.length / CH));
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => A[x % 62]).join('');
    const host = location.hostname;
    window.__tiPart = (i) => '__' + tag + '_PART_' + i + '_OF_' + n + '_ID_' + id + '_HOST_' + host + '__' + b64.slice(i * CH, (i + 1) * CH) + '__' + tag + '_PART_END__ ' +
      'pad:' + Array.from(crypto.getRandomValues(new Uint8Array(45000)), (x) => A[x % 62]).join('');
    return window.__tiPart(0) + ' parts=' + n + ' host=' + host;
  };`;

const capture = `// Paste this whole file into the browser's JavaScript tool on the page to analyze.
// It returns part 0 of a gzip+base64 package (the tool saves it to a file). If it says parts=N>1, run __tiPart(1) ... __tiPart(N-1).\n// Then: node intel.js extract <file0> [file1 ...] -o capture.json
await (async () => {
  const OPTS = Object.assign({ promos: true, maxPromoPages: 20, wait: 2500 }, window.__TI_OPTS || {});
  const collectPage = (${collectPage.toString()});
  const scanPromos = (${scanPromos.toString()});
  const getText = async (url) => {
    try { const r = await fetch(url, { credentials: 'omit' }); return r.ok ? await r.text() : null; }
    catch { return await new Promise((res) => { try { const x = new XMLHttpRequest(); x.open('GET', url); x.onload = () => res(x.status < 300 ? x.responseText : null); x.onerror = () => res(null); x.send(); } catch { res(null); } }); }
  };
  await new Promise((r) => setTimeout(r, OPTS.wait));
  const page = await collectPage();
  const containers = {};
  for (const c of page.containers.filter((c) => /^GTM-/.test(c.id))) {
    // Health-check and other variants of the loader URL can fail; fall back to the plain container URL
    const plain = 'https://www.googletagmanager.com/gtm.js?id=' + c.id;
    containers[c.id] = (c.src && !/gtg_health/.test(c.src) ? await getText(c.src) : null) || await getText(plain);
  }
  let promos = null;
  if (OPTS.promos) { try { promos = await scanPromos({ maxPages: OPTS.maxPromoPages }); } catch (e) { promos = { error: String(e) }; } }
  const out = { v: 1, tool: 'tag-intel', capturedAt: new Date().toISOString(), page, containers, promos };
  ${PACK}
  return await __tiPack(out, 'TAGINTEL');
})()
`;
fs.writeFileSync('capture.js', capture);

const recMain = fs.readFileSync('./lib/recorder-main.js', 'utf8');
fs.writeFileSync('recorder-start.js', `// Paste into the browser's JavaScript tool to start recording this tab's data layer and pixels.
// Recording lives in the page, so it only survives in-page navigation (single-page apps, hash routes).
// For multi-page flows, run it again after each full page load (each load is captured separately).
window.__tiGot = window.__tiGot || [];
if (!window.__tiListening) { window.__tiListening = true; document.addEventListener('__ti_rec', (e) => window.__tiGot.push(e.detail)); }
${recMain}
'recording: ' + window.__tiGot.length + ' items so far'
`);
fs.writeFileSync('recorder-dump.js', `// Paste into the JavaScript tool to return everything recorded on this page so far (gzip+base64 parts, like capture.js).
await (async () => {
  ${PACK}
  return await __tiPack({ v: 1, url: location.href, items: (window.__tiGot || []).map((s) => JSON.parse(s)) }, 'TAGINTELREC');
})()
`);
console.log('built capture.js', capture.length, 'chars; recorder-start.js; recorder-dump.js');
