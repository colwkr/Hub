// POS Focus: one thing at a time, full screen, with the clock running down to the end of its time on the calendar.
// It follows the calendar: when one thing's time is up it rolls into whatever comes next, and between things it counts
// down to the next start, so it can stay open all day. The times come from the calendar; nothing here edits them.
// Open from a task's sheet, or the Focus button on whatever's happening now on the calendar.
window.POSFocus = function (ctx) {
  const { esc, items, done, edit, ready } = ctx;
  const KEY = 'pos.focus';
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  const tm = ms => timeFmt.format(ms);
  const durTxt = mins => (mins >= 60 ? `${Math.floor(mins / 60)} hr${mins % 60 ? ` ${mins % 60} min` : ''}` : `${mins} min`);
  const still = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  let on = false, pin = null, skip = new Set(), list = [], el = null, raf = 0, lock = null, fsMine = false;
  let shownKey = '', shownMode = '', lastSec = -1, wantRestore = false;

  // carried over a reload (a new version, or the page coming back): still focusing, on what, and what was skipped
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.on && Date.now() - (s.at || 0) < 20 * 3600e3) { wantRestore = true; pin = s.pin || null; skip = new Set(s.skip || []); }
  } catch (e) {}
  const remember = () => { try { if (on) localStorage.setItem(KEY, JSON.stringify({ on: 1, pin, skip: [...skip], at: Date.now() })); else localStorage.removeItem(KEY); } catch (e) {} };

  /* ---------- what's on now, and what's next ---------- */
  const open_ = x => !x.done && !skip.has(x.key);
  function pick(now) {
    if (pin) {
      const p = list.find(x => x.key === pin);
      if (p && open_(p) && now < p.e) return { mode: p.s > now ? 'wait' : 'now', x: p };
      pin = null; remember();
    }
    // happening now: the one that started last (something inside a longer stretch takes over while it runs)
    const live = list.filter(x => open_(x) && x.s <= now && now < x.e).sort((a, b) => b.s - a.s || a.e - b.e)[0];
    if (live) return { mode: 'now', x: live };
    const next = list.filter(x => open_(x) && x.s > now).sort((a, b) => a.s - b.s)[0];
    if (next) return { mode: 'wait', x: next };
    return { mode: 'free', x: null };
  }
  // what comes after the one on screen
  function then(cur, now) {
    if (!cur) return null;
    return list.filter(x => open_(x) && x.key !== cur.key && x.s > now && x.s >= cur.s).sort((a, b) => a.s - b.s)[0] || null;
  }
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  /* ---------- the screen ---------- */
  const CELL = ch => `<i class="${/\d/.test(ch) ? 'd' : 'c'}">${ch}</i>`;
  const cells = s => [...s].map(CELL).join('');
  function build() {
    el = document.createElement('div');
    el.className = 'fx';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Focus');
    el.innerHTML = `
      <div class="fx-top">
        <span class="fx-brand"><i class="fx-dot" aria-hidden="true"></i>Focus</span>
        <span class="fx-now" aria-hidden="true"></span>
        <button type="button" class="fx-x" data-fx="exit" aria-label="Leave Focus"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button>
      </div>
      <div class="fx-main">
        <span class="fx-kind"></span>
        <button type="button" class="fx-title" data-fx="edit"></button>
        <span class="fx-when"></span>
        <div class="fx-clock" role="timer" aria-live="off"><span class="fx-hms"></span><span class="fx-ms"></span></div>
        <div class="fx-tick" aria-hidden="true"><i></i></div>
        <div class="fx-bar" aria-hidden="true"><div class="fx-track"><i class="fx-fill"></i></div><div class="fx-ends"><span class="fx-a"></span><span class="fx-left"></span><span class="fx-b"></span></div></div>
      </div>
      <div class="fx-foot">
        <span class="fx-then"></span>
        <div class="fx-acts">
          <button type="button" class="fx-btn" data-fx="skip">Skip</button>
          <button type="button" class="fx-btn solid" data-fx="done">Done</button>
        </div>
      </div>
      <p class="sr-only fx-say" aria-live="polite"></p>`;
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-fx]');
      if (!b) return;
      const what = b.dataset.fx, cur = el._cur;
      if (what === 'exit') close();
      else if (what === 'skip' && cur) { skip.add(cur.key); if (pin === cur.key) pin = null; remember(); draw(true); }
      else if (what === 'done' && cur && cur.id && cur.kind === 'task') done(cur.id);
      else if (what === 'edit' && cur && cur.id) edit(cur.id);
    });
    document.body.appendChild(el);
    return el;
  }
  const $ = s => el.querySelector(s);
  function setText(sel, v) { const n = $(sel); if (n.textContent !== v) n.textContent = v; }

  // the parts that only change when the thing on screen does
  function drawItem(p, now) {
    const x = p.x, key = (x ? x.key : '') + '|' + p.mode;
    el.dataset.mode = p.mode;
    el._cur = p.mode === 'now' ? x : p.mode === 'wait' ? x : null;
    if (key === shownKey + '|' + shownMode) return;
    const changed = shownKey !== '' && (x ? x.key : '') !== shownKey;
    shownKey = x ? x.key : ''; shownMode = p.mode;
    const kindName = x ? ({ task: 'Task', event: 'Event', meeting: 'Meeting', gcal: 'Calendar' }[x.kind] || 'Task') : '';
    if (p.mode === 'now') setText('.fx-kind', `Now · ${kindName}`);
    else if (p.mode === 'wait') setText('.fx-kind', sameDay(x.s, now) ? 'Up next in' : `Up next · ${dayFmt.format(x.s)}`);
    else setText('.fx-kind', 'Nothing else on the calendar');
    setText('.fx-title', x ? x.title : 'You’re free');
    $('.fx-title').disabled = !(x && x.id);
    const mins = x ? Math.round((x.e - x.s) / 60000) : 0;
    setText('.fx-when', x ? `${tm(x.s)} – ${tm(x.e)} · ${durTxt(mins)}${x.place ? ` · ${x.place}` : ''}` : 'Add something to the calendar and Focus picks it up.');
    setText('.fx-a', x && p.mode === 'now' ? tm(x.s) : '');
    setText('.fx-b', x && p.mode === 'now' ? tm(x.e) : '');
    $('.fx-acts [data-fx="done"]').hidden = !(x && x.kind === 'task' && x.id);
    $('.fx-acts [data-fx="skip"]').hidden = !x;
    setText('.fx-say', x ? `${p.mode === 'now' ? 'Now' : 'Up next'}: ${x.title}, until ${tm(p.mode === 'now' ? x.e : x.s)}` : 'Nothing else on the calendar');
    // a new thing: a quick flash, and a buzz where the phone allows it
    if (changed && !still()) {
      el.classList.remove('fx-swap'); void el.offsetWidth; el.classList.add('fx-swap');
      if (navigator.vibrate) try { navigator.vibrate([60, 40, 60]); } catch (e) {}
    }
  }
  function frame() {
    raf = 0;
    if (!on || !el) return;
    draw(false);
    raf = requestAnimationFrame(frame);
  }
  function draw(force) {
    const now = Date.now(), p = pick(now);
    drawItem(p, now);
    const x = p.x;
    // the clock: down to the end of now, or the start of what's next; with nothing left, the time of day
    let left, total = 1, done_ = 0;
    if (p.mode === 'now') { left = x.e - now; total = x.e - x.s; done_ = now - x.s; }
    else if (p.mode === 'wait') left = x.s - now;
    else left = null;
    let hms, ms;
    if (left == null) {
      const d = new Date(now);
      hms = tm(now).replace(/\s?[AP]M$/i, '') + ':' + String(d.getSeconds()).padStart(2, '0');
      ms = '.' + String(d.getMilliseconds()).padStart(3, '0');
    } else {
      const L = Math.max(0, left), h = Math.floor(L / 3600e3), m = Math.floor(L / 60e3) % 60, s = Math.floor(L / 1000) % 60;
      hms = (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
      ms = '.' + String(Math.floor(L % 1000)).padStart(3, '0');
    }
    const H = $('.fx-hms');
    if (H.dataset.v !== hms) {
      const lenCls = hms.length > 7 ? 'xl' : hms.length > 5 ? 'lg' : '';
      if ((H.dataset.len || '') !== lenCls) { H.dataset.len = lenCls; $('.fx-clock').dataset.len = lenCls; }
      H.innerHTML = cells(hms); H.dataset.v = hms;
    }
    $('.fx-ms').textContent = ms;
    // each second: the small bar empties, and the digits give a tick
    const secFrac = left == null ? (now % 1000) / 1000 : 1 - ((Math.max(0, left) % 1000) / 1000);
    $('.fx-tick i').style.transform = `scaleX(${(1 - secFrac).toFixed(3)})`;
    const sec = Math.floor(now / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      setText('.fx-now', tm(now));
      if (!still()) { H.classList.remove('beat'); void H.offsetWidth; H.classList.add('beat'); }
    }
    const urgent = left != null && p.mode === 'now' && left < 60e3, final = urgent && left < 10e3;
    el.classList.toggle('fx-urgent', urgent);
    el.classList.toggle('fx-final', final);
    // how far through it you are
    const f = p.mode === 'now' ? Math.min(1, Math.max(0, done_ / Math.max(1, total))) : 0;
    $('.fx-fill').style.transform = `scaleX(${f.toFixed(4)})`;
    setText('.fx-left', p.mode === 'now' ? `${Math.floor(f * 100)}% through` : '');
    const nx = then(p.mode === 'now' ? x : null, now) || null;
    setText('.fx-then', p.mode === 'now' ? (nx ? `Then · ${nx.title} · ${sameDay(nx.s, now) ? tm(nx.s) : `${dayFmt.format(nx.s)} ${tm(nx.s)}`}` : 'Then · nothing else today') : '');
  }

  /* ---------- in and out ---------- */
  async function keepAwake() {
    if (!('wakeLock' in navigator) || lock) return;
    try { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } catch (e) { lock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && on) { keepAwake(); if (!raf) raf = requestAnimationFrame(frame); } });
  function open(key, opts = {}) {
    list = items();
    if (key) { pin = key; skip.delete(key); }
    if (!on) {
      on = true;
      if (!el) build();
      el.hidden = false;
      document.body.classList.add('fx-on');
      // full screen where the device allows it (iPhone keeps its bars; the screen is still all Focus)
      if (!opts.quiet && !document.fullscreenElement) {
        const r = document.documentElement, go = r.requestFullscreen || r.webkitRequestFullscreen;
        if (go) { try { const pr = go.call(r, { navigationUI: 'hide' }); fsMine = true; if (pr && pr.catch) pr.catch(() => { fsMine = false; }); } catch (e) { fsMine = false; } }
      }
      keepAwake();
      if (!still()) { el.classList.remove('fx-in'); void el.offsetWidth; el.classList.add('fx-in'); }
    }
    shownKey = ''; shownMode = '';
    remember();
    draw(true);
    if (!raf) raf = requestAnimationFrame(frame);
    const x = $('.fx-x'); if (x && !opts.quiet) x.focus({ preventScroll: true });
  }
  function close() {
    if (!on) return;
    on = false; pin = null; skip.clear(); remember();
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (el) el.hidden = true;
    document.body.classList.remove('fx-on');
    if (fsMine && (document.fullscreenElement || document.webkitFullscreenElement)) { const ex = document.exitFullscreen || document.webkitExitFullscreen; try { ex && ex.call(document); } catch (e) {} }
    fsMine = false;
    if (lock) { try { lock.release(); } catch (e) {} lock = null; }
  }
  document.addEventListener('keydown', e => {
    if (!on || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    e.preventDefault(); close();
  });
  // the calendar changed (a task done, moved, added): look again
  function refresh() {
    if (wantRestore && ready()) { wantRestore = false; const p = pin; open(p, { quiet: true }); return; }
    if (!on) return;
    list = items();
    draw(true);
  }
  return { open, close, refresh, isOpen: () => on };
};
