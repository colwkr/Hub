/* The Jarvis widget: the voice assistant on the PC, live. Its state as a colour (grey waiting, blue pulsing listening,
   amber thinking, green speaking, red muted), what you're saying as he transcribes it, and his reply as it streams.
   It reads the jarvis_live row (one per user) and follows it by realtime. Place it on any screen with a layout row
   (widget id jarvis.live), or let it float: Jarvis sends a 'jarvis' command when he hears his wake word, and the
   floating panel shows on that device and tucks itself away a few seconds after the conversation ends.
   Live updates repaint only the widget, never the whole page. */
window.POSJarvis = function (ctx) {
  const { sb, esc } = ctx;
  let st = { state: 'idle', muted: false, conversation: false, heard: '', heard_final: false, reply: '', turn: 0, alive_at: null };
  let channel = null, floating = false, hideTimer = null, quietSince = 0;
  const LABEL = { starting: 'Starting', idle: 'Waiting for “hey Jarvis”', listening: 'Listening', thinking: 'Thinking',
    speaking: 'Speaking', error: 'Something went wrong', muted: 'Muted', off: 'Jarvis isn’t running' };
  const HIDE_AFTER = 6000; // the floating panel goes once he's been idle this long

  const off = () => !st.alive_at || Date.now() - new Date(st.alive_at).getTime() > 3 * 60e3;
  const shown = () => (off() ? 'off' : st.muted ? 'muted' : st.state);

  function inner() {
    const s = shown();
    const you = st.heard ? `<p class="jv-you${st.heard_final ? '' : ' draft'}"><span class="jv-who">You</span>${esc(st.heard)}</p>` : '';
    const him = st.reply ? `<p class="jv-him"><span class="jv-who">Jarvis</span>${esc(st.reply)}</p>` : '';
    return `<div class="jv-head"><i class="jv-dot" aria-hidden="true"></i><span class="jv-state">${esc(LABEL[s] || s)}</span>${st.conversation ? '<span class="jv-mode">conversation</span>' : ''}</div>
      <div class="jv-talk" aria-live="polite">${you}${him}${!you && !him ? '<p class="jv-empty">Say “hey Jarvis”.</p>' : ''}</div>`;
  }
  // the widget as a layout piece; size 's' keeps just the state line
  function render(filter, size) {
    return `<section class="float jv jv-${shown()}${size === 's' ? ' jv-small' : ''}" data-jv>${inner()}</section>`;
  }
  // repaint every Jarvis widget on the page (and the floating panel) without a full render
  function paint() {
    const s = shown();
    for (const el of document.querySelectorAll('[data-jv]')) {
      el.className = el.className.replace(/\bjv-(starting|idle|listening|thinking|speaking|error|muted|off)\b/g, '').trim() + ` jv-${s}`;
      el.innerHTML = inner();
      const t = el.querySelector('.jv-talk'); if (t) t.scrollTop = t.scrollHeight;
    }
    // the floating panel: away once he's been quiet a while
    if (floating) {
      const quiet = s === 'idle' || s === 'off' || s === 'muted';
      if (quiet && !st.conversation) {
        if (!quietSince) quietSince = Date.now();
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { if (Date.now() - quietSince >= HIDE_AFTER - 50) close(); }, HIDE_AFTER);
      } else { quietSince = 0; clearTimeout(hideTimer); }
    }
  }

  function apply(row) {
    if (!row) return;
    st = { ...st, ...row };
    paint();
  }
  async function load() {
    try { const { data } = await sb.from('jarvis_live').select('*').maybeSingle(); if (data) apply(data); } catch (e) {}
  }
  let tick = null;
  function start() {
    load();
    if (sb && !channel) channel = sb.channel('pos-jarvis').on('postgres_changes', { event: '*', schema: 'public', table: 'jarvis_live' }, p => apply(p.new)).subscribe();
    if (!tick) tick = setInterval(paint, 60e3); // notices when he stops checking in
  }
  function stop() { if (channel && sb) sb.removeChannel(channel); channel = null; clearInterval(tick); tick = null; close(); }

  // the floating panel (or, if this screen already has the widget, a flash of it)
  function open() {
    const placed = [...document.querySelectorAll('#view [data-jv]')];
    if (placed.length) {
      placed[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      placed[0].classList.remove('lay-flash'); void placed[0].offsetWidth; placed[0].classList.add('lay-flash');
      return 'flashed the Jarvis widget already on screen';
    }
    let p = document.getElementById('jvFloat');
    if (!p) {
      p = document.createElement('div');
      p.id = 'jvFloat';
      p.innerHTML = `<button type="button" class="jv-x" aria-label="Close Jarvis">×</button><section class="float jv" data-jv></section>`;
      p.querySelector('.jv-x').addEventListener('click', close);
      document.body.appendChild(p);
    }
    floating = true; quietSince = 0;
    p.hidden = false;
    requestAnimationFrame(() => p.classList.add('on'));
    paint();
    return 'opened the Jarvis panel';
  }
  function close() {
    floating = false; clearTimeout(hideTimer);
    const p = document.getElementById('jvFloat');
    if (p) { p.classList.remove('on'); setTimeout(() => { if (!floating) p.hidden = true; }, 250); }
  }

  return { start, stop, open, close, widget: { label: 'Jarvis', render } };
};
