// Stores funnel recordings per tab in session storage (cleared when the browser closes).

const MAX_ITEMS = 8000;
const key = (tabId) => 'rec_' + tabId;
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));

async function getState() {
  return (await chrome.storage.session.get('recState')).recState || {};
}
async function setState(s) {
  await chrome.storage.session.set({ recState: s });
}

async function append(tabId, items) {
  const state = await getState();
  if (!state[tabId]) return;
  const k = key(tabId);
  const rec = (await chrome.storage.session.get(k))[k] || { started: state[tabId].started, items: [] };
  const have = new Set(rec.items.map((i) => i.id));
  let added = 0;
  for (const it of items) {
    if (!it || have.has(it.id)) continue;
    // Skip what happened on a page before recording started, unless it's this page's earlier context
    rec.items.push(it);
    have.add(it.id);
    added++;
  }
  if (!added) return;
  rec.items.sort((a, b) => a.t - b.t || (a.page === b.page ? a.seq - b.seq : 0));
  if (rec.items.length > MAX_ITEMS) {
    rec.items = rec.items.slice(-MAX_ITEMS);
    rec.dropped = (rec.dropped || 0) + 1;
  }
  rec.updated = Date.now();
  try {
    await chrome.storage.session.set({ [k]: rec });
  } catch (e) {
    // Quota: drop the oldest half and keep going
    rec.items = rec.items.slice(Math.floor(rec.items.length / 2));
    rec.dropped = (rec.dropped || 0) + 1;
    await chrome.storage.session.set({ [k]: rec });
  }
}

async function start(tabId) {
  const state = await getState();
  state[tabId] = { started: Date.now() };
  await setState(state);
  await chrome.storage.session.set({ [key(tabId)]: { started: state[tabId].started, items: [] } });
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ti-start' });
    return { ok: true, injected: false };
  } catch {
    // Page was loaded before the extension was installed or updated: inject now.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['recorder-relay.js'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['recorder-main.js'], world: 'MAIN' });
      await new Promise((r) => setTimeout(r, 300));
      await chrome.tabs.sendMessage(tabId, { type: 'ti-start' });
      return { ok: true, injected: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }
}

async function stop(tabId) {
  const state = await getState();
  delete state[tabId];
  await setState(state);
  try { await chrome.tabs.sendMessage(tabId, { type: 'ti-stop' }); } catch {}
  return { ok: true };
}

async function clear(tabId) {
  await stop(tabId);
  await chrome.storage.session.remove(key(tabId));
  return { ok: true };
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || !m.type) return;
  if (m.type === 'rec-status') {
    getState().then((s) => reply({ on: !!(sender.tab && s[sender.tab.id]) }));
    return true;
  }
  if (m.type === 'rec-batch' && sender.tab) {
    serial(() => append(sender.tab.id, m.items || []));
    return;
  }
  const fns = { 'rec-start': start, 'rec-stop': stop, 'rec-clear': clear };
  if (fns[m.type]) {
    serial(() => fns[m.type](m.tabId)).then(reply, (e) => reply({ ok: false, error: String(e) }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => serial(() => clear(tabId)));
