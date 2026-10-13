// POS TV remote: the LG TV's remote. A press goes over a private live channel to the TV link running on the PC, which
// keeps the TV's own connection open, so it lands in about the time a message takes to cross the internet (≈ 40–60 ms).
// The channel's name is the key: it lives in one owner-only record (kind "tv", id "tv-link": { topic }).
// Presses go the moment a finger lands (not on lift), and carry their place in line so they arrive in order.
window.POSTV = function (ctx) {
  const { esc, toast } = ctx;
  const R = window.POSRecords({ ...ctx, onLoad: () => join() }, ['tv'], 'pos-tv');
  const S = R.S;
  const CID = Math.random().toString(36).slice(2, 10);
  let ch = null, topic = null, seq = 0;
  let tv = null, seenAt = 0, askedAt = 0, apps = [], icons = {}, iconsAsked = false;
  const pings = [];
  let waitT = null, lastPP = null, kbOpen = false, kbText = '';
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || d; } catch (e) { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  tv = load('pos.tv.last', null); apps = load('pos.tv.apps', []); icons = load('pos.tv.icons', {});
  if (tv) tv.stale = true;

  // the only apps shown, in this order; each is found among what's installed on the TV
  const WANT = [
    { name: 'YouTube', re: /^youtube$/i, id: /^youtube\.leanback/i },
    { name: 'Netflix', re: /netflix/i },
    { name: 'Crunchyroll', re: /crunchyroll/i },
    { name: 'Prime Video', re: /prime video|^amazon/i, id: /^amazon$/i },
    { name: 'Hulu', re: /^hulu/i },
    { name: 'Spotify', re: /spotify/i },
    { name: 'Disney+', re: /disney/i },
    { name: 'Apple TV', re: /^apple ?tv/i, id: /appletv/i },
    { name: 'HBO Max', re: /^(hbo ?)?max$|hbo/i, id: /hbo|max/i },
  ];
  const shelf = () => WANT.map(w => ({ ...w, app: apps.find(a => (w.id && w.id.test(a.id)) || w.re.test(a.title)) || null }));

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
    minus: svg('<path d="M6.5 12h11"/>'),
    plus: svg('<path d="M12 6.5v11M6.5 12h11"/>'),
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
      .on('broadcast', { event: 'icon' }, m => gotIcon(m.payload))
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
    waitT = setTimeout(() => { if (seenAt < askedAt) { paint(); ctx.rerender(); } }, 3500); // no answer: say so
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
    if (Array.isArray(p.apps)) { apps = p.apps.filter(a => a && a.id).map(a => ({ id: String(a.id), title: String(a.title || a.id) })); keep('pos.tv.apps', apps); askIcons(); }
    else if (tv && p.appsRev !== tv.appsRev && Date.now() - askedAt > 5000) hello();
    const mine = vol.drag || Date.now() < vol.holdUntil ? tv && tv.vol : null; // the slider under your finger wins
    tv = { ...p }; delete tv.apps; seenAt = Date.now();
    if (mine != null) tv.vol = mine;
    keep('pos.tv.last', tv);
    if (tv.kb && !kbOpen) { kbOpen = true; kbText = ''; }
    paint();
    if (shape() !== before) ctx.rerender();
  }
  // the pictures the TV itself shows for each app, asked for once and kept on this device
  function askIcons() {
    if (iconsAsked) return;
    const need = shelf().filter(w => w.app && !icons[w.app.id]).map(w => w.app.id);
    if (!need.length) return;
    iconsAsked = true;
    send({ c: 'icons', ids: need });
  }
  function gotIcon(p) {
    if (!p || typeof p.id !== 'string' || typeof p.src !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(p.src)) return;
    icons[p.id] = { src: p.src, bg: typeof p.bg === 'string' && /^#[0-9a-f]{3,8}$/i.test(p.bg) ? p.bg : null };
    keep('pos.tv.icons', icons);
    if (document.querySelector('.tv-apps')) ctx.rerender();
  }
  const alive = () => !!tv && !tv.stale && Date.now() - seenAt < 50000;
  const phase = () => {
    if (!topic && S.loaded) return 'none';
    if (!alive()) return !askedAt || Date.now() - askedAt < 3500 ? 'hello' : 'gone';
    return tv.tv || 'searching';
  };
  const isOn = () => alive() && (tv.tv === 'on' || tv.tv === 'screenoff');
  // the parts of the state that change the layout (the rest is painted in place)
  const shape = () => [phase(), isOn(), kbOpen, apps.map(a => a.id).join(',')].join('|');

  /* ---------- markup ---------- */
  const STATUS = { none: 'Not set up', hello: 'Connecting', gone: 'PC link off', searching: 'Looking', pairing: 'Accept on TV', unpaired: 'Not allowed', off: 'Off', waking: 'Turning on', on: 'On', screenoff: 'Screen off' };
  function subText() {
    const ph = phase(), ms = toTV();
    if (ph === 'none') return 'The TV link isn’t set up yet.';
    if (ph === 'hello') return 'Reaching the TV link on your PC…';
    if (ph === 'gone') return 'The TV link runs on your PC. Make sure it’s on and awake.';
    if (ph === 'searching') return 'Finding the TV on your Wi-Fi…';
    if (ph === 'pairing') return 'The TV is asking to allow ' + posName() + '. Press Accept with the TV remote.';
    if (ph === 'unpaired') return 'The TV didn’t allow the connection.';
    const bits = [];
    if (isOn() && tv.appName) bits.push(tv.appName);
    if (ms != null) bits.push(`${ms} ms`);
    return bits.join(' · ');
  }
  const k = (key, icon, label, cls = '') => `<button type="button" class="tv-b${cls}" data-tv="btn" data-k="${key}" aria-label="${label}">${icon}<span>${label}</span></button>`;
  function appTile(w) {
    const a = w.app, ic = a && icons[a.id], cur = a && tv && tv.app === a.id;
    const style = ic && ic.bg ? ` style="--app-bg:${ic.bg}"` : '';
    return `<button type="button" class="tv-app${ic ? ' pic' : ''}${cur ? ' cur' : ''}${a ? '' : ' none'}" data-act="tv-app" data-id="${esc(a ? a.id : '')}" data-name="${esc(w.name)}" aria-label="${esc(w.name)}${a ? '' : ' (not on the TV)'}" title="${esc(w.name)}"${style}>`
      + (ic ? `<img src="${ic.src}" alt="" draggable="false">` : `<span>${esc(w.name)}</span>`) + '</button>';
  }
  function view() {
    if (S.failed) return '<div class="tvr"><p class="empty">The TV remote did not load. ' + posName() + ' tries again when you come back to it.</p></div>';
    if (!S.loaded && !tv) return '<div class="tvr"><p class="empty">Loading…</p></div>';
    const ph = phase(), on = isOn();
    const playing = tv && tv.play === 'playing';
    const v = curVol();
    const fix = ph === 'unpaired' || ph === 'searching' ? '<button type="button" class="btn solid" data-act="tv-pair">Ask the TV again</button>' : '';
    const bottom = kbOpen
      ? `<form class="float tv-kb${tv && tv.kb ? ' ask' : ''}" id="tvKb" data-hold-render autocomplete="off"><input id="tv_text" maxlength="200" placeholder="${tv && tv.kb ? 'The TV is ready for text' : 'Type on the TV'}" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(kbText)}"><button type="submit" class="btn solid">Enter</button><button type="button" class="circle" data-act="tv-kb" aria-label="Close typing"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></form>`
      : `<section class="tv-apps" aria-label="Apps">${shelf().map(appTile).join('')}</section>`;
    return `<div class="tvr${on ? '' : ' tv-off'}" data-phase="${ph}">
      <section class="float tv-head">
        <div class="tv-st"><span class="tv-big" id="tvState">${esc(STATUS[ph] || 'On')}</span>
          <span class="meta" id="tvSub">${esc(subText())}</span>${fix ? `<div class="tv-fix">${fix}</div>` : ''}</div>
        <button type="button" class="tv-pow${on ? ' on' : ''}${ph === 'waking' ? ' wake' : ''}" data-tv="power" id="tvPow" aria-label="${on ? 'Turn the TV off' : 'Turn the TV on'}">${ICON.power}</button>
      </section>
      <div class="tv-padbox"><div class="tv-dpad" id="tvPad" role="application" aria-label="Arrows and OK (the arrow keys and Enter work too)">
        <i class="tv-ar up">${ICON.up}</i><i class="tv-ar down">${ICON.down}</i><i class="tv-ar left">${ICON.left}</i><i class="tv-ar right">${ICON.right}</i>
        <span class="tv-ok">OK</span>
      </div></div>
      <div class="tv-nav">${k('BACK', ICON.back, 'Back')}${k('HOME', ICON.home, 'Home')}<button type="button" class="tv-b${tv && tv.muted ? ' sel' : ''}" data-tv="mute" id="tvMute" aria-pressed="${!!(tv && tv.muted)}" aria-label="Mute">${tv && tv.muted ? ICON.muted : ICON.sound}<span>Mute</span></button><button type="button" class="tv-b${kbOpen ? ' sel' : ''}" data-act="tv-kb" aria-pressed="${kbOpen}">${ICON.kb}<span>Type</span></button>${k('QMENU', ICON.gear, 'Settings')}</div>
      <div class="tv-media">${k('REWIND', ICON.rew, 'Rewind', ' tv-skip')}<button type="button" class="tv-pp" data-tv="pp" id="tvPP" aria-label="${playing ? 'Pause' : 'Play'}">${playing ? ICON.pause : ICON.play}</button>${k('FASTFORWARD', ICON.ff, 'Fast forward', ' tv-skip')}</div>
      <aside class="tv-volr" aria-label="Volume">
        <button type="button" class="tv-vs" data-tv="vol" data-d="1" aria-label="Volume up">${ICON.plus}</button>
        <b class="tv-vnum fig" id="tvVol">${v == null ? '–' : v}</b>
        <div class="tv-track" id="tvTrack" role="slider" tabindex="0" aria-label="Volume" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v == null ? 0 : v}">
          <i class="tv-rail"><i class="tv-fill" id="tvFill" style="height:${v == null ? 0 : v}%"></i><i class="tv-knob" id="tvKnob" style="bottom:${v == null ? 0 : v}%"><b class="tv-bubble fig" id="tvBubble">${v == null ? '' : v}</b></i></i>
        </div>
        <button type="button" class="tv-vs" data-tv="vol" data-d="-1" aria-label="Volume down">${ICON.minus}</button>
      </aside>
      ${bottom}
    </div>`;
  }
  // the quick-changing parts, updated where they are (no redraw, so a finger on the remote is never interrupted)
  function paint() {
    const $ = id => document.getElementById(id);
    const st = $('tvState'); if (!st) return;
    const ph = phase(), on = isOn();
    st.textContent = STATUS[ph] || 'On';
    $('tvSub').textContent = subText();
    paintVol();
    const m = $('tvMute');
    if (m) { const mu = !!(tv && tv.muted); m.classList.toggle('sel', mu); m.setAttribute('aria-pressed', mu); m.innerHTML = (mu ? ICON.muted : ICON.sound) + '<span>Mute</span>'; }
    const pp = $('tvPP');
    if (pp) { const pl = tv && tv.play === 'playing'; pp.innerHTML = pl ? ICON.pause : ICON.play; pp.setAttribute('aria-label', pl ? 'Pause' : 'Play'); }
    const pw = $('tvPow');
    if (pw) { pw.classList.toggle('on', on); pw.classList.toggle('wake', ph === 'waking'); pw.setAttribute('aria-label', on ? 'Turn the TV off' : 'Turn the TV on'); }
    const root = document.querySelector('.tvr'); if (root) { root.classList.toggle('tv-off', !on); root.dataset.phase = ph; }
    for (const el of document.querySelectorAll('.tv-app')) el.classList.toggle('cur', !!(tv && el.dataset.id && tv.app === el.dataset.id));
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

  /* ---------- the arrows and OK: one press per touch, like the remote (hold an arrow to keep going) ---------- */
  let pad = null;
  function zone(el, x, y) {
    const r = el.getBoundingClientRect(), R = r.width / 2;
    const dx = x - (r.left + R), dy = y - (r.top + r.height / 2), d = Math.hypot(dx, dy);
    if (d <= R * 0.36) return 'ok';
    if (d > R * 1.08) return null;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  }
  function padDown(e) {
    const el = document.getElementById('tvPad');
    if (!el) return;
    const z = zone(el, e.clientX, e.clientY);
    if (!z) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    const key = z === 'ok' ? 'ENTER' : z.toUpperCase();
    press(key);
    el.dataset.p = z;
    pad = { id: e.pointerId, el, rep: null, t: null };
    if (z !== 'ok') pad.t = setTimeout(() => { if (pad) pad.rep = setInterval(() => press(key), 150); }, 500);
  }
  function padUp(e) {
    if (!pad || e.pointerId !== pad.id) return;
    clearTimeout(pad.t); clearInterval(pad.rep);
    const el = pad.el; pad = null;
    setTimeout(() => { if (!pad) delete el.dataset.p; }, 90);
    if (renderWanted && !busy()) { renderWanted = false; ctx.rerender(); }
  }

  /* ---------- volume: a slider down the right side (drag the whole way for 0 to 100), with + and − ---------- */
  const vol = { drag: null, holdUntil: 0, sentAt: 0, sendT: null };
  const curVol = () => (tv && tv.vol != null ? tv.vol : null);
  function paintVol() {
    const v = curVol(), $ = id => document.getElementById(id);
    const n = $('tvVol'); if (!n) return;
    n.textContent = v == null ? '–' : v;
    const p = v == null ? 0 : v;
    $('tvFill').style.height = p + '%';
    $('tvKnob').style.bottom = p + '%';
    $('tvBubble').textContent = v == null ? '' : v;
    $('tvTrack').setAttribute('aria-valuenow', p);
  }
  function setVol(v, now) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    if (!tv) return;
    if (tv.vol === v && !now) return;
    tv.vol = v; vol.holdUntil = Date.now() + 900;
    paintVol();
    const go = () => { vol.sentAt = Date.now(); vol.sendT = null; send({ c: 'vol', v: tv.vol }); };
    clearTimeout(vol.sendT);
    if (now || Date.now() - vol.sentAt >= 60) go(); else vol.sendT = setTimeout(go, 60 - (Date.now() - vol.sentAt));
  }
  function trackDown(e) {
    const el = document.getElementById('tvTrack');
    if (!el || curVol() == null) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    const r = el.getBoundingClientRect();
    vol.drag = { id: e.pointerId, y0: e.clientY, v0: curVol(), h: Math.max(80, r.height), el };
    el.classList.add('held'); tick();
  }
  function trackMove(e) {
    const d = vol.drag;
    if (!d || e.pointerId !== d.id) return;
    setVol(d.v0 + (d.y0 - e.clientY) / d.h * 100);
  }
  function trackUp(e) {
    const d = vol.drag;
    if (!d || e.pointerId !== d.id) return;
    vol.drag = null;
    d.el.classList.remove('held');
    if (tv && tv.vol != null && tv.vol !== d.v0) setVol(tv.vol, true);
    if (renderWanted && !busy()) { renderWanted = false; ctx.rerender(); }
  }
  function volStep(d, el) {
    if (tv && tv.vol != null) { tv.vol = Math.max(0, Math.min(100, tv.vol + d)); vol.holdUntil = Date.now() + 900; paintVol(); }
    send({ c: 'volstep', d }); tick(); flash(el);
  }

  /* ---------- buttons: they act as the finger lands ---------- */
  let hold = null, renderWanted = false;
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
      startHold(b, () => volStep(d, b), 380, 110);
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
  function startHold(b, fn, wait, every) {
    stopHold();
    hold = { b, t: setTimeout(() => { if (hold) hold.i = setInterval(fn, every); }, wait) };
    b.classList.add('held');
  }
  function stopHold() {
    if (hold) { clearTimeout(hold.t); clearInterval(hold.i); hold.b.classList.remove('held'); }
    hold = null;
    if (renderWanted && !busy()) { renderWanted = false; ctx.rerender(); }
  }

  document.addEventListener('pointerdown', e => {
    if (!document.querySelector('.tvr') || !e.target.closest) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('#tvPad')) { if (ctx.canSave()) padDown(e); return; }
    if (e.target.closest('#tvTrack')) { if (ctx.canSave()) trackDown(e); return; }
    down(e);
  });
  document.addEventListener('pointermove', trackMove);
  for (const t of ['pointerup', 'pointercancel']) document.addEventListener(t, e => { padUp(e); trackUp(e); if (hold) stopHold(); });
  document.addEventListener('pointerleave', e => { if (hold && e.target === hold.b) stopHold(); }, true);
  // swallow the click that follows a press (the press already happened)
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-tv], #tvPad, #tvTrack')) { e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('.tvr')) e.preventDefault(); });

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
    if (e.target && e.target.id === 'tvTrack' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); volStep(e.key === 'ArrowUp' ? 1 : -1); return; }
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
    if (name === 'tv-app') {
      if (!b.dataset.id) { toast(`${b.dataset.name} isn’t on the TV`); return; }
      send({ c: 'launch', id: b.dataset.id }); tick(); flash(b);
    } else if (name === 'tv-pair') { send({ c: 'pair' }); if (tv) { tv.tv = 'searching'; paint(); } }
  }

  /* ---------- for the assistant: "turn on the TV", "volume 20", "put on Netflix" ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // is the PC link answering? ask once and wait a moment
  async function reach() {
    if (!ch) return false;
    if (alive()) return true;
    hello();
    for (let i = 0; i < 20; i++) { await sleep(100); if (alive()) return true; }
    return false;
  }
  async function command(c) {
    if (!ctx.canSave()) return { ok: false, say: 'Sign in to use the TV.' };
    if (!topic) return { ok: false, say: "The TV link isn't set up yet." };
    const up = await reach();
    if (!up) return { ok: false, say: "The TV link on your PC isn't answering. Make sure the PC is on and awake." };
    const cmd = String(c.command || ''), n = Number.isFinite(+c.level) ? Math.round(+c.level) : null;
    if (cmd === 'power_on' || cmd === 'power_off') {
      const on = cmd === 'power_on';
      if (on === isOn()) return { ok: true, say: `The TV's already ${on ? 'on' : 'off'}.` };
      send({ c: 'power', on }); tick();
      if (tv) tv.tv = on ? 'waking' : 'off';
      paint(); return { ok: true, say: on ? 'TV on.' : 'TV off.' };
    }
    if (!isOn()) return { ok: false, say: 'The TV is off. Say turn on the TV first.' };
    if (cmd === 'volume_set' && n != null) { setVol(n, true); return { ok: true, say: `Volume ${Math.max(0, Math.min(100, n))}.` }; }
    if (cmd === 'volume_up' || cmd === 'volume_down') {
      const d = (cmd === 'volume_up' ? 1 : -1) * Math.max(1, Math.min(30, n || 5));
      if (tv && tv.vol != null) { setVol(tv.vol + d, true); return { ok: true, say: `Volume ${tv.vol}.` }; }
      for (let i = 0; i < Math.abs(d); i++) send({ c: 'volstep', d: Math.sign(d) });
      return { ok: true, say: d > 0 ? 'Louder.' : 'Quieter.' };
    }
    if (cmd === 'mute' || cmd === 'unmute') { const on = cmd === 'mute'; if (tv) tv.muted = on; send({ c: 'mute', on }); paint(); return { ok: true, say: on ? 'Muted.' : 'Sound on.' }; }
    if (cmd === 'play' || cmd === 'pause') { press(cmd === 'play' ? 'PLAY' : 'PAUSE'); if (tv) tv.play = cmd === 'play' ? 'playing' : 'paused'; paint(); return { ok: true, say: cmd === 'play' ? 'Playing.' : 'Paused.' }; }
    if (cmd === 'home' || cmd === 'back') { press(cmd.toUpperCase()); return { ok: true, say: cmd === 'home' ? 'Home.' : 'Back.' }; }
    if (cmd === 'open_app') {
      const want = String(c.app || '').toLowerCase().replace(/[^a-z0-9+ ]/g, '').trim();
      if (!want) return { ok: false, say: 'Which app?' };
      const w = shelf().find(x => x.re.test(want) || x.name.toLowerCase() === want || want.includes(x.name.toLowerCase()));
      const a = (w && w.app) || apps.find(x => x.title.toLowerCase() === want) || apps.find(x => x.title.toLowerCase().includes(want));
      if (!a) return { ok: false, say: `I don't see ${c.app} on the TV.` };
      send({ c: 'launch', id: a.id }); tick();
      return { ok: true, say: `${w ? w.name : a.title} on the TV.` };
    }
    return { ok: false, say: "I didn't catch what to do with the TV." };
  }
  const brief = () => ({ link: !!topic, state: alive() ? tv.tv || 'searching' : 'unknown', app: alive() && isOn() ? tv.appName || '' : '', volume: alive() && isOn() ? tv.vol : null });

  // while the remote is open, keep the measure of how quick it is fresh
  setInterval(() => { if (ch && !document.hidden && document.querySelector('.tvr')) ping(); }, 15000);
  function shown(yes) { if (yes && ch) { hello(); iconsAsked = false; askIcons(); } }
  const busy = () => !!pad || !!hold || !!vol.drag;
  const wantRender = () => { renderWanted = true; };
  function start() { R.start(); if (ch) hello(); }
  function stop() { leave(); R.stop(); }
  const add = () => act('tv-kb');
  return { view, act, add, busy, wantRender, shown, start, stop, send, command, brief };
};
