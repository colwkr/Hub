// POS TV: the LG TV's remote. A press goes over a private live channel to the TV link running on the PC, which keeps
// the TV's own connection open, so it lands in about the time a message takes to cross the internet (≈ 40–60 ms).
// The channel's name is the key: it lives in one owner-only record (kind "tv", id "tv-link": { topic }).
// Presses are sent the moment a finger lands (not on lift), and carry their place in line so they arrive in order.
window.POSTV = function (ctx) {
  const { esc } = ctx;
  const R = window.POSRecords({ ...ctx, onLoad: () => join() }, ['tv'], 'pos-tv');
  const S = R.S;
  const CID = Math.random().toString(36).slice(2, 10);
  let ch = null, topic = null, seq = 0;
  let tv = null, seenAt = 0, askedAt = 0, apps = [];
  const pings = [];
  let pingT = null, waitT = null, lastPP = null, kbOpen = false, kbText = '';
  try { tv = JSON.parse(localStorage.getItem('pos.tv.last') || 'null'); apps = JSON.parse(localStorage.getItem('pos.tv.apps') || '[]'); } catch (e) {}
  if (tv) tv.stale = true;

  const svg = (d, cls = '') => `<svg class="i${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    power: svg('<path d="M12 3.5v7.5"/><path d="M7.2 6.4a7.5 7.5 0 1 0 9.6 0"/>'),
    back: svg('<path d="M9.5 6.5 4.5 11.5l5 5"/><path d="M5 11.5h9.5a4.5 4.5 0 0 1 0 9H12"/>'),
    home: svg('<path d="M4.5 11 12 4.5l7.5 6.5v7.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M10 20v-5h4v5"/>'),
    kb: svg('<rect x="3" y="6.5" width="18" height="11" rx="2.5"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7.5 14h9"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6"/>'),
    rew: svg('<path d="M11.5 7 5 12l6.5 5zM19.5 7 13 12l6.5 5z"/>', ' fill'),
    ff: svg('<path d="M12.5 7 19 12l-6.5 5zM4.5 7 11 12l-6.5 5z"/>', ' fill'),
    play: svg('<path d="M8.5 5.8v12.4L18.5 12z"/>', ' fill'),
    pause: svg('<path d="M8.5 6v12M15.5 6v12"/>', ' thick'),
    minus: svg('<path d="M6 12h12"/>'),
    plus: svg('<path d="M12 6v12M6 12h12"/>'),
    sound: svg('<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
    muted: svg('<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"/><path d="m16 9.5 4.5 5M20.5 9.5l-4.5 5"/>'),
    up: svg('<path d="m7 14 5-5 5 5"/>'), down: svg('<path d="m7 10 5 5 5-5"/>'), left: svg('<path d="m14 7-5 5 5 5"/>'), right: svg('<path d="m10 7 5 5-5 5"/>'),
  };

  /* ---------- the channel ---------- */
  function join() {
    const link = S.tv.find(r => r.id === 'tv-link');
    const t = link && link.topic;
    if (!t || !ctx.sb) return;
    if (ch && topic === t) return;
    if (ch) ctx.sb.removeChannel(ch);
    topic = t;
    ch = ctx.sb.channel(t, { config: { broadcast: { self: false, ack: false } } })
      .on('broadcast', { event: 'state' }, m => got(m.payload))
      .on('broadcast', { event: 'pong' }, m => pong(m.payload))
      .subscribe(st => { if (st === 'SUBSCRIBED') hello(); });
  }
  function leave() { if (ch && ctx.sb) ctx.sb.removeChannel(ch); ch = null; topic = null; }
  function send(c) {
    if (!ch) return false;
    if (c.c !== 'ping') { c.cid = CID; c.s = ++seq; }
    try { ch.send({ type: 'broadcast', event: 'cmd', payload: c }); } catch (e) { return false; }
    return true;
  }
  function hello() {
    askedAt = Date.now();
    send({ c: 'hello' });
    ping();
    clearTimeout(waitT);
    waitT = setTimeout(() => { if (seenAt < askedAt) ctx.rerender(); }, 3500); // no answer: say so
  }
  function ping() { send({ c: 'ping', t: Date.now(), cid: CID }); }
  function pong(p) {
    if (!p || p.cid !== CID || typeof p.t !== 'number') return;
    const ms = Date.now() - p.t;
    if (ms < 0 || ms > 10000) return;
    pings.push(ms); if (pings.length > 5) pings.shift();
    paint();
  }
  // a press reaches the TV in about half a round trip (phone → POS → PC → TV)
  const toTV = () => { if (!pings.length) return null; const s = pings.slice().sort((a, b) => a - b); return Math.max(1, Math.round(s[s.length >> 1] / 2)); };
  function got(p) {
    if (!p || typeof p !== 'object') return;
    const before = shape();
    if (Array.isArray(p.apps)) { apps = p.apps.filter(a => a && a.id).map(a => ({ id: String(a.id), title: String(a.title || a.id) })); try { localStorage.setItem('pos.tv.apps', JSON.stringify(apps)); } catch (e) {} }
    else if (tv && p.appsRev !== tv.appsRev && Date.now() - askedAt > 5000) hello();
    const keep = held && tv && hold && hold.vol != null ? tv.vol : null;
    tv = { ...p }; delete tv.apps; seenAt = Date.now();
    if (keep != null) tv.vol = keep;
    try { localStorage.setItem('pos.tv.last', JSON.stringify(tv)); } catch (e) {}
    if (tv.kb && !kbOpen) { kbOpen = true; kbText = ''; }
    if (shape() !== before) ctx.rerender(); else paint();
  }
  const alive = () => !!tv && !tv.stale && Date.now() - seenAt < 50000;
  const phase = () => {
    if (!topic && S.loaded) return 'none';
    if (!alive()) return !askedAt || Date.now() - askedAt < 3500 ? 'hello' : 'gone';
    return tv.tv || 'searching';
  };
  const isOn = () => alive() && (tv.tv === 'on' || tv.tv === 'screenoff');
  // the parts of the state that change the layout (the rest is painted in place)
  const shape = () => [phase(), isOn(), kbOpen, apps.map(a => a.id).join(','), tv && tv.app].join('|');

  /* ---------- markup ---------- */
  const STATUS = { none: 'Not set up', hello: 'Connecting', gone: 'PC link off', searching: 'Looking', pairing: 'Accept on TV', unpaired: 'Not allowed', off: 'Off', waking: 'Turning on', on: 'On', screenoff: 'Screen off' };
  function subText() {
    const ph = phase(), ms = toTV();
    if (ph === 'none') return 'The TV link isn’t set up yet.';
    if (ph === 'hello') return 'Reaching the TV link on your PC…';
    if (ph === 'gone') return 'The TV link runs on your PC. Make sure it’s on and awake.';
    if (ph === 'searching') return 'Finding the TV on your Wi-Fi…';
    if (ph === 'pairing') return 'The TV is asking to allow POS. Press Accept with the TV remote.';
    if (ph === 'unpaired') return 'The TV didn’t allow the connection.';
    const bits = [];
    if (isOn() && tv.appName) bits.push(tv.appName);
    if (ms != null) bits.push(`${ms} ms to TV`);
    return bits.join(' · ');
  }
  const k = (key, icon, label, cls = '') => `<button type="button" class="tv-b${cls}" data-tv="btn" data-k="${key}" aria-label="${label}">${icon}<span>${label}</span></button>`;
  function view() {
    if (S.failed) return '<div class="tvr"><p class="empty">The TV remote did not load. POS tries again when you come back to it.</p></div>';
    if (!S.loaded && !tv) return '<div class="tvr"><p class="empty">Loading…</p></div>';
    const ph = phase(), on = isOn(), dim = !on;
    const playing = tv && tv.play === 'playing';
    const vol = tv && tv.vol != null ? tv.vol : '–';
    const appRow = apps.length ? `<section class="tv-apps" aria-label="Apps">${apps.map(a => `<button type="button" class="tv-app${tv && tv.app === a.id ? ' cur' : ''}" data-act="tv-app" data-id="${esc(a.id)}">${esc(a.title)}</button>`).join('')}</section>` : '';
    const fix = ph === 'unpaired' || ph === 'searching' ? `<button type="button" class="btn solid" data-act="tv-pair">Ask the TV again</button>` : '';
    return `<div class="tvr${dim ? ' tv-off' : ''}" data-phase="${ph}"><div class="tvr-scroll" id="tvScroll" data-keep><div class="tv-grid">
      <section class="float tv-head">
        <div class="tv-st"><span class="lab">${esc(tv && tv.model ? 'LG TV · ' + tv.model : 'LG TV')}</span>
          <span class="tv-big" id="tvState">${esc(STATUS[ph] || 'On')}</span>
          <span class="meta" id="tvSub">${esc(subText())}</span>${fix ? `<div class="tv-fix">${fix}</div>` : ''}</div>
        <button type="button" class="tv-pow${on ? ' on' : ''}${ph === 'waking' ? ' wake' : ''}" data-tv="power" id="tvPow" aria-label="${on ? 'Turn the TV off' : 'Turn the TV on'}">${ICON.power}</button>
      </section>
      <section class="tv-pad" id="tvPad" role="application" aria-label="Touch pad. Swipe to move, tap for OK.">
        <span class="tv-hint">Swipe to move · Tap for OK</span>
        <i class="tv-ar up">${ICON.up}</i><i class="tv-ar down">${ICON.down}</i><i class="tv-ar left">${ICON.left}</i><i class="tv-ar right">${ICON.right}</i>
        <i class="tv-dot" id="tvDot"></i>
      </section>
      <div class="tv-side">
        <div class="tv-nav">${k('BACK', ICON.back, 'Back')}${k('HOME', ICON.home, 'Home')}<button type="button" class="tv-b${kbOpen ? ' sel' : ''}" data-act="tv-kb" aria-pressed="${kbOpen}">${ICON.kb}<span>Type</span></button>${k('QMENU', ICON.gear, 'Settings')}</div>
        <div class="tv-media">${k('REWIND', ICON.rew, 'Rewind', ' tv-skip')}<button type="button" class="tv-pp" data-tv="pp" id="tvPP" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? ICON.pause : ICON.play}</button>${k('FASTFORWARD', ICON.ff, 'Fast forward', ' tv-skip')}</div>
        <section class="float tv-vol">
          <button type="button" class="tv-vb" data-tv="vol" data-d="-1" aria-label="Volume down">${ICON.minus}</button>
          <div class="tv-vn"><span class="lab">Volume</span><b class="fig" id="tvVol">${vol}</b></div>
          <button type="button" class="tv-vb" data-tv="vol" data-d="1" aria-label="Volume up">${ICON.plus}</button>
          <button type="button" class="tv-mute${tv && tv.muted ? ' on' : ''}" data-tv="mute" id="tvMute" aria-pressed="${!!(tv && tv.muted)}" aria-label="Mute">${tv && tv.muted ? ICON.muted : ICON.sound}</button>
        </section>
        ${kbOpen ? `<form class="float tv-kb${tv && tv.kb ? ' ask' : ''}" id="tvKb" data-hold-render autocomplete="off"><input id="tv_text" maxlength="200" placeholder="${tv && tv.kb ? 'The TV is ready for text' : 'Type on the TV'}" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(kbText)}"><button type="submit" class="btn solid">Enter</button><button type="button" class="circle" data-act="tv-kb" aria-label="Close typing"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></form>` : ''}
        ${appRow}
      </div>
    </div></div></div>`;
  }
  // the quick-changing parts, updated where they are (no redraw, so a finger on the pad is never interrupted)
  function paint() {
    const $ = id => document.getElementById(id);
    const st = $('tvState'); if (!st) return;
    const ph = phase(), on = isOn();
    st.textContent = STATUS[ph] || 'On';
    $('tvSub').textContent = subText();
    const v = $('tvVol'); if (v) v.textContent = tv && tv.vol != null ? tv.vol : '–';
    const m = $('tvMute');
    if (m) { const mu = !!(tv && tv.muted); m.classList.toggle('on', mu); m.setAttribute('aria-pressed', mu); m.innerHTML = mu ? ICON.muted : ICON.sound; }
    const pp = $('tvPP');
    if (pp) { const pl = tv && tv.play === 'playing'; pp.innerHTML = pl ? ICON.pause : ICON.play; pp.setAttribute('aria-label', pl ? 'Pause' : 'Play'); }
    const pw = $('tvPow');
    if (pw) { pw.classList.toggle('on', on); pw.classList.toggle('wake', ph === 'waking'); pw.setAttribute('aria-label', on ? 'Turn the TV off' : 'Turn the TV on'); }
    const root = document.querySelector('.tvr'); if (root) { root.classList.toggle('tv-off', !on); root.dataset.phase = ph; }
  }

  /* ---------- feel ---------- */
  // a tick under the finger: Android vibrates; on iPhone a hidden switch gives the system tap
  let hapEl = null;
  function tick() {
    try {
      if (navigator.vibrate) { navigator.vibrate(6); return; }
      if (!/iP(hone|ad|od)|Macintosh/.test(navigator.userAgent) || !('ontouchend' in document)) return;
      if (!hapEl) {
        hapEl = document.createElement('label');
        hapEl.setAttribute('aria-hidden', 'true');
        hapEl.style.cssText = 'position:fixed;left:-200px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
        hapEl.innerHTML = '<input type="checkbox" switch tabindex="-1">';
        document.body.appendChild(hapEl);
      }
      hapEl.click();
    } catch (e) {}
  }
  function flash(el) { if (!el) return; el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit'); }
  function press(key, el) { send({ c: 'btn', k: key }); tick(); flash(el); }

  /* ---------- the pad ---------- */
  const STEP = 30; // px of finger travel per arrow press
  let pad = null;
  function padArrow(dir) {
    press(dir.toUpperCase());
    const a = document.querySelector('.tv-ar.' + dir); flash(a);
  }
  function padDown(e) {
    const el = document.getElementById('tvPad');
    if (!el) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    const r = el.getBoundingClientRect();
    pad = { id: e.pointerId, el, r, x0: e.clientX, y0: e.clientY, ax: e.clientX, ay: e.clientY, t0: performance.now(), moved: 0, swiped: 0, dir: null, stillT: null, rep: null };
    el.classList.add('touch');
    dot(e.clientX, e.clientY);
  }
  function dot(x, y) {
    const d = document.getElementById('tvDot'); if (!d || !pad) return;
    d.style.transform = `translate(${(x - pad.r.left).toFixed(0)}px,${(y - pad.r.top).toFixed(0)}px)`;
  }
  function stopRepeat() { if (!pad) return; clearTimeout(pad.stillT); clearInterval(pad.rep); pad.stillT = pad.rep = null; }
  // after a swipe, holding the finger still keeps going that way
  function armRepeat() {
    stopRepeat();
    const dir = pad.dir;
    pad.stillT = setTimeout(() => { if (pad && pad.dir === dir) pad.rep = setInterval(() => padArrow(dir), 130); }, 380);
  }
  function padMove(e) {
    if (!pad || e.pointerId !== pad.id) return;
    dot(e.clientX, e.clientY);
    pad.moved = Math.max(pad.moved, Math.hypot(e.clientX - pad.x0, e.clientY - pad.y0));
    const dx = e.clientX - pad.ax, dy = e.clientY - pad.ay;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) >= STEP) {
      const dir = ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
      const n = Math.floor(Math.max(ax, ay) / STEP);
      for (let i = 0; i < Math.min(n, 3); i++) padArrow(dir);
      pad.swiped += n; pad.dir = dir;
      if (ax > ay) { pad.ax += Math.sign(dx) * n * STEP; pad.ay = e.clientY; } else { pad.ay += Math.sign(dy) * n * STEP; pad.ax = e.clientX; }
      armRepeat();
    } else if (pad.rep && Math.max(ax, ay) > 8) { stopRepeat(); armRepeat(); }
  }
  function padUp(e) {
    if (!pad || e.pointerId !== pad.id) return;
    const p = pad; stopRepeat(); pad = null;
    p.el.classList.remove('touch');
    if (e.type === 'pointerup' && !p.swiped && p.moved < 16) { press('ENTER'); p.el.classList.remove('ok'); void p.el.offsetWidth; p.el.classList.add('ok'); }
    if (renderWanted) { renderWanted = false; ctx.rerender(); }
  }

  /* ---------- buttons: they act as the finger lands ---------- */
  let hold = null, held = false, renderWanted = false;
  function volStep(d, el) {
    if (tv && tv.vol != null) { tv.vol = Math.max(0, Math.min(100, tv.vol + d)); const v = document.getElementById('tvVol'); if (v) v.textContent = tv.vol; }
    send({ c: 'volstep', d }); tick(); flash(el);
  }
  function down(e) {
    const b = e.target.closest && e.target.closest('[data-tv]');
    if (!b || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (!ctx.canSave()) return;
    e.preventDefault();
    const what = b.dataset.tv;
    if (what === 'btn') {
      press(b.dataset.k, b);
      if (/^(REWIND|FASTFORWARD)$/.test(b.dataset.k)) startHold(b, () => press(b.dataset.k, b), 450, 260);
    } else if (what === 'vol') {
      const d = +b.dataset.d;
      volStep(d, b);
      startHold(b, () => volStep(d, b), 380, 110, true);
    } else if (what === 'mute') {
      const to = !(tv && tv.muted);
      if (tv) tv.muted = to;
      send({ c: 'mute', on: to }); tick(); paint(); flash(b);
    } else if (what === 'pp') {
      const playing = tv && tv.play ? tv.play === 'playing' : lastPP !== 'PAUSE';
      const key = playing ? 'PAUSE' : 'PLAY';
      lastPP = key;
      if (tv) tv.play = key === 'PAUSE' ? 'paused' : 'playing';
      press(key, b); paint();
    } else if (what === 'power') {
      const on = isOn();
      send({ c: 'power', on: !on }); tick(); flash(b);
      if (tv && alive()) { tv.tv = on ? 'off' : 'waking'; paint(); }
    }
  }
  function startHold(b, fn, wait, every, isVol) {
    stopHold();
    held = true;
    hold = { b, vol: isVol ? 1 : null, t: setTimeout(() => { hold.i = setInterval(fn, every); }, wait) };
    b.classList.add('held');
  }
  function stopHold() {
    if (hold) { clearTimeout(hold.t); clearInterval(hold.i); hold.b.classList.remove('held'); }
    hold = null; held = false;
    if (renderWanted && !pad) { renderWanted = false; ctx.rerender(); }
  }

  document.addEventListener('pointerdown', e => {
    if (!document.querySelector('.tvr')) return;
    if (e.target.closest && e.target.closest('#tvPad')) { if (ctx.canSave()) padDown(e); return; }
    down(e);
  });
  document.addEventListener('pointermove', padMove);
  for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, e => { padUp(e); if (hold) stopHold(); });
  document.addEventListener('pointerleave', e => { if (hold && e.target === hold.b) stopHold(); }, true);
  // swallow the click that follows a press (the press already happened)
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-tv]')) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('#tvPad, [data-tv]')) e.preventDefault(); });

  // typing: each change is sent as what was added or taken away
  document.addEventListener('input', e => {
    if (!e.target || e.target.id !== 'tv_text') return;
    const next = e.target.value, prev = kbText;
    let i = 0; while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
    if (prev.length > i) send({ c: 'del', n: prev.length - i });
    if (next.length > i) send({ c: 'text', t: next.slice(i) });
    kbText = next;
  });
  document.addEventListener('submit', e => {
    if (!e.target || e.target.id !== 'tvKb') return;
    e.preventDefault();
    send({ c: 'enter' }); tick();
    kbText = ''; const t = document.getElementById('tv_text'); if (t) { t.value = ''; t.blur(); }
  });
  // a keyboard on the computer works the TV too, when nothing else is being typed in
  document.addEventListener('keydown', e => {
    if (!document.querySelector('.tvr') || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable) || document.querySelector('dialog[open]')) return;
    const map = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'ENTER', Backspace: 'BACK', Escape: 'BACK', ' ': null };
    if (!(e.key in map)) return;
    e.preventDefault();
    if (e.key === ' ') { const pp = document.getElementById('tvPP'); if (pp) down({ target: pp, pointerType: 'key', preventDefault() {} }); return; }
    press(map[e.key]);
  });

  function act(name, b) {
    if (name === 'tv-kb') {
      const a = document.activeElement; if (a && a.id === 'tv_text') a.blur();
      kbOpen = !kbOpen; kbText = '';
      ctx.rerender();
      if (kbOpen) requestAnimationFrame(() => { const t = document.getElementById('tv_text'); if (t) t.focus(); });
      return;
    }
    if (!ctx.canSave()) return;
    if (name === 'tv-app') { send({ c: 'launch', id: b.dataset.id }); tick(); flash(b); }
    else if (name === 'tv-pair') { send({ c: 'pair' }); if (tv) { tv.tv = 'searching'; paint(); } }
  }

  // while the remote is open, keep the measure of how quick it is fresh
  pingT = setInterval(() => { if (ch && !document.hidden && document.querySelector('.tvr')) ping(); }, 15000);
  function shown(yes) { if (yes && ch) hello(); }
  const busy = () => !!pad || held;
  const wantRender = () => { renderWanted = true; };
  function start() { R.start(); if (ch) hello(); }
  function stop() { leave(); R.stop(); }
  const add = () => act('tv-kb');
  return { view, act, add, busy, wantRender, shown, start, stop, send };
};
