/* Remote control: Jarvis (or anything signed in as you) can tell an open copy of POS to open a screen, show an item,
   switch a view or scroll to a widget, and it happens in under a second without a reload.
   Each copy registers itself in the `devices` table under its name: the one given with ?device=name (layout.js keeps
   it too), or else 'ipad', 'phone' or 'pc' (a touch computer is 'tablet'). It says which screen it's on, when it was
   last seen (every minute) and last used. Commands arrive as new rows in `commands` (by realtime) aimed at a name,
   a type (phone/tablet/desktop) or '*'. The copy answers in its own devices row (last_command, last_result), so
   copies never overwrite each other's answers. Commands older than 15 seconds are ignored, so nothing old replays. */
window.POSRemote = function (ctx) {
  const { sb, run, onScreen } = ctx; // onScreen(): the tab this copy is showing
  let channel = null, beat = null, lastActive = 0, started = false;
  // the last command done here survives a reload, so a fresh copy never repeats it
  let lastHandled = (() => { try { return Number(sessionStorage.getItem('pos.cmd')) || 0; } catch (e) { return 0; } })();
  const FRESH_MS = 15000;

  const touch = (navigator.maxTouchPoints || 0) > 0;
  const isIPad = (navigator.maxTouchPoints || 0) > 1 && /iPad|Macintosh/.test(navigator.userAgent);
  const isPhone = touch && Math.min(window.screen.width || 9999, window.screen.height || 9999) < 500;
  const type = () => (isPhone ? 'phone' : touch ? 'tablet' : 'desktop');
  const name = () => {
    try { const n = localStorage.getItem('pos.device'); if (n) return n; } catch (e) {}
    return isPhone ? 'phone' : isIPad ? 'ipad' : touch ? 'tablet' : 'pc';
  };
  const label = () => (isIPad ? 'iPad' : isPhone ? 'Phone' : touch ? 'Tablet' : 'Computer');

  async function upsert(extra) {
    if (!sb) return;
    try {
      await sb.from('devices').upsert({ id: name(), type: type(), label: label(), screen: onScreen(), seen_at: new Date().toISOString(), ...extra }, { onConflict: 'user_id,id' });
    } catch (e) {}
  }
  // used just now (a tap, a key): Jarvis sends to the device you used last when you don't name one
  function onActive() {
    const now = Date.now();
    if (now - lastActive < 20000) return;
    lastActive = now;
    upsert({ active_at: new Date(now).toISOString() });
  }

  const aimed = c => c.target === '*' || c.target === name() || c.target === type();
  async function handle(c) {
    if (!c || c.id <= lastHandled || !aimed(c)) return;
    if (Date.now() - new Date(c.created_at).getTime() > FRESH_MS) return;
    lastHandled = c.id;
    try { sessionStorage.setItem('pos.cmd', String(c.id)); } catch (e) {}
    let result;
    try { result = (await run(c.action, c.args || {})) || { ok: true }; } catch (e) { result = { ok: false, note: String(e && e.message || e).slice(0, 200) }; }
    upsert({ last_command: c.id, last_result: { ...result, at: new Date().toISOString() } });
  }
  // anything aimed here in the last few seconds that arrived while the connection was down
  async function catchUp() {
    try {
      const since = new Date(Date.now() - FRESH_MS).toISOString();
      const { data } = await sb.from('commands').select('id,target,action,args,created_at').gt('created_at', since).order('id');
      for (const c of data || []) await handle(c);
    } catch (e) {}
  }

  function start() {
    if (!sb) return;
    upsert({ active_at: new Date().toISOString() });
    if (!channel) {
      channel = sb.channel('pos-commands')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'commands' }, p => handle(p.new))
        .subscribe(st => { if (st === 'SUBSCRIBED') catchUp(); });
    }
    if (!beat) beat = setInterval(() => upsert({}), 60e3);
    if (!started) {
      started = true;
      for (const t of ['pointerdown', 'keydown']) document.addEventListener(t, onActive, { passive: true, capture: true });
    }
  }
  function stop() {
    if (channel && sb) sb.removeChannel(channel);
    channel = null;
    clearInterval(beat); beat = null;
  }
  // a screen change: let the devices row know (cheap; one small update)
  const moved = () => upsert({});

  return { start, stop, moved, name, type };
};
