/* Layouts: which widgets a screen shows, in what order, how big, and filtered how, per device.
   Rows live in the Supabase table `layouts` ({screen, device, widgets, apps}); widgets is an ordered list of
   {id, size: 's'|'m'|'l'|'full', hidden, filter}. The most specific row wins: this device's name (ipad, phone or pc,
   or one set once by opening POS with ?device=wall-ipad; ?device= clears it), then its type (phone, tablet, desktop),
   then '*'.
   A screen with no row keeps its built-in layout, untouched. Changes arrive by realtime and re-render.
   New widget types live in widgets/ (listed in widgets/manifest.json) and register with POSLayout.register. */
window.POSLayout = function (ctx) {
  const { sb, esc, rerender, version } = ctx;
  let rows = [], loaded = false, channel = null, timer = null, customLoaded = false;
  const custom = {}; // widget types from widgets/, by id

  try { const c = JSON.parse(localStorage.getItem('pos.layouts') || 'null'); if (Array.isArray(c)) { rows = c; loaded = true; } } catch (e) {}
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('device')) {
      const d = (q.get('device') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
      if (d) localStorage.setItem('pos.device', d); else localStorage.removeItem('pos.device');
    }
  } catch (e) {}

  const mm = q => !!(window.matchMedia && matchMedia(q).matches);
  // the same name remote.js registers under: the ?device= one, or else ipad / phone / pc (a touch computer: tablet)
  const deviceName = () => {
    try { const n = localStorage.getItem('pos.device'); if (n) return n; } catch (e) {}
    const touch = (navigator.maxTouchPoints || 0) > 0, s = window.screen || {};
    if (touch && Math.min(s.width || 9999, s.height || 9999) < 500) return 'phone';
    if ((navigator.maxTouchPoints || 0) > 1 && /iPad|Macintosh/.test(navigator.userAgent)) return 'ipad';
    return touch ? 'tablet' : 'pc';
  };
  // the same breakpoints the rest of POS uses: a phone below 760px wide (or 500 tall); otherwise a mouse means desktop
  const deviceType = () => (!mm('(min-width:760px) and (min-height:500px)') ? 'phone' : mm('(hover:hover) and (pointer:fine)') ? 'desktop' : 'tablet');

  function get(screen) {
    if (!loaded) return null;
    const mine = rows.filter(r => r.screen === screen), name = deviceName();
    return (name && mine.find(r => r.device === name)) || mine.find(r => r.device === deviceType()) || mine.find(r => r.device === '*') || null;
  }

  async function load() {
    if (!sb) return;
    try {
      const { data, error } = await sb.from('layouts').select('screen,device,widgets,apps,updated_at');
      if (error) throw error;
      const next = data || [];
      const changed = JSON.stringify(next) !== JSON.stringify(rows) || !loaded;
      rows = next; loaded = true;
      try { localStorage.setItem('pos.layouts', JSON.stringify(rows)); } catch (e) {}
      if (changed) rerender();
    } catch (e) { /* no table yet, or offline: screens keep their built-in (or last known) layouts */ }
  }
  const scheduleLoad = () => { clearTimeout(timer); timer = setTimeout(load, 250); };

  function start() {
    load();
    if (sb && !channel) channel = sb.channel('pos-layouts').on('postgres_changes', { event: '*', schema: 'public', table: 'layouts' }, scheduleLoad).subscribe();
    loadCustom();
  }
  function stop() {
    if (channel && sb) sb.removeChannel(channel);
    channel = null; rows = []; loaded = false;
    try { localStorage.removeItem('pos.layouts'); } catch (e) {}
  }

  // widget types added later (widgets/*.js), listed in widgets/manifest.json
  async function loadCustom() {
    if (customLoaded) return;
    customLoaded = true;
    try {
      const r = await fetch('widgets/manifest.json?v=' + encodeURIComponent(version), { cache: 'no-store' });
      if (!r.ok) return;
      const m = await r.json();
      for (const f of (m && Array.isArray(m.widgets) ? m.widgets : [])) {
        if (typeof f !== 'string' || !/^[a-z0-9_-]+\.js$/.test(f)) continue;
        const s = document.createElement('script');
        s.src = `widgets/${f}?v=${encodeURIComponent(version)}`;
        document.head.appendChild(s);
      }
    } catch (e) {}
  }
  function register(id, def) {
    if (typeof id !== 'string' || !/^x\.[a-z0-9_.-]+$/.test(id) || !def || typeof def.render !== 'function') return;
    custom[id] = def;
    rerender();
  }

  const SIZE = { s: 'lay-s', m: 'lay-m', l: 'lay-l', full: 'lay-full' };
  // A screen's layout as HTML, or null when it has no layout row (the caller then draws its built-in layout).
  // `widgets` is the screen's own {id: {render(filter, size)}}; custom widget types (ids starting x.) work anywhere.
  function render(screen, widgets) {
    const row = get(screen);
    if (!row || !Array.isArray(row.widgets)) return null;
    const html = row.widgets.filter(w => w && !w.hidden).map(w => {
      const def = widgets[w.id] || custom[w.id];
      if (!def) return '';
      let inner = '';
      try { inner = def.render(w.filter && typeof w.filter === 'object' ? w.filter : {}, SIZE[w.size] ? w.size : 'm', { esc, sb }) || ''; } catch (e) { inner = ''; }
      return inner ? `<div class="lay-w ${SIZE[w.size] || 'lay-m'}" data-widget="${esc(w.id)}">${inner}</div>` : '';
    }).join('');
    return `<div class="lay-grid" data-layout="${esc(screen)}">${html || '<p class="empty">Nothing is set to show here. Ask to put widgets back.</p>'}</div>`;
  }

  // one custom (x.*) widget on its own, for screens that place widgets themselves (Home's cards)
  function one(w) {
    const def = w && custom[w.id];
    if (!def) return '';
    try { return def.render(w.filter && typeof w.filter === 'object' ? w.filter : {}, SIZE[w.size] ? w.size : 'm', { esc, sb }) || ''; } catch (e) { return ''; }
  }

  // Home's app icons: the layout's order (hidden ones left out), or null to keep POS's own saved order
  function apps(screen) {
    const row = get(screen);
    return row && Array.isArray(row.apps) ? row.apps.filter(a => a && typeof a.id === 'string') : null;
  }
  // dragging icons by hand on a device whose Home has a layout row: save the new order into that row
  async function saveApps(screen, order) {
    const row = get(screen);
    if (!row || !Array.isArray(row.apps) || !sb) return false;
    const hidden = new Set(row.apps.filter(a => a.hidden).map(a => a.id));
    const next = order.map(id => ({ id })).concat([...hidden].filter(id => !order.includes(id)).map(id => ({ id, hidden: true })));
    row.apps = next;
    try {
      const { error } = await sb.from('layouts').update({ apps: next }).eq('screen', row.screen).eq('device', row.device);
      if (error) throw error;
      return true;
    } catch (e) { return false; }
  }

  // a widgets/*.js file calls POSWidget('x.name', { label, render(filter, size, { esc, sb }) { return html } })
  window.POSWidget = register;

  return { get, render, one, apps, saveApps, start, stop, register, deviceName, deviceType };
};
