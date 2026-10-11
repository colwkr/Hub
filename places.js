// POS places: where home is, finding a place near it ("Publix" means the nearest Publix), and the drive there.
// Home is set once from the device's location (the iPad on the wall is at home) and kept in records as place-home.
// Places come from OpenStreetMap (Nominatim, with Photon as a fallback); the drive comes from the OSRM router.
// A task's place is saved on it: { q, name, addr, lat, lon, mi, drive, from }, drive in minutes, rounded up to 5.
// Known places (records kind "place", like the church) answer to their name and nicknames before any search.
// Where you are: your phone shares its location (records place-me, only the latest point is kept) while POS is open on
// it, and every device reads that, so the iPad and the computer know where the phone is too.
window.POSPlaces = function (ctx) {
  const { sb } = ctx;
  let home = null, known = [], me = null, onMe = null;
  const R = 3958.8; // miles
  const rad = d => d * Math.PI / 180;
  function miles(a, b) {
    const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const ceil5 = m => Math.max(5, Math.ceil(m / 5) * 5);
  const homeKey = h => `${h.lat.toFixed(4)},${h.lon.toFixed(4)}`;

  async function loadHome() {
    const { data, error } = await sb.from('records').select('id,data').eq('kind', 'place');
    if (error) return home;
    const hr = (data || []).find(r => r.id === 'place-home'), d = hr && hr.data;
    home = d && Number.isFinite(d.lat) && Number.isFinite(d.lon) ? d : null;
    known = (data || []).filter(r => r.id !== 'place-home' && r.id !== 'place-me' && r.data && Number.isFinite(r.data.lat) && Number.isFinite(r.data.lon)).map(r => ({ id: r.id, ...r.data }));
    const mr = (data || []).find(r => r.id === 'place-me');
    if (mr && mr.data && Number.isFinite(mr.data.lat) && (!me || (mr.data.at || 0) > (me.at || 0))) me = mr.data;
    listen(); track();
    return home;
  }

  /* ---------- where you are: the phone's location, shared ---------- */
  const SRC = 'pos.locSource';
  // the phone is the one that knows; on its own, a phone-sized touch screen counts as the phone (Settings can change it)
  function isSource() {
    try { const v = localStorage.getItem(SRC); if (v === '1') return true; if (v === '0') return false; } catch (e) { /* use the screen */ }
    return window.matchMedia('(max-width: 600px) and (pointer: coarse)').matches;
  }
  function setSource(on) { try { localStorage.setItem(SRC, on ? '1' : '0'); } catch (e) { /* this visit only */ } track(); }
  let chan = null;
  function listen() {
    if (chan) return;
    chan = sb.channel('pos-place-me').on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: 'id=eq.place-me' }, p => {
      const d = p && p.new && p.new.data;
      if (d && Number.isFinite(d.lat) && (!me || (d.at || 0) >= (me.at || 0))) { me = d; if (onMe) onMe(); }
    }).subscribe();
  }
  let watchId = null, tick = null, sent = null, saving = false;
  function track() {
    const want = isSource() && document.visibilityState === 'visible' && !!navigator.geolocation;
    if (want && watchId == null) {
      watchId = navigator.geolocation.watchPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 });
      tick = setInterval(() => navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 }), 3 * 60e3);
    } else if (!want && watchId != null) {
      navigator.geolocation.clearWatch(watchId); clearInterval(tick); watchId = null; tick = null;
    }
  }
  document.addEventListener('visibilitychange', () => track());
  // a new fix: shared when you've moved (about 100 m), or every couple of minutes so it stays fresh
  async function onFix(p) {
    const c = p && p.coords;
    if (!c || (c.accuracy || 0) > 1500) return;
    const pt = { lat: +c.latitude.toFixed(5), lon: +c.longitude.toFixed(5), acc: Math.round(c.accuracy || 0), at: Date.now() };
    if (sent && miles(sent, pt) < 0.06 && pt.at - sent.at < 120000) return;
    me = pt; sent = pt;
    if (onMe) onMe();
    if (saving) return;
    saving = true;
    try {
      const { data: rows } = await sb.from('records').select('id').eq('id', 'place-me');
      if (rows && rows.length) await sb.from('records').update({ data: me }).eq('id', 'place-me');
      else await sb.from('records').insert({ id: 'place-me', kind: 'place', data: me });
    } catch (e) { /* tries again with the next fix */ } finally { saving = false; }
  }
  // home or a known place you're at (within about 250 m)
  function nearKnown(pt) {
    if (!pt) return null;
    const all = (home ? [{ id: 'place-home', ...home, name: 'Home' }] : []).concat(known);
    return all.map(p => ({ p, d: miles(pt, p) })).filter(x => x.d < 0.16).sort((a, b) => a.d - b.d).map(x => x.p)[0] || null;
  }
  const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const knownFor = q => { const n = squash(q); return n ? known.find(p => squash(p.name) === n || (p.aliases || []).some(a => squash(a) === n)) : null; };
  function here() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) { rej(new Error('No location on this device')); return; }
      navigator.geolocation.getCurrentPosition(p => res(p.coords), rej, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }
  // where this device is right now becomes home
  async function setHomeHere() {
    const c = await here();
    const data = { name: 'Home', lat: +c.latitude.toFixed(6), lon: +c.longitude.toFixed(6), acc: Math.round(c.accuracy || 0), at: Date.now() };
    const { data: rows } = await sb.from('records').select('id').eq('id', 'place-home');
    const r = rows && rows.length ? await sb.from('records').update({ data }).eq('id', 'place-home') : await sb.from('records').insert({ id: 'place-home', kind: 'place', data });
    if (r.error) throw r.error;
    home = data;
    return home;
  }

  // the map services ask for no more than one search a second
  let gate = Promise.resolve();
  const paced = fn => { const run = gate.then(fn, fn); gate = run.then(() => new Promise(r => setTimeout(r, 1100)), () => new Promise(r => setTimeout(r, 1100))); return run; };
  const getJSON = async url => { const r = await fetch(url, { headers: { Accept: 'application/json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  // a shop, a building or an address beats a whole town or a shopping-center outline of the same name
  const AREA = new Set(['boundary', 'landuse', 'highway', 'natural', 'waterway', 'railway']);
  const TOWN = new Set(['city', 'town', 'village', 'hamlet', 'suburb', 'county', 'state', 'neighbourhood', 'quarter', 'locality', 'region']);
  const addrOf = a => [[a.house_number, a.road].filter(Boolean).join(' '), a.city || a.town || a.village || a.hamlet || a.suburb].filter(Boolean).join(', ');
  async function nominatim(q, h) {
    const d = 0.4; // about 25 miles each way
    const qs = new URLSearchParams({ q, format: 'jsonv2', addressdetails: '1', limit: '30', bounded: '1', viewbox: `${h.lon - d},${h.lat + d},${h.lon + d},${h.lat - d}` });
    const list = await paced(() => getJSON('https://nominatim.openstreetmap.org/search?' + qs));
    const all = (list || []).map(r => ({ name: r.name || String(r.display_name || '').split(',')[0], addr: addrOf(r.address || {}), lat: +r.lat, lon: +r.lon, cat: r.category, type: r.type }))
      .filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon));
    const good = all.filter(r => !AREA.has(r.cat) && !(r.cat === 'place' && TOWN.has(r.type)));
    return good.length ? good : all;
  }
  async function photon(q, h) {
    const qs = new URLSearchParams({ q, lat: String(h.lat), lon: String(h.lon), limit: '15' });
    const j = await paced(() => getJSON('https://photon.komoot.io/api/?' + qs));
    return ((j && j.features) || []).map(f => {
      const p = f.properties || {}, [lon, lat] = (f.geometry && f.geometry.coordinates) || [];
      return { name: p.name || [p.housenumber, p.street].filter(Boolean).join(' '), addr: [[p.housenumber, p.street].filter(Boolean).join(' '), p.city || p.district].filter(Boolean).join(', '), lat, lon };
    }).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon) && miles(h, r) <= 40);
  }
  // the nearest match to home
  async function find(q, h) {
    let list = [];
    try { list = await nominatim(q, h); } catch (e) { list = []; }
    if (!list.length) { try { list = await photon(q, h); } catch (e) { list = []; } }
    if (!list.length) return null;
    return list.map(r => ({ ...r, crow: miles(h, r) })).sort((a, b) => a.crow - b.crow)[0];
  }
  // the drive from home, with a little room for lights and parking; a straight-line guess if the router can't be reached
  async function drive(h, p) {
    try {
      const j = await getJSON(`https://router.project-osrm.org/route/v1/driving/${h.lon},${h.lat};${p.lon},${p.lat}?overview=false`);
      const r = j && j.routes && j.routes[0];
      if (r && Number.isFinite(r.duration)) return { mi: Math.round(r.distance / 1609.344 * 10) / 10, drive: ceil5(r.duration / 60 * 1.25) };
    } catch (e) { /* falls through to the guess */ }
    const road = p.crow * 1.3;
    return { mi: Math.round(road * 10) / 10, drive: ceil5(road / 30 * 60), guess: true };
  }

  // remembered for a month, per home
  const MEM = 'pos.places', MONTH = 30 * 86400000;
  const mem = () => { try { return JSON.parse(localStorage.getItem(MEM) || '{}'); } catch (e) { return {}; } };
  function remember(key, v) { try { const m = mem(); m[key] = { v, at: Date.now() }; for (const k of Object.keys(m)) if (Date.now() - m[k].at > MONTH) delete m[k]; localStorage.setItem(MEM, JSON.stringify(m)); } catch (e) { /* nothing to keep it in */ } }
  const inflight = new Map();
  // "Publix" → { q, name, addr, lat, lon, mi, drive, from }; { q, missing } when nothing near home has that name; null without a home
  async function resolve(q) {
    q = String(q || '').trim();
    if (!q || !home) return null;
    const kp = knownFor(q);
    const key = (kp ? 'known:' + kp.id + ':' + kp.lat + ',' + kp.lon : q.toLowerCase()) + '|' + homeKey(home), m = mem()[key];
    if (m && Date.now() - m.at < MONTH) return { ...m.v, q };
    if (inflight.has(key)) return inflight.get(key);
    const h = home, job = (async () => {
      const p = kp ? { ...kp, crow: miles(h, kp) } : await find(q, h);
      const out = p ? { q, name: p.name || q, addr: p.addr || '', lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), ...(await drive(h, p)), from: [h.lat, h.lon] }
        : { q, missing: true, from: [h.lat, h.lon] };
      if (!out.guess) remember(key, out);
      return out;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }
  // a saved place that still needs working out: never looked up, or looked up from an earlier home
  function stale(p) {
    if (!p || !p.q || !home) return false;
    if (!p.from) return true;
    return Math.abs(p.from[0] - home.lat) > 0.0005 || Math.abs(p.from[1] - home.lon) > 0.0005;
  }
  // the drive from one place to another (not home): answered from memory, else a straight-line guess while the router is asked
  const LEGS = 'pos.legs', legs = new Map(), asking = new Set();
  let onLeg = null;
  const ptKey = p => `${(+p.lat).toFixed(4)},${(+p.lon).toFixed(4)}`;
  function legMins(a, b) {
    if (miles(a, b) < 0.15) return 0;
    const key = ptKey(a) + '>' + ptKey(b);
    if (legs.has(key)) return legs.get(key);
    let kept = null;
    try { kept = (JSON.parse(localStorage.getItem(LEGS) || '{}'))[key]; } catch (e) { kept = null; }
    if (kept && Date.now() - kept.at < MONTH) { legs.set(key, kept.v); return kept.v; }
    if (!asking.has(key)) {
      asking.add(key);
      getJSON(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`).then(j => {
        const r = j && j.routes && j.routes[0];
        if (!r || !Number.isFinite(r.duration)) return;
        const v = ceil5(r.duration / 60 * 1.25);
        legs.set(key, v);
        try { const m = JSON.parse(localStorage.getItem(LEGS) || '{}'); m[key] = { v, at: Date.now() }; localStorage.setItem(LEGS, JSON.stringify(m)); } catch (e) { /* kept for this visit only */ }
        if (onLeg) onLeg();
      }).catch(() => {}).finally(() => asking.delete(key));
    }
    return ceil5(miles(a, b) * 1.3 / 30 * 60);
  }
  return { home: () => home, loadHome, setHomeHere, resolve, stale, miles, legMins, onLeg: fn => { onLeg = fn; }, here,
    me: () => me, onMe: fn => { onMe = fn; }, nearKnown, isSource, setSource };
};
