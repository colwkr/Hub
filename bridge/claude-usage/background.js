// POS Claude usage: every 5 minutes (and whenever a claude.ai tab reads it), send the usage percentages to POS.
// config.js (on this PC only) holds POS's address, its public key, and the POS write key. Only percentages,
// reset times and a short error note are ever sent.
/* global importScripts, chrome, CU, POS */
importScripts('config.js', 'core.js');

const EVERY = 5;

function schedule() { chrome.alarms.create('usage', { periodInMinutes: EVERY, delayInMinutes: 0.1 }); }
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'usage') pull('timer'); });

// the claude.ai tab passes along what it read (only from claude.ai, only from this extension)
chrome.runtime.onMessage.addListener((m, sender) => {
  if (!m || sender.id !== chrome.runtime.id || !sender.url || !sender.url.startsWith('https://claude.ai/')) return;
  if (m.type === 'usage' && m.limits && typeof m.limits === 'object') send({ limits: CU.clean(rawish(m.limits)), via: 'tab' });
});
// the tab already cleaned it; turn it back into the shape clean() reads so it gets checked again here
function rawish(lim) {
  const o = {};
  for (const [k, v] of Object.entries(lim)) o[k] = v && typeof v === 'object' ? { utilization: v.pct, resets_at: v.resets } : v;
  return o;
}

let busy = false;
async function pull(via) {
  if (busy) return;
  busy = true;
  try { await send({ limits: await CU.read(), via }); }
  catch (e) { await send({ err: String((e && e.message) || e).slice(0, 120), via }); }
  finally { busy = false; }
}

async function send(data) {
  try {
    await fetch(`${POS.url}/rest/v1/rpc/claude_usage_put`, {
      method: 'POST',
      headers: { apikey: POS.anon, Authorization: `Bearer ${POS.anon}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_nonce: POS.nonce, p_data: data }),
    });
  } catch (e) { /* offline: the next check tries again */ }
}
