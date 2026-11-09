// Runs in the extension's isolated world on every page. Buffers what recorder-main.js captures
// and forwards it to the background worker only while recording is switched on for this tab.
(() => {
  if (window.__tiRelay) return;
  window.__tiRelay = true;

  const buf = [];
  let pending = [];
  let on = false;
  let timer = null;

  const send = (items, replay) => {
    try { chrome.runtime.sendMessage({ type: 'rec-batch', items, replay: !!replay }).catch(() => {}); } catch {}
  };
  const flush = () => {
    timer = null;
    if (!pending.length) return;
    const items = pending;
    pending = [];
    send(items);
  };

  document.addEventListener('__ti_rec', (e) => {
    let item;
    try { item = JSON.parse(e.detail); } catch { return; }
    buf.push(item);
    if (buf.length > 4000) buf.shift();
    if (!on) return;
    pending.push(item);
    if (!timer) timer = setTimeout(flush, 300);
  });

  try {
    chrome.runtime.sendMessage({ type: 'rec-status' }).then((r) => {
      if (r && r.on) { on = true; send(buf.slice(), true); }
    }).catch(() => {});
  } catch {}

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m && m.type === 'ti-start') { on = true; send(buf.slice(), true); reply({ ok: true, buffered: buf.length }); }
    else if (m && m.type === 'ti-stop') { on = false; flush(); reply({ ok: true }); }
  });

  // Don't lose the last batch when the page unloads mid-flow
  addEventListener('pagehide', flush);
})();
