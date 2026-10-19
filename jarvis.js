/* The Jarvis widget: the voice assistant on the PC, live. Its state as a colour (grey waiting, blue pulsing listening,
   amber thinking, green speaking, red muted), what you're saying as he transcribes it, his reply as it streams, two
   scrolling waveforms (You: your mic, Jarvis: his voice) and the word he's saying lit up as he says it.
   Two sources. On the PC it connects to Jarvis's own live stream (a WebSocket inside his process, by default
   ws://127.0.0.1:47821): it tries on load, again whenever the 'jarvis' command brings args.stream, and quietly retries
   with backoff while he isn't running. While that's connected, state, muted, conversation, what you said and his reply
   come from it, with mic and voice levels every twenty milliseconds and exact word timing (speech / word messages).
   Otherwise (always on the phone and iPad) it reads the jarvis_live row and follows it by realtime, and the word being
   spoken is estimated from the time since speech began.
   Place it on any screen with a layout row (widget id jarvis.live), or let it float: Jarvis sends a 'jarvis' command
   when he hears his wake word, and the floating panel shows on that device (unless args.open is false) and tucks
   itself away a few seconds after the conversation ends. Live updates repaint only the widget, never the whole page;
   the waveform canvases are kept across repaints and drawn every frame while the stream is up. */
window.POSJarvis = function (ctx) {
  const { sb, esc } = ctx;
  let st = { state: 'idle', muted: false, conversation: false, heard: '', heard_final: false, reply: '', turn: 0, alive_at: null };
  let channel = null, floating = false, hideTimer = null, quietSince = 0;
  const LABEL = { starting: 'Starting', idle: 'Waiting for “hey Jarvis”', listening: 'Listening', thinking: 'Thinking',
    speaking: 'Speaking', error: 'Something went wrong', muted: 'Muted', off: 'Jarvis isn’t running' };
  const HIDE_AFTER = 6000; // the floating panel goes once he's been idle this long

  /* ---------- the live stream (PC only) ---------- */
  const STREAM_DEFAULT = 'ws://127.0.0.1:47821';
  const WINDOW = 4000;   // the waveforms show the last four seconds
  const DELAY = 120;     // drawn this far behind now, so batches of levels arrive before they scroll in
  const ua = navigator.userAgent || '';
  const mobile = /iPhone|iPad|iPod|Android/i.test(ua) || ((navigator.maxTouchPoints || 0) > 1 && /Macintosh/.test(ua));
  const named = (() => { try { return String(localStorage.getItem('pos.device') || '').toLowerCase(); } catch (e) { return ''; } })();
  const desktop = named === 'pc' || !mobile; // only the PC can reach his stream; a touchscreen Windows PC counts
  let ws = null, live = false, want = false, userOff = false, retry = null, backoff = 0, levelMs = 20;
  let url = (() => { try { return localStorage.getItem('pos.jvStream') || STREAM_DEFAULT; } catch (e) { return STREAM_DEFAULT; } })();
  const waves = { mic: [], tts: [] }; // {t: epoch ms, l: RMS 0..1}, oldest first

  const off = () => !live && (!st.alive_at || Date.now() - new Date(st.alive_at).getTime() > 3 * 60e3);
  const shown = () => (off() ? 'off' : st.muted ? 'muted' : st.state);

  const WAVES = `<div class="jv-waves" aria-hidden="true">
      <div class="jv-wv jv-wv-mic"><span class="jv-wl">You</span><div class="jv-wc"><canvas data-wave="mic"></canvas></div></div>
      <div class="jv-wv jv-wv-tts"><span class="jv-wl">Jarvis</span><div class="jv-wc"><canvas data-wave="tts"></canvas></div></div>
    </div>`;
  function headHtml(s) {
    return `<i class="jv-dot" aria-hidden="true"></i><span class="jv-state">${esc(LABEL[s] || s)}</span>${st.conversation ? '<span class="jv-mode">conversation</span>' : ''}`;
  }
  function talkHtml(s) {
    const you = st.heard ? `<p class="jv-you${st.heard_final ? '' : ' draft'}"><span class="jv-who">You</span>${esc(st.heard)}</p>` : '';
    const words = replyWords();
    const body = s === 'speaking' ? words.map((w, i) => `<span class="jv-w" data-w="${i}">${esc(w)}</span>`).join(' ') : esc(st.reply);
    const him = st.reply ? `<p class="jv-him"><span class="jv-who">Jarvis</span>${body}</p>` : '';
    return `${you}${him}${!you && !him ? '<p class="jv-empty">Say “hey Jarvis”.</p>' : ''}`;
  }
  function inner() {
    const s = shown();
    return `<div class="jv-head">${headHtml(s)}</div>${WAVES}<div class="jv-talk" aria-live="polite">${talkHtml(s)}</div>`;
  }
  // the widget as a layout piece; size 's' keeps just the state line
  function render(filter, size) {
    if (live) ensureLoop();
    return `<section class="float jv jv-${shown()}${size === 's' ? ' jv-small' : ''}${live ? ' jv-live' : ''}" data-jv>${inner()}</section>`;
  }
  // repaint every Jarvis widget on the page (and the floating panel) without a full render; the canvases stay put
  function paint() {
    const s = shown();
    for (const el of document.querySelectorAll('[data-jv]')) {
      el.className = el.className.replace(/\bjv-(starting|idle|listening|thinking|speaking|error|muted|off)\b/g, '').replace(/\s+/g, ' ').trim() + ` jv-${s}`;
      el.classList.toggle('jv-live', live); // the waveforms show only while the stream is connected
      const head = el.querySelector(':scope > .jv-head'), talk = el.querySelector(':scope > .jv-talk');
      if (head && talk && el.querySelector(':scope > .jv-waves')) { head.innerHTML = headHtml(s); talk.innerHTML = talkHtml(s); }
      else el.innerHTML = inner();
      el._jvk = null;
      const t = el.querySelector('.jv-talk'); if (t) t.scrollTop = t.scrollHeight;
    }
    highlight();
    if (live) ensureLoop();
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
  // stream messages come many a second: one repaint per frame at most
  let pending = 0;
  const soon = () => { if (!pending) pending = requestAnimationFrame(() => { pending = 0; paint(); }); };

  /* ---------- the word being spoken ---------- */
  const norm = w => String(w || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  function replyWords() { return st.reply ? String(st.reply).split(/\s+/).filter(Boolean) : []; }

  // without the stream: estimated from time since speech began (each word by its length, pauses after punctuation)
  let speakAt = 0, lastTurn = null, hl = null;
  function estimate(spans) {
    const t = (Date.now() - speakAt) / 1000 - 0.3;
    let acc = 0, n = 0;
    for (let i = 0; i < spans.length; i++) {
      const w = spans[i].textContent;
      acc += 0.12 + w.replace(/[^\w]/g, '').length * 0.062 + (/[.!?]$/.test(w) ? 0.4 : /[,;:]$/.test(w) ? 0.2 : 0);
      n = i;
      if (t < acc) break;
    }
    return n;
  }
  function estTimer() {
    if (!live && shown() === 'speaking') { if (!hl) hl = setInterval(highlight, 100); }
    else if (hl) { clearInterval(hl); hl = null; }
  }

  // with the stream: each sentence arrives (speech) with its words' timings, and each word as it's spoken (word).
  // A sentence is found in the reply's words from where the last one ended, and its spoken words are matched to them.
  let sp = null, spFrom = 0, spokenTo = 0;
  function resetSpeech() { sp = null; spFrom = 0; spokenTo = 0; }
  function place(s) {
    const rw = replyWords().map(norm);
    const tn = s.text.split(/\s+/).filter(Boolean).map(norm);
    s.len = tn.length;
    const firstK = tn.map((x, i) => i).filter(i => tn[i]).slice(0, 3);
    let base = -1;
    if (firstK.length) {
      for (let k = s.from; k < rw.length && base < 0; k++) if (firstK.every(i => rw[k + i] === tn[i])) base = k;
      if (base < 0) for (let k = s.from; k < Math.min(rw.length, s.from + 12); k++) if (rw[k] && rw[k] === tn[firstK[0]]) { base = k; break; }
    }
    if (base < 0) base = Math.max(0, Math.min(s.from, rw.length - 1));
    const end = Math.min(rw.length, base + Math.max(1, s.len || s.words.length));
    const clampJ = j => Math.max(base, Math.min(j, end - 1));
    const al = []; let j = base, rest = null, hits = 0;
    for (const wd of s.words) {
      const nw = norm(wd.w);
      if (!nw) { al.push(clampJ(j)); continue; }
      if (rest && rest.startsWith(nw)) { // a reply word the voice said in pieces (twenty-five)
        al.push(j); hits++; rest = rest.slice(nw.length); if (!rest) { j++; rest = null; } continue;
      }
      if (rest !== null) { j++; rest = null; }
      const lim = Math.min(end, j + 4);
      let f = -1;
      for (let k = j; k < lim; k++) if (rw[k] === nw) { f = k; break; }
      if (f < 0) for (let k = j; k < lim; k++) { const r = rw[k]; if (r && (r.startsWith(nw) || nw.startsWith(r))) { f = k; break; } }
      if (f < 0) { al.push(clampJ(j)); continue; }
      hits++; al.push(f);
      const r = rw[f];
      if (r.length > nw.length && r.startsWith(nw)) { j = f; rest = r.slice(nw.length); } else { j = f + 1; rest = null; }
    }
    s.base = base; s.end = base + Math.max(1, s.len || s.words.length); s.align = al; s.hits = hits;
  }
  function curIdx(s) {
    let i = s.i;
    const t = Date.now() - s.start;
    for (let k = Math.max(0, i + 1); k < s.words.length; k++) { if ((Number(s.words[k].s) || 0) <= t) i = k; else break; }
    return i >= 0 && i < s.align.length ? s.align[i] : -1;
  }
  function exactPos() {
    if (!sp || sp.ended) return { now: -1, said: spokenTo };
    const idx = curIdx(sp);
    return { now: idx, said: idx >= 0 ? idx : sp.base };
  }
  function onSpeech(m) {
    const now = Date.now();
    let start = Number(m.start); if (!isFinite(start) || Math.abs(start - now) > 10000) start = now;
    const dur = Math.max(0, Number(m.dur) || 0);
    let words = Array.isArray(m.words) ? m.words.filter(x => x && x.w != null) : [];
    let text = String(m.text || '') || words.map(x => x.w).join(' ');
    if (!words.length && text) { const tt = text.split(/\s+/).filter(Boolean); words = tt.map((w, k) => ({ w, s: dur * k / tt.length, e: dur * (k + 1) / tt.length })); }
    if (sp && !sp.ended) spFrom = Math.max(spFrom, sp.end || 0); // the last sentence never said it ended
    sp = { id: m.id, start, dur, text, words, i: -1, from: spFrom, ended: false, stopped: false, align: [], base: spFrom, end: spFrom };
    place(sp);
  }
  function onSpeechEnd(m) {
    if (!sp || sp.id !== m.id || sp.ended) return;
    const idx = curIdx(sp);
    sp.ended = true; sp.stopped = !!m.stopped;
    const next = Math.max(sp.base + 1, sp.end || 0);
    spokenTo = sp.stopped ? (idx >= 0 ? idx + 1 : sp.base) : next;
    spFrom = sp.stopped ? spokenTo : next;
  }
  function setReply(text) {
    const old = String(st.reply || '');
    if (old && !text.startsWith(old.slice(0, 24))) resetSpeech(); // a new reply
    st.reply = text;
    if (sp && !sp.ended) place(sp);
  }

  function highlight() {
    const pos = live ? exactPos() : null;
    for (const el of document.querySelectorAll('[data-jv]')) {
      const spans = el.querySelectorAll('.jv-w');
      if (!spans.length) continue;
      let p = pos;
      if (!p) { if (!speakAt) continue; const n = estimate(spans); p = { now: n, said: n }; }
      const key = `${p.now}:${p.said}:${spans.length}`;
      if (el._jvk === key) continue;
      el._jvk = key;
      spans.forEach((w, i) => { w.classList.toggle('said', i < p.said); w.classList.toggle('now', i === p.now); });
    }
  }

  /* ---------- the waveforms ---------- */
  function amp(l) { // RMS to height, on a decibel scale: -54 dB is flat, -6 dB is full
    l = Number(l) || 0;
    if (l <= 0.0005) return 0;
    return Math.max(0, Math.min(1, (20 * Math.log10(l) + 54) / 48));
  }
  function push(kind, m) {
    const lv = Array.isArray(m.levels) ? m.levels : [];
    if (!lv.length) return;
    const now = Date.now();
    let at = Number(m.at);
    if (!isFinite(at) || Math.abs(at - now) > 5000) at = now - lv.length * levelMs;
    const buf = waves[kind];
    for (let k = 0; k < lv.length; k++) buf.push({ t: at + k * levelMs, l: Number(lv[k]) || 0 });
    const cut = now - WINDOW - 2000;
    let n = 0; while (n < buf.length && buf[n].t < cut) n++;
    if (n) buf.splice(0, n);
    if (buf.length > 1500) buf.splice(0, buf.length - 1500);
    ensureLoop();
  }
  function peak(buf, since, until) {
    let p = 0;
    for (let k = buf.length - 1; k >= 0 && buf[k].t >= since; k--) if (buf[k].t <= until) p = Math.max(p, amp(buf[k].l));
    return p;
  }
  const recent = () => { const edge = Date.now() - DELAY - WINDOW; return ['mic', 'tts'].some(k => { const b = waves[k]; return b.length && b[b.length - 1].t > edge; }); };
  const colours = new WeakMap();
  function drawWaves() {
    const now = Date.now(), right = now - DELAY, left = right - WINDOW;
    const hot = { mic: peak(waves.mic, right - 300, right), tts: peak(waves.tts, right - 300, right) };
    for (const c of document.querySelectorAll('[data-jv] canvas[data-wave]')) {
      const kind = c.dataset.wave, buf = waves[kind] || [];
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) continue;
      const dpr = Math.min(3, window.devicePixelRatio || 1), W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const g = c.getContext('2d');
      if (!g) continue;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const row = c.closest('.jv-wv'); if (row) row.classList.toggle('on', (hot[kind] || 0) > 0.12);
      let col = colours.get(c); if (!col) { col = getComputedStyle(c).color || '#8b929c'; colours.set(c, col); }
      g.fillStyle = col;
      const mid = h / 2, span = mid - 1, bw = Math.max(1, w * levelMs / WINDOW + 0.4);
      for (let k = buf.length - 1; k >= 0; k--) {
        const p = buf[k];
        if (p.t > right) continue;
        if (p.t < left) break;
        const a = amp(p.l) * span;
        if (a < 0.5) continue; // silence stays on the flat line
        const x = (p.t - left) / WINDOW * w;
        g.globalAlpha = 0.3 + 0.7 * (x / w); // older levels fade as they scroll left
        g.fillRect(x, mid - a, bw, a * 2);
      }
      g.globalAlpha = 1;
    }
  }
  // one animation loop: scrolls the waveforms and moves the highlight; runs while the stream is up (and until the
  // last levels have scrolled away after it drops)
  let raf = 0;
  function ensureLoop() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    drawWaves();
    if (live) highlight();
    if (live || recent()) ensureLoop();
  }

  /* ---------- connecting ---------- */
  function connect() {
    clearTimeout(retry); retry = null;
    if (!want || !desktop || ws || typeof WebSocket === 'undefined') return;
    let s;
    try { s = new WebSocket(url); } catch (e) { later(); return; }
    ws = s;
    s.onmessage = e => { if (ws !== s) return; let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (m && typeof m === 'object') onMsg(m); };
    s.onerror = () => {}; // close follows; retrying is quiet
    s.onclose = () => { if (ws !== s) return; ws = null; drop(); later(); };
  }
  function later() {
    if (!want || retry) return;
    backoff = Math.min(60000, backoff ? backoff * 2 : 2000);
    retry = setTimeout(() => { retry = null; connect(); }, backoff + Math.random() * 500);
  }
  function hangUp() {
    clearTimeout(retry); retry = null;
    const s = ws; ws = null;
    if (s) { try { s.close(); } catch (e) {} }
    drop();
  }
  // the stream went away: back to the jarvis_live row
  function drop() {
    if (!live) return;
    live = false;
    resetSpeech();
    load();
    estTimer();
    soon();
    ensureLoop(); // lets the last levels scroll off, then stops
  }
  // from the 'jarvis' command's args.stream: an address connects (or reconnects there); '' disconnects
  function stream(addr) {
    addr = String(addr == null ? '' : addr).trim();
    if (!addr) { userOff = true; want = false; hangUp(); return 'disconnected from the Jarvis stream'; }
    if (!desktop) return 'the live stream is PC-only; this screen stays on realtime';
    if (!/^wss?:\/\//i.test(addr)) return `${addr} isn't a stream address`;
    userOff = false; want = true; backoff = 0;
    if (addr !== url) {
      url = addr;
      try { localStorage.setItem('pos.jvStream', addr); } catch (e) {}
      if (ws) hangUp();
    }
    if (ws) return live ? 'already connected to the Jarvis stream' : 'connecting to the Jarvis stream';
    connect();
    return 'connecting to the Jarvis stream';
  }
  function onMsg(m) {
    if (!live) { live = true; backoff = 0; estTimer(); soon(); }
    switch (m.t) {
      case 'hello':
        levelMs = Number(m.level_ms) > 0 ? Number(m.level_ms) : 20;
        if (m.state) st.state = String(m.state);
        st.muted = !!m.muted; st.conversation = !!m.conversation;
        st.heard = String(m.heard || ''); st.heard_final = !!m.heard_final;
        resetSpeech(); st.reply = String(m.reply || '');
        estTimer(); soon(); ensureLoop();
        break;
      case 'state':
        if (m.state) st.state = String(m.state);
        if (st.state === 'thinking') resetSpeech();
        soon(); break;
      case 'muted': st.muted = !!m.muted; soon(); break;
      case 'conversation': st.conversation = !!m.conversation; soon(); break;
      case 'clear': st.heard = ''; st.heard_final = false; st.reply = ''; resetSpeech(); soon(); break;
      case 'partial': st.heard = String(m.text || ''); st.heard_final = false; soon(); break;
      case 'heard': st.heard = String(m.text || ''); st.heard_final = true; resetSpeech(); soon(); break;
      case 'reply': setReply(String(m.text || '')); soon(); break;
      case 'mic': push('mic', m); break;
      case 'tts': push('tts', m); break;
      case 'speech': onSpeech(m); ensureLoop(); break;
      case 'word': if (sp && sp.id === m.id && !sp.ended) sp.i = Math.max(sp.i, Math.min(sp.words.length - 1, Number(m.i) || 0)); break;
      case 'speech_end': onSpeechEnd(m); break;
    }
  }

  /* ---------- the jarvis_live row (used whenever the stream isn't connected) ---------- */
  function apply(row) {
    if (!row) return;
    if (live) { // the stream has the fresher word; keep just the heartbeat
      if (row.alive_at) st.alive_at = row.alive_at;
      if (row.turn != null) st.turn = row.turn;
      return;
    }
    const was = shown();
    st = { ...st, ...row };
    if (shown() === 'speaking' && (was !== 'speaking' || st.turn !== lastTurn)) speakAt = Date.now();
    lastTurn = st.turn;
    estTimer();
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
    if (desktop && !userOff) { want = true; if (!ws) connect(); } // on a desktop, try his stream straight away
  }
  function stop() {
    if (channel && sb) sb.removeChannel(channel);
    channel = null; clearInterval(tick); tick = null;
    want = false; hangUp();
    close();
  }

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

  const streaming = () => live;
  return { start, stop, open, close, stream, streaming, widget: { label: 'Jarvis', render } };
};
