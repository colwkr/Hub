// Shared by the background worker and the claude.ai tab: read Claude's own usage numbers (the same ones on
// Settings → Usage) and keep only the percentages and reset times. Nothing else leaves this file.
/* global chrome */
const CU = (() => {
  const BASE = 'https://claude.ai';

  async function getJSON(path) {
    const r = await fetch(BASE + path, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!r.ok) { const e = new Error(path.includes('/usage') ? 'usage ' + r.status : 'orgs ' + r.status); e.status = r.status; throw e; }
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { throw new Error('not signed in to claude.ai in Chrome'); }
  }

  // only { name: { pct, resets } } for each limit that has a percentage
  function clean(j) {
    const out = {};
    for (const [k, v] of Object.entries(j || {})) {
      if (!/^[a-z0-9_]{1,40}$/.test(k)) continue;
      if (v === null && (k === 'five_hour' || k === 'seven_day')) { out[k] = { pct: 0, resets: null }; continue; }
      if (!v || typeof v !== 'object') continue;
      const u = Number(v.utilization);
      if (v.utilization == null || !isFinite(u)) continue;
      out[k] = { pct: Math.round(u * 10) / 10, resets: typeof v.resets_at === 'string' ? v.resets_at.slice(0, 40) : null };
      if (Object.keys(out).length >= 10) break;
    }
    return out;
  }

  const store = {
    get: k => new Promise(res => chrome.storage.local.get(k, o => res(o[k]))),
    set: (k, v) => new Promise(res => chrome.storage.local.set({ [k]: v }, res)),
  };

  // which Claude account (organization) to read; remembered after the first find
  async function orgs() {
    const list = await getJSON('/api/organizations');
    return (Array.isArray(list) ? list : []).map(o => o && o.uuid).filter(u => typeof u === 'string' && /^[0-9a-f-]{36}$/.test(u));
  }

  async function read() {
    const kept = await store.get('org');
    if (kept) {
      try {
        const lim = clean(await getJSON(`/api/organizations/${kept}/usage`));
        if (lim.five_hour || lim.seven_day) return lim;
      } catch (e) { if (e.status !== 403 && e.status !== 404) throw e; }
    }
    for (const id of await orgs()) {
      try {
        const lim = clean(await getJSON(`/api/organizations/${id}/usage`));
        if (lim.five_hour || lim.seven_day) { await store.set('org', id); return lim; }
      } catch (e) { if (e.status === 401) throw e; }
    }
    throw new Error('no usage found for this account');
  }

  return { read, clean };
})();
if (typeof self !== 'undefined') self.CU = CU;
