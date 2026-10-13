// POS assistant: tap the creature on Home and talk. It hears you (the browser turns speech into text), moves with your
// voice, answers out loud and on screen, and does things in POS for you. A few set phrases work for free on their own
// (open a section, what's today, operate a camera); everything else goes to Claude through the assistant edge function,
// which holds the key. Anything that changes your data is shown first and only happens when you say so.
window.POSAssistant = function (ctx) {
  const { esc, toast } = ctx;
  const $ = s => document.querySelector(s);
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

  // T: this conversation. K: the key's status on the server (never the key itself).
  const T = { phase: 'idle', said: '', reply: '', act: null, typed: false, note: '', rec: null, closeT: 0 };
  const K = { known: false, key: false, setAt: null, days: null, model: null, today: 0, month: 0, cap: 300, at: 0 };
  const speakOn = () => get('pos.as.speak') !== '0';
  const redraw = () => { ctx.rerender(); paintFloat(); };

  /* ---------- talking to the assistant function ---------- */
  async function call(body) {
    const { data, error } = await ctx.sb.functions.invoke('assistant', { body });
    if (error) { let msg = ''; try { msg = (await error.context.json()).error; } catch (e) { /* no detail */ } throw new Error(msg || 'POS could not reach the assistant.'); }
    return data || {};
  }
  let retry = 0;
  async function status(force) {
    if (!ctx.canSave()) { clearTimeout(retry); retry = setTimeout(() => status(force), 2500); return K; } // still connecting
    if (!force && K.known && Date.now() - K.at < 6 * 36e5) return K;
    try { Object.assign(K, await call({ action: 'status' }), { known: true, at: Date.now() }); redraw(); fillSettings(); } catch (e) { /* try again later */ }
    return K;
  }
  // days left on a key that expires; null for one that doesn't
  const daysLeft = () => (K.key && K.days && K.setAt ? Math.ceil((K.setAt + K.days * 864e5 - Date.now()) / 864e5) : null);
  const keyWarn = () => { const d = daysLeft(); return d != null && d <= 3 ? d : null; };

  /* ---------- the voice level the creature moves with ---------- */
  const L = { v: 0, stream: null, ac: null, an: null, buf: null, bump: 0 };
  async function meterOn() {
    if (IOS || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return; // iPhone and iPad: one thing on the mic at a time
    try {
      L.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      L.ac = new (window.AudioContext || window.webkitAudioContext)();
      L.an = L.ac.createAnalyser(); L.an.fftSize = 512; L.buf = new Uint8Array(L.an.fftSize);
      L.ac.createMediaStreamSource(L.stream).connect(L.an);
    } catch (e) { meterOff(); }
  }
  function meterOff() {
    if (L.stream) for (const t of L.stream.getTracks()) t.stop();
    if (L.ac) L.ac.close().catch(() => {});
    L.stream = L.ac = L.an = null;
  }
  // 0 to 1: your voice while it listens, a talking rhythm while it speaks
  function level() {
    let want = 0;
    if (T.phase === 'listen' || (X.on && !X.paused)) {
      if (L.an) {
        L.an.getByteTimeDomainData(L.buf);
        let s = 0; for (let i = 0; i < L.buf.length; i++) { const x = (L.buf[i] - 128) / 128; s += x * x; }
        want = Math.min(1, Math.sqrt(s / L.buf.length) * 5.5);
      } else want = 0.12 + L.bump * 0.6;
    } else if (ctx.voice && ctx.voice.speaking()) {
      want = Math.min(1, ctx.voice.level() * 1.3);
    } else if (window.speechSynthesis && speechSynthesis.speaking) {
      const t = performance.now() / 1000;
      want = 0.25 + 0.3 * Math.abs(Math.sin(t * 7.3) * Math.sin(t * 2.9)) + L.bump * 0.3;
    } else if (T.phase === 'think') want = 0.15 + 0.1 * Math.sin(performance.now() / 180);
    L.bump *= 0.86;
    L.v += (want - L.v) * (want > L.v ? 0.45 : 0.12);
    return L.v;
  }

  /* ---------- speaking back ---------- */
  // its voice: a low male voice, a little slower and deeper than the device's default. Each device has its own set
  // of voices (Edge's natural voices are the best; Chrome and Safari have fewer), so the pick is per device.
  const MALE = [/Andrew.*Natural/i, /Guy.*Natural/i, /Davis.*Natural/i, /Christopher.*Natural/i, /Brian.*Natural/i, /Eric.*Natural/i, /Roger.*Natural/i, /Steffan.*Natural/i, /Ryan.*Natural/i,
    /Google UK English Male/i, /\bDaniel\b/i, /\bArthur\b/i, /\bAaron\b/i, /\bEvan\b/i, /\bNathan\b/i, /\bTom\b/i, /\bAlex\b/i, /Microsoft (Guy|Mark|David|Andrew|Brian|Davis)/i, /\bRocko\b/i, /\bFred\b/i, /\bRalph\b/i, /\bReed\b/i, /\b(male|man)\b/i];
  const FEMALE = /Samantha|Ava|Allison|Susan|Zira|Aria|Jenny|Emma|Michelle|Sonia|Libby|Karen|Moira|Tessa|Victoria|Fiona|Kate|Serena|Nicky|Google US English|female/i;
  const englishVoices = () => (window.speechSynthesis ? speechSynthesis.getVoices().filter(v => /^en(-|_)/i.test(v.lang)) : []);
  function rankedVoices() {
    const vs = englishVoices(), score = v => { const i = MALE.findIndex(re => re.test(v.name)); return i >= 0 ? i : FEMALE.test(v.name) ? 900 : 500; };
    return vs.slice().sort((a, b) => score(a) - score(b) || (/en.US/i.test(b.lang) - /en.US/i.test(a.lang)));
  }
  let voice = null;
  function pickVoice() {
    if (voice || !window.speechSynthesis) return voice;
    const want = get('pos.as.voice'), vs = englishVoices();
    voice = (want && vs.find(v => v.name === want)) || rankedVoices()[0] || null;
    return voice;
  }
  const pitchNow = () => { const p = parseFloat(get('pos.as.pitch')); return p > 0 ? p : 0.82; };
  if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => { voice = null; pickVoice(); fillVoices(); };
  // ears off while it talks (in a session), back on after
  // ears off while it talks (in a session): the mic is let go completely, and picked up again after
  const earsOff = () => { if (X.on) { X.paused = true; if (X.rec) try { X.rec.abort(); } catch (e) {} meterOff(); } };
  const earsOn = () => { if (X.on) { X.paused = false; meterOn().finally(() => setTimeout(sessionListen, 150)); } };
  // POS speaks in its own voice. If that voice is still loading on this device, it waits for it (up to 15 s) rather than
  // switching to the device's voice; the device's voice is only for when the POS voice can't load here.
  let speakGen = 0, toldDevice = false;
  function speak(text, force, done) {
    const fin = () => { if (done) try { done(); } catch (e) {} };
    if (!text || (!speakOn() && !force)) { fin(); return; }
    const V = ctx.voice, my = ++speakGen;
    if (V && V.active()) {
      if (V.ready()) { posSay(text, fin); return; }
      const w = V.warm();
      if (w) {
        Promise.race([w, new Promise(r => setTimeout(r, 15000))]).then(() => {
          if (my !== speakGen) return;
          if (V.ready()) posSay(text, fin); else { deviceNote(); deviceSpeak(text, fin); }
        });
        return;
      }
      deviceNote();
    }
    deviceSpeak(text, fin);
  }
  function posSay(text, fin) {
    const V = ctx.voice;
    if (window.speechSynthesis) speechSynthesis.cancel();
    earsOff();
    // the mic is closed first and the voice starts a beat later, so nothing on the way out is in "call" mode
    setTimeout(() => V.say(text, undefined, { onend: () => { earsOn(); if (fin) fin(); } }).catch(() => { earsOn(); deviceSpeak(text, fin); }), X.on ? 250 : 0);
  }
  function deviceNote() {
    if (toldDevice) return;
    toldDevice = true;
    toast("Your POS voice isn't on this device yet, so it's using the device's voice. Open the Voice Lab here once to load it.");
  }
  function deviceSpeak(text, fin) {
    if (!window.speechSynthesis) { if (fin) fin(); return; }
    if (ctx.voice) ctx.voice.stop();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.97; u.pitch = pitchNow(); const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; }
    u.onboundary = () => { L.bump = 1; };
    if (X.on) earsOff();
    let once = false;
    u.onend = u.onerror = () => { if (once) return; once = true; earsOn(); if (fin) fin(); };
    speechSynthesis.speak(u);
  }
  // iPhone and iPad only let a page speak after a tap: a silent word during the tap unlocks it for the reply later
  function unlockSpeech() {
    if (ctx.voice) ctx.voice.unlock();
    if (!window.speechSynthesis || !speakOn()) return;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) {}
  }

  /* ---------- the free set phrases ---------- */
  // the words for each section; a set phrase has to be one of these, nothing more, or it goes to Claude
  const ALIAS = { tasks: ['tasks', 'task', 'to dos', 'todos', 'to do list', 'task list'], calendar: ['calendar', 'schedule'], notes: ['notes', 'note'],
    reminders: ['reminders', 'reminder'], projects: ['projects', 'project'], meetings: ['meetings', 'meeting'], audio: ['audio'], video: ['video', 'broadcast', 'cameras'],
    lighting: ['lighting'], work: ['work', 'work overview'], finance: ['finance', 'finances', 'money', 'bills', 'budget', 'spending', 'banking'],
    health: ['health', 'sleep', 'gym'], car: ['car', 'truck'], places: ['places', 'map'], packages: ['packages', 'package', 'deliveries', 'shipping'], pets: ['pets', 'pet'],
    lights: ['lights', 'home lights'], tv: ['tv', 'television', 'remote', 'tv remote'], camplot: ['cam plot', 'camera plot', 'camplot', '3d cam plot', '3d camera plot'],
    settings: ['settings'], weather: ['weather', 'forecast'], home: ['home', 'home screen'], today: ['today', 'my day', 'agenda', 'today\'s agenda'] };
  const NUM = { one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6 };
  const sectionIs = x => { x = x.replace(/^(the|my) /, '').replace(/ (section|page|tab|view|screen)$/, '').trim(); for (const k in ALIAS) if (ALIAS[k].includes(x)) return k; return null; };
  function local(raw) {
    // "hey POS, can you open my tasks please" → "open my tasks"
    const nm = String(ctx.name() || 'pos').toLowerCase();
    const s = raw.toLowerCase().replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim()
      .replace(new RegExp(`^(?:(?:hey|hi|ok|okay|yo)\\s+)?(?:${nm.replace(/[^a-z0-9 ]/g, '')}|pos|p o s)?\\s*`), '')
      .replace(/^(?:can you|could you|would you|will you|please|go ahead and|i want to|i'd like to|let me)\s+/, '').replace(/^please\s+/, '')
      .replace(/\s+(?:please|for me|real quick|now)$/, '').trim();
    if (/^(stop|cancel|never ?mind|nothing|forget it)$/.test(s)) return { reply: 'Okay.', act: { action: 'close' } };
    if (/^(?:start|begin|open|let's start|turn on) (?:a |the |my )?(?:talking |work |build )?session$/.test(s)) return { reply: '', act: { action: 'session' } };
    if (/^(?:end|stop|close|finish|turn off) (?:the |this |my )?session$/.test(s)) return { reply: '', act: { action: 'session-end' } };
    const home = homeLocal(s);
    if (home) return home;
    // the weather: answered here from the forecast POS already has, with the weather panel pulled up beside it
    if (ctx.wxSay && /^(?:what(?:'s| is) (?:the )?(?:weather|forecast)(?: like)?(?: .*)?|how(?:'s| is) (?:the )?weather(?: .*)?|(?:the )?weather(?: today| now| outside)?|forecast|what(?:'s| is) it like (?:out(?:side)?|today|out there|right now)|how (?:hot|cold|warm|chilly) is it(?: .*)?|is it (?:hot|cold|warm|chilly|nice) (?:out|outside)(?: .*)?|what (?:should|do|can) i wear(?: .*)?|what to wear(?: .*)?|do i need (?:a |an )?(?:jacket|coat|umbrella|hoodie|sweater|layer|rain ?coat)(?: .*)?|is it (?:going to|gonna|supposed to) rain(?: .*)?|will it rain(?: .*)?|(?:show|open|pull up|bring up|check)(?: me)? (?:the )?(?:weather|forecast)(?: .*)?)$/.test(s)) {
      const kind = /rain|umbrella/.test(s) ? 'rain' : /wear|jacket|coat|hoodie|sweater|layer/.test(s) ? 'wear' : 'now';
      return { reply: ctx.wxSay(kind, /\btomorrow\b/.test(s)), act: { action: 'open', section: 'weather' } };
    }
    let m = s.match(/^(?:(?:operate|run|use|open|show|go to|pull up)\s+)?cam(?:era)?\s*(\d|one|two|to|too|three|four|for|five|six)$/);
    if (m) { const n = +m[1] || NUM[m[1]]; return { reply: `Camera ${n}.`, act: { action: 'camera', camera: n } }; }
    m = s.match(/^(?:open|show(?: me)?|go to|take me to|pull up|bring up|switch to)\s+(?:the |my )?(.+)$/);
    if (m) { const k = sectionIs(m[1]); if (k) return { reply: '', act: { action: 'open', section: k } }; }
    { const k = sectionIs(s); if (k) return { reply: '', act: { action: 'open', section: k } }; }
    if (/^full ?screen$/.test(s)) return { reply: '', act: { action: 'fullscreen' } };
    if (/^(?:what(?:'s| is)?|whats) (?:(?:due|on|happening|left|going on) )*(?:for )?today|^show (?:me )?today|^(?:what(?:'s| is)? )?my day|^how(?:'s| is) (?:my )?today/.test(s)) return { reply: ctx.dayText(0), act: { action: 'open', section: 'today' } };
    if (/^(?:what(?:'s| is)?|whats) (?:(?:due|on|happening) )*(?:for )?tomorrow|^show (?:me )?tomorrow/.test(s)) return { reply: ctx.dayText(1), act: { action: 'none' } };
    return null;
  }

  // lights and the TV, said plainly: "turn off the lights", "lamps on", "desk lights to 30", "lights warm", "tv off", "volume 20",
  // "mute", "put on netflix". Anything fancier goes to Claude.
  const TONE = { red: 1000, 'deep red': 1000, amber: 1500, candle: 2000, candlelight: 2000, 'candle light': 2000, warm: 2700, 'warm white': 2700, neutral: 4000, white: 4000, cool: 5000, 'cool white': 5000, daylight: 6500 };
  const APPS = /^(youtube|netflix|crunchyroll|prime video|amazon prime|amazon|hulu|spotify|disney plus|disney\+|disney|apple tv|hbo max|hbo|max)$/;
  const TVW = '(?:the )?(?:tv|television|telly)';
  const lightish = t => /\b(lights?|lamps?|uplights?|bedroom|room)\b/.test(t) || (ctx.isLight && ctx.isLight(t));
  function homeLocal(s) {
    let m;
    // the TV
    if ((m = s.match(new RegExp(`^(?:turn|switch|power|shut) (on|off) ${TVW}$`))) || (m = s.match(new RegExp(`^(?:turn|switch|power|shut) ${TVW} (on|off)$`))) || (m = s.match(new RegExp(`^${TVW} (on|off)$`))))
      return { reply: '', act: { action: 'tv', command: m[1] === 'on' ? 'power_on' : 'power_off' } };
    if ((m = s.match(new RegExp(`^(mute|unmute)(?: ${TVW}| it| the sound)?$`)))) return { reply: '', act: { action: 'tv', command: m[1] } };
    if ((m = s.match(new RegExp(`^(?:set )?(?:${TVW} )?(?:the )?volume (?:to |at )?(\\d{1,3})(?: percent| ?%)?$`)))) return { reply: '', act: { action: 'tv', command: 'volume_set', level: +m[1] } };
    if ((m = s.match(new RegExp(`^(?:turn ${TVW} (up|down)|turn (?:the )?volume (up|down)|(?:${TVW} )?volume (up|down)|turn it (up|down) on ${TVW})$`)))) { const d = m[1] || m[2] || m[3] || m[4]; return { reply: '', act: { action: 'tv', command: d === 'up' ? 'volume_up' : 'volume_down' } }; }
    if ((m = s.match(new RegExp(`^(pause|play|resume)(?: ${TVW}| it| the show| the movie| the video)?$`)))) return { reply: '', act: { action: 'tv', command: m[1] === 'pause' ? 'pause' : 'play' } };
    if ((m = s.match(new RegExp(`^(?:open|put on|launch|start|pull up|go to|play|switch to) (.+?)(?: on ${TVW})?$`))) && APPS.test(m[1])) return { reply: '', act: { action: 'tv', command: 'open_app', app: m[1] } };
    // the lights
    if (/^(?:kill|cut) the lights$|^lights out$/.test(s)) return { reply: '', act: { action: 'lights', target: 'all', power: 'off' } };
    if ((m = s.match(/^(?:turn|switch|flip|shut|cut) (on|off) (?:the |my |all (?:the |of the )?)?(.+)$/)) && lightish(m[2])) return { reply: '', act: { action: 'lights', target: m[2], power: m[1] } };
    if ((m = s.match(/^(?:turn|switch|flip|shut|cut) (?:the |my |all (?:the |of the )?)?(.+?) (on|off)$/)) && lightish(m[1])) return { reply: '', act: { action: 'lights', target: m[1], power: m[2] } };
    if ((m = s.match(/^(?:the |my |all (?:the )?)?(.+?) (on|off)$/)) && lightish(m[1])) return { reply: '', act: { action: 'lights', target: m[1], power: m[2] } };
    if ((m = s.match(/^(?:dim|set|turn|put|bring|make) (?:the |my |all (?:the )?)?(.+?) (?:down |up )?(?:to |at )?(\d{1,3})(?: percent| ?%)?$/)) && lightish(m[1])) return { reply: '', act: { action: 'lights', target: m[1], level: Math.min(100, +m[2]), power: +m[2] > 0 ? 'on' : 'off' } };
    if ((m = s.match(/^(dim|brighten) (?:the |my |all (?:the )?)?(.+)$/)) && lightish(m[2])) return { reply: '', act: { action: 'lights', target: m[2], level: m[1] === 'dim' ? 25 : 100, power: 'on' } };
    if ((m = s.match(/^(?:make|set|turn) (?:the |my |all (?:the )?)?(.+?) (?:to )?(deep red|red|amber|candle ?light|candle|warm white|warm|neutral|white|cool white|cool|daylight)$/)) && lightish(m[1])) return { reply: '', act: { action: 'lights', target: m[1], kelvin: TONE[m[2]], power: 'on' } };
    return null;
  }

  /* ---------- one exchange ---------- */
  // After it answers or does something, it keeps listening for a minute, so "and make it due in 30 minutes" or
  // "now add call mom" works without its name. In a session anything said in that minute goes to it; on a computer
  // outside a session the panel listens again once it has finished talking. Closing the panel ends it.
  const WRITES = ['add_task', 'complete_task', 'move_task', 'add_reminder', 'add_note', 'build_note'];
  const FOLLOW = 60e3;
  function close() {
    stopListening(true);
    clearTimeout(T.closeT);
    Object.assign(T, { phase: 'idle', said: '', reply: '', act: null, note: '', follow: 0, following: false });
    redraw(); if (X.on) paintLive();
  }
  const later = (ms) => { clearTimeout(T.closeT); T.closeT = setTimeout(() => { if (T.phase === 'reply' && !(T.follow > Date.now() && !X.on && DESK && SR && !T.typed)) close(); }, ms); };
  const followOn = () => { T.follow = Date.now() + FOLLOW; if (X.on) paintLive(); };
  // once it has finished talking: the minute starts again, and outside a session it listens for the next thing
  function afterTalk() {
    if (!(T.follow > 0)) return;
    followOn();
    if (X.on || !DESK || !SR || T.typed || IOS) return;
    if (T.phase === 'reply' || T.phase === 'confirm') setTimeout(() => { if ((T.phase === 'reply' || T.phase === 'confirm') && !T.rec) startListening(true); }, 250);
  }
  // say it, show it, and keep the line open
  function answer(reply, ms) { show(reply, null); followOn(); speak(reply, false, afterTalk); later(ms); }
  const YES = /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|confirm|please do|sounds good)\b/, NO = /^(?:no|nope|cancel|don'?t|never ?mind|stop)\b/;
  // what's left of an answer once the yes or no (and "add it", "please", "to the task list") is taken off
  const restOf = s => s.replace(YES, '').replace(NO, '').replace(/^[\s,]+/, '')
    .replace(/^(?:(?:you can|please|go ahead and|and|then)\s+)*(?:add (?:it|that)|do (?:it|that)|save (?:it|that)|put (?:it|that) (?:in|on)|that'?s (?:fine|good|right)|thanks?(?: you)?)?(?:\s*(?:to|in|on) (?:the |my )?(?:task list|tasks|list|notes|reminders))?/, '').replace(/^[\s,.]+/, '').trim();
  async function handle(text) {
    text = String(text || '').trim();
    if (!text) { close(); return; }
    T.said = text;
    // waiting on a yes or no for a change (said, or typed)
    const answering = !!T.act && (T.phase === 'confirm' || T.prev === 'confirm');
    T.prev = null;
    let amend = null;
    if (answering) {
      const s = text.toLowerCase().replace(/[.!?]/g, '').trim(), yes = YES.test(s), no = NO.test(s), more = restOf(s).split(/\s+/).filter(w => w.length > 1).length >= 2;
      if (yes && !more) { doIt(); return; }
      if (no && !more) { answer('Okay, I left it.', 4000); T.act = null; return; }
      // a change along with the answer ("yes, and make it due in 30 minutes"): Claude reworks the waiting change
      amend = { pending: T.act, yes: yes || !no };
    }
    let r = amend ? null : local(text);
    if (!r) {
      T.phase = 'think'; redraw();
      try {
        const pending = amend ? Object.fromEntries(Object.entries(amend.pending).filter(([k, v]) => v != null && v !== '' && typeof v !== 'object')) : null;
        const d = await call({ action: 'ask', text, ctx: ctx.summary(), name: ctx.name(), ...(X.on ? { recent: recentText() } : {}), ...(pending ? { pending } : {}) });
        if (d.error) r = { reply: errText(d.error), act: { action: 'none' }, fail: d.error };
        else r = { reply: d.reply || '', act: d.act || { action: 'none' } };
        if (d.error === 'key' || d.error === 'no-key') status(true);
      } catch (e) { r = { reply: "I couldn't reach the assistant. Check the connection and try again.", act: { action: 'none' } }; }
    }
    const a = r.act || { action: 'none' };
    // in a session, talk that wasn't meant for it: nothing to say, nothing shown
    if (X.on && !amend && a.action === 'none' && !String(r.reply || '').trim()) { close(); return; }
    if (a.action === 'close') { close(); return; }
    if (a.action === 'session') { close(); startSession(); return; }
    if (a.action === 'session-end') { close(); endSession(); return; }
    // lights and the TV happen right away; what's said back is what actually happened
    if (a.action === 'lights' || a.action === 'tv') {
      T.phase = 'think'; redraw();
      let res;
      try { res = ctx.home ? await ctx.home(a) : null; } catch (e) { res = null; }
      const say = (res && res.say) || (a.action === 'tv' ? "The TV didn't answer." : "The lights didn't answer.");
      answer(say, res && res.ok ? 3000 : 6000);
      return;
    }
    if (WRITES.includes(a.action)) {
      const what = ctx.describe(a);
      if (!what) { if (amend) T.act = amend.pending; answer("I couldn't find that one. Try saying it another way.", 6000); return; }
      // he already said yes, and changed something: do the changed one
      if (amend && amend.yes && a.action === amend.pending.action) { T.act = a; T.note = what; doIt(); return; }
      T.phase = 'confirm'; T.act = a; T.reply = r.reply || (a.action === 'build_note' ? "That's a build change for Claude. Save it as a note?" : 'Do this?');
      T.note = what; redraw(); followOn(); speak(T.reply, false, afterTalk);
      return;
    }
    if (amend) { T.act = amend.pending; T.phase = 'confirm'; T.reply = r.reply || 'Do this?'; redraw(); followOn(); speak(T.reply, false, afterTalk); return; }
    // a list opens at the side of Home right away and the answer stays; anything else opens at once, the answer as a toast
    if (a.action === 'open' && ctx.stays && ctx.stays(a.section)) {
      ctx.go(a);
      if (r.reply) answer(r.reply, Math.max(4000, r.reply.length * 80));
      else { T.phase = 'reply'; T.reply = ''; followOn(); redraw(); afterTalk(); later(4000); }
      return;
    }
    if (a.action === 'open' || a.action === 'camera' || a.action === 'fullscreen') {
      if (r.reply) { toast(r.reply); speak(r.reply); }
      Object.assign(T, { phase: 'idle', said: '', reply: '', act: null }); ctx.go(a);
      if (X.on) followOn();
      return;
    }
    answer(r.reply, Math.max(6000, (r.reply || '').length * 90));
  }
  function show(reply, act) { T.phase = 'reply'; T.reply = reply || ''; T.act = act; redraw(); }
  async function doIt() {
    const a = T.act; if (!a) return;
    T.act = null;
    try { const done = await ctx.run(a); answer(done || 'Done.', 3500); }
    catch (e) { show(String(e && e.message || 'That did not save.'), null); later(3500); }
  }
  function errText(code) {
    return code === 'no-key' ? "I can open sections and tell you about today. Put the assistant key in Settings and I'll understand the rest."
      : code === 'key' ? 'The assistant key stopped working. Make a new one and paste it in Settings.'
      : code === 'credits' ? "The API credits are used up until the first of the month. I'll stick to the basics till then."
      : code === 'cap' ? "That's the most asks for one day. I'll be back tomorrow."
      : code === 'busy' ? 'Claude is busy right now. Try again in a moment.'
      : "Something went wrong asking Claude. Try again.";
  }

  /* ---------- listening ---------- */
  function startListening(again) {
    if (!again) {
      speakGen++;
      if (window.speechSynthesis) speechSynthesis.cancel();
      if (ctx.voice) ctx.voice.stop();
    }
    T.following = !!again;
    clearTimeout(T.closeT);
    const keepConfirm = T.phase === 'confirm' || (T.phase === 'listen' && T.prev === 'confirm' && !!T.act);
    T.said = ''; if (!keepConfirm && !again) { T.reply = ''; T.act = null; T.note = ''; }
    unlockSpeech();
    if (!SR || T.typed) { T.typed = true; T.phase = keepConfirm ? 'confirm' : 'listen'; redraw(); setTimeout(() => { const i = $('#asInput'); if (i) i.focus(); }, 30); return; }
    const rec = new SR();
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let heard = '', ended = false;
    rec.onresult = e => {
      heard = ''; for (const r of e.results) heard += r[0].transcript;
      T.said = heard; L.bump = 1;
      const el = $('#asSaid'); if (el) el.textContent = heard;
    };
    rec.onspeechstart = () => { L.bump = 1; };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') { T.typed = true; T.mic = 'blocked'; }
    };
    rec.onend = () => {
      if (ended) return; ended = true;
      T.rec = null; meterOff();
      if (T.mic === 'blocked' && !heard) { T.mic = ''; T.phase = 'listen'; redraw(); toast("The mic isn't available here. Type instead."); setTimeout(() => { const i = $('#asInput'); if (i) i.focus(); }, 30); return; }
      if (heard.trim()) handle(heard);
      else if (T.following && T.follow > Date.now() && T.phase === 'listen') setTimeout(() => { if (T.phase === 'listen' && !T.rec && T.follow > Date.now()) startListening(true); }, 200);
      else if (T.phase === 'listen') { if (T.prev === 'confirm' && T.act) { T.phase = 'confirm'; T.following = false; redraw(); } else close(); } else redraw();
    };
    T.rec = rec; T.prev = keepConfirm ? 'confirm' : null;
    T.phase = 'listen'; redraw();
    meterOn().finally(() => { try { rec.start(); } catch (e) { T.typed = true; redraw(); } });
  }
  function stopListening(drop) {
    if (T.rec) { const r = T.rec; if (drop) { r.onend = null; r.onresult = null; T.rec = null; } try { r.stop(); } catch (e) {} }
    meterOff();
  }

  /* ---------- on Home ---------- */
  const busy = () => T.phase !== 'idle';
  function panel() {
    if (T.phase === 'idle' || X.on) return '';
    return panelHtml();
  }
  function panelHtml() {
    if (T.phase === 'idle') return '';
    const lab = T.phase === 'listen' ? (T.typed ? 'Type it' : T.following ? 'Still listening' : 'Listening') : T.phase === 'think' ? 'Thinking' : T.phase === 'confirm' ? 'Check this' : ctx.name();
    const said = T.said ? `<p class="as-said" id="asSaid">${esc(T.said)}</p>` : T.phase === 'listen' && !T.typed ? `<p class="as-said as-hint" id="asSaid">${T.prev === 'confirm' && T.act ? 'Yes or no?' : T.following ? 'Anything else?' : 'Go ahead.'}</p>` : '';
    const reply = T.reply && T.phase !== 'think' && (T.phase !== 'listen' || T.following) ? `<p class="as-reply">${esc(T.reply)}</p>` : '';
    const confirm = (T.phase === 'confirm' || (T.phase === 'listen' && T.prev === 'confirm')) && T.act ? `<div class="as-confirm"><span class="as-what">${esc(T.note)}</span><div class="as-btns"><button type="button" class="btn" data-act="as-no">Cancel</button><button type="button" class="btn solid" data-act="as-yes">Do it</button></div></div>` : '';
    const typed = T.typed && (T.phase === 'listen' || T.phase === 'confirm') ? `<form class="as-type" id="asForm" autocomplete="off"><input id="asInput" type="text" enterkeyhint="send" placeholder="Ask or tell ${esc(ctx.name())}…" autocomplete="off" spellcheck="true"><button type="submit" class="btn solid">Send</button></form>` : '';
    const foot = T.phase === 'listen' && !T.typed ? '<button type="button" class="qh-link" data-act="as-type">Type instead</button>' : '';
    return `<div class="as-panel as-${T.phase}" role="status" aria-live="polite"><div class="as-head"><span class="as-lab">${esc(lab)}</span><button type="button" class="as-x" data-act="as-close" aria-label="Close">×</button></div>${said}${reply}${confirm}${typed}${foot}</div>`;
  }
  const holding = () => { const a = document.activeElement; return !!(a && a.id === 'asInput'); };
  function act(name, b, e) {
    if (name === 'as-sess') { if (X.on) endSession(); else startSession(); return; }
    if (name === 'as-wrap-add') { addWrapTasks(); return; }
    if (name === 'as-wrap-x') { W.tasks = null; paintWrap(); return; }
    if (name === 'as-talk') { if (T.phase === 'listen' && T.rec) { T.following = false; T.follow = 0; stopListening(false); return; } startListening(); return; }
    if (name === 'as-close') { close(); return; }
    if (name === 'as-type') { stopListening(true); T.typed = true; T.phase = 'listen'; redraw(); setTimeout(() => { const i = $('#asInput'); if (i) i.focus(); }, 30); return; }
    if (name === 'as-yes') { stopListening(true); doIt(); return; }
    if (name === 'as-no') { stopListening(true); T.act = null; show('Okay, I left it.', null); later(3000); return; }
  }
  document.addEventListener('change', e => { if (e.target && e.target.id === 'asVoice') { put('pos.as.voice', e.target.value || null); voice = null; speak(`${ctx.name()} online.`, true); } });
  document.addEventListener('submit', e => {
    if (e.target.id === 'asForm') {
      e.preventDefault();
      const v = $('#asInput').value; $('#asInput').blur();
      if (v.trim()) handle(v);
    }
    if (e.target.id === 'asKeyForm') { e.preventDefault(); saveKey(); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && busy() && !document.querySelector('dialog[open]')) { e.stopPropagation(); close(); } }, true);

  /* ---------- sessions, on computers: it listens the whole time and keeps a log, but only answers when you say its
     name. "Capture this" keeps the last thing you said. Ending it (or 10 minutes of quiet) saves the log and a
     wrap-up note: the ideas, the to-dos to confirm, and changes for Claude to build, pinned in Notes. ---------- */
  const DESK = !IOS && !!(window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches);
  const canSession = () => DESK && !!SR;
  const X = { on: false, rec: null, log: [], startAt: 0, lastHeard: 0, id: null, live: '', paused: false, tick: 0, saveT: 0, dirty: false, saved: false, waitCmd: 0 };
  const W = { tasks: null };
  const QUIET_END = 10 * 60e3;
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const recentText = () => X.log.filter(l => !l.cap && Date.now() - l.at < 120e3).slice(-8).map(l => l.text).join('\n');
  async function startSession() {
    if (!canSession()) { toast('Sessions run on a computer, in Chrome or Edge.'); return; }
    if (X.on || !ctx.canSave()) return;
    close();
    Object.assign(X, { on: true, log: [], startAt: Date.now(), lastHeard: Date.now(), id: 'session-' + uuid(), live: '', paused: false, dirty: true, saved: false, waitCmd: 0 });
    await meterOn();
    sessionListen();
    X.tick = setInterval(sessionTick, 1000);
    paintLive(); redraw(); saveSession();
    speak(`Session on. Say ${ctx.name()} when you need me.`);
  }
  function sessionListen() {
    if (!X.on || X.rec || X.paused) return;
    const rec = new SR();
    rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) heard(String(r[0].transcript || '').trim()); else interim += r[0].transcript;
      }
      X.live = interim.trim(); L.bump = 1; paintLive();
    };
    rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') { toast("The mic isn't allowed for POS here. Allow it in the browser's address bar, then start again."); endSession(true); } };
    rec.onend = () => { if (X.rec === rec) X.rec = null; if (X.on && !X.paused) setTimeout(sessionListen, 250); }; // the browser stops now and then; start again
    X.rec = rec;
    try { rec.start(); } catch (e) { X.rec = null; }
  }
  // what counts as its name: "POS" (and how speech recognition tends to spell it), or the name you gave it
  function nameIn(text) {
    const nm = String(ctx.name() || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const names = ['pos', 'p o s', 'p\\.? ?o\\.? ?s\\.?', 'poss', 'pause'].concat(nm && nm !== 'pos' ? [nm] : []);
    const re = new RegExp(`(?:^|\\b(?:hey|okay|ok|hi|yo)\\s+)(${names.join('|')})\\b[,.!?]?\\s*(.*)$`, 'i');
    const m = String(text).match(re);
    if (!m) return null;
    if (/^pause$/i.test(m[1]) && !/\b(hey|okay|ok|hi|yo)\s+pause/i.test(text)) return null; // "pause" alone is just a word
    return { rest: m[2].trim() };
  }
  function heard(text) {
    if (!text || !X.on) return;
    X.lastHeard = Date.now(); X.live = '';
    const s = text.toLowerCase();
    const line = { at: Date.now(), text };
    X.log.push(line); X.dirty = true; paintLive();
    if (/\b(?:end|stop|close|finish) (?:the |this |my )?session\b/.test(s)) { endSession(); return; }
    // keep the last thing said (or what follows "capture this:")
    const cap = s.match(/\b(?:capture|log|keep|note) (?:this|that)\b[:,.]?\s*(.*)$/);
    if (cap) {
      const after = text.slice(text.length - cap[1].length).trim();
      const prev = X.log.slice(0, -1).filter(l => !l.cap && Date.now() - l.at < 90e3).slice(-2).map(l => l.text).join(' ');
      const what = after.length > 3 ? after : prev;
      if (what) { X.log.push({ at: Date.now(), text: what, cap: true }); toast(`Captured: ${what.slice(0, 80)}${what.length > 80 ? '…' : ''}`); L.bump = 1; }
      else toast('Nothing to capture yet');
      return;
    }
    if (T.phase === 'confirm' && T.act && /^(?:yes|yeah|yep|yup|sure|ok|okay|do it|go ahead|confirm|please do|no|nope|cancel|don't|never ?mind)\b/.test(s)) { handle(text); return; }
    const m = nameIn(text);
    if (m) { if (m.rest.split(' ').length >= 2) handle(m.rest); else { X.waitCmd = Date.now(); T.phase = 'reply'; T.said = ''; T.reply = 'Yes?'; redraw(); speak('Yes?'); } return; }
    if (X.waitCmd && Date.now() - X.waitCmd < 10e3) { X.waitCmd = 0; handle(text); return; }
    if (T.follow > Date.now() && text.trim().split(/\s+/).length >= 2) handle(text);
  }
  function sessionTick() {
    if (!X.on) return;
    if (Date.now() - X.lastHeard > QUIET_END) { endSession(); return; }
    if (!X.rec && !X.paused) sessionListen();
    paintLive();
    if (X.dirty && Date.now() - (X.savedAt || 0) > 15e3) saveSession();
  }
  // the raw log lives in its own record (kind "session"), saved as it goes so nothing is lost
  async function saveSession(final) {
    if (!X.id) return;
    X.dirty = false; X.savedAt = Date.now();
    const data = { startedAt: X.startAt, endedAt: final ? Date.now() : null, lines: X.log.map(l => ({ at: l.at, text: l.text, ...(l.cap ? { cap: true } : {}) })) };
    try {
      if (!X.saved) { const { error } = await ctx.sb.from('records').insert({ id: X.id, kind: 'session', data }); if (error) throw error; X.saved = true; }
      else { const { error } = await ctx.sb.from('records').update({ data }).eq('id', X.id); if (error) throw error; }
    } catch (e) { X.dirty = true; }
  }
  const tFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dtFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  async function endSession(quiet) {
    if (!X.on) return;
    X.on = false; clearInterval(X.tick);
    if (X.rec) { const r = X.rec; X.rec = null; r.onend = null; try { r.abort(); } catch (e) {} }
    meterOff(); X.live = ''; paintLive(); redraw();
    await saveSession(true);
    const said = X.log.filter(l => !l.cap), caps = X.log.filter(l => l.cap);
    if (quiet || (said.length < 2 && !caps.length)) { if (!quiet) toast('Session ended'); return; }
    toast('Session ended. Writing it up…');
    const transcript = X.log.map(l => `[${tFmt.format(new Date(l.at))}] ${l.cap ? 'CAPTURED: ' : ''}${l.text}`).join('\n');
    let wrap = null;
    try { const d = await call({ action: 'wrap', transcript }); if (!d.error) wrap = d.wrap; } catch (e) { /* saved without the write-up */ }
    const title = `Session · ${dtFmt.format(new Date(X.startAt))}`;
    const parts = [];
    if (wrap && wrap.summary) parts.push(wrap.summary);
    if (wrap && wrap.ideas && wrap.ideas.length) parts.push('Ideas\n' + wrap.ideas.map(x => '• ' + x).join('\n'));
    else if (caps.length) parts.push('Captured\n' + caps.map(c => '• ' + c.text).join('\n'));
    if (wrap && wrap.tasks && wrap.tasks.length) parts.push('To do\n' + wrap.tasks.map(t => '• ' + t.title + (t.date ? ` (${t.date})` : '')).join('\n'));
    if (wrap && wrap.build && wrap.build.length) parts.push('For Claude\n' + wrap.build.map(b => '• ' + b.title).join('\n'));
    if (!wrap) parts.push(`The full log is saved (${said.length} lines). The write-up needs the assistant key.`);
    const now = Date.now(), note = async (t, body, pinned) => { const { error } = await ctx.sb.from('records').insert({ id: 'note-' + uuid(), kind: 'note', data: { title: t, body, pinned, createdAt: now, updatedAt: now } }); if (error) throw error; };
    try {
      await note(title, parts.join('\n\n') + `\n\nLog: ${X.id}`, false);
      for (const b of (wrap && wrap.build) || []) await note(`For Claude: ${b.title}`, `${b.details || ''}\n\nFrom ${title}.`, true);
    } catch (e) { toast('The write-up did not save. The log is safe.'); }
    const nb = (wrap && wrap.build || []).length, nt = (wrap && wrap.tasks || []).length;
    speak(`Session saved.${nb ? ` ${nb} for Claude.` : ''}${nt ? ` ${nt} ${nt === 1 ? 'task' : 'tasks'} to look at.` : ''}`);
    if (nt) { W.tasks = wrap.tasks.map(t => ({ ...t, on: true })); paintWrap(); }
  }
  async function addWrapTasks() {
    const pick = [...document.querySelectorAll('#asWrap input[type=checkbox]')].map((c, i) => c.checked && W.tasks[i]).filter(Boolean);
    W.tasks = null; paintWrap();
    for (const t of pick) { try { await ctx.run({ action: 'add_task', title: t.title, date: t.date || '' }); } catch (e) { toast('One task did not save.'); } }
    if (pick.length) toast(`Added ${pick.length} ${pick.length === 1 ? 'task' : 'tasks'}`);
  }
  // the session's own surface: a LIVE bar on every screen, the conversation floating bottom right, and the tasks to confirm
  function layer(id, cls) { let el = document.getElementById(id); if (!el) { el = document.createElement('div'); el.id = id; if (cls) el.className = cls; document.body.appendChild(el); } return el; }
  function paintLive() {
    const el = layer('sessLive');
    if (!X.on) { el.hidden = true; el.innerHTML = ''; document.body.classList.remove('in-session'); return; }
    document.body.classList.add('in-session');
    const secs = Math.floor((Date.now() - X.startAt) / 1000), mm = Math.floor(secs / 60), ss = String(secs % 60).padStart(2, '0');
    const last = X.live || (X.log.length ? X.log[X.log.length - 1].text : '');
    const n = X.log.filter(l => l.cap).length;
    el.hidden = false;
    el.innerHTML = `<span class="sl-dot"></span><span class="sl-k">Live</span><span class="sl-k sl-time">${mm}:${ss}</span>${n ? `<span class="sl-k sl-cap">${n} captured</span>` : ''}${T.follow > Date.now() ? '<span class="sl-k sl-fol">Listening for more</span>' : ''}<span class="sl-said${X.live ? ' now' : ''}">${esc(last.slice(-90))}</span><button type="button" class="sl-end" data-act="as-sess">End</button>`;
  }
  function paintFloat() {
    const el = layer('asFloat');
    const html = X.on ? panelHtml() : '';
    if (el.innerHTML !== html) el.innerHTML = html;
    el.hidden = !html;
  }
  function paintWrap() {
    const el = layer('asWrap');
    if (!W.tasks) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = `<div class="as-panel as-confirm-list"><div class="as-head"><span class="as-lab">From the session · add these?</span><button type="button" class="as-x" data-act="as-wrap-x" aria-label="Close">×</button></div>${W.tasks.map((t, i) => `<label class="as-wt"><input type="checkbox" checked data-i="${i}"><span>${esc(t.title)}${t.date ? ` <small>${esc(t.date)}</small>` : ''}</span></label>`).join('')}<div class="as-btns"><button type="button" class="btn" data-act="as-wrap-x">Not now</button><button type="button" class="btn solid" data-act="as-wrap-add">Add</button></div></div>`;
  }
  window.addEventListener('beforeunload', () => { if (X.on && X.dirty) saveSession(true); });

  /* ---------- Settings: the key, how long it lasts, and speaking out loud ---------- */
  let wantDays = 30;
  const dFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  function fillVoices() {
    const sel = $('#asVoice');
    if (!sel) return;
    const want = get('pos.as.voice') || '', list = rankedVoices();
    sel.innerHTML = `<option value="">Automatic${list[0] ? ` (${esc(list[0].name.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, ''))})` : ''}</option>` + list.map(v => `<option value="${esc(v.name)}"${v.name === want ? ' selected' : ''}>${esc(v.name.replace(/^Microsoft /, '').replace(/ Online \(Natural\)/, ' · natural'))}</option>`).join('');
    for (const b of document.querySelectorAll('#asDepth button')) b.setAttribute('aria-checked', String(Math.abs(parseFloat(b.dataset.depth) - pitchNow()) < 0.02));
  }
  function fillSettings() {
    fillVoices();
    const vs = $('#asVoiceSum'); if (vs && ctx.voice) vs.textContent = ctx.voice.summary();
    const dev = !ctx.voice || !ctx.voice.active(); for (const r of document.querySelectorAll('.as-devvoice')) r.hidden = !dev;
    const info = $('#asKeyInfo'), note = $('#asNote'), rm = $('#asRemove'), sp = $('#asSpeak');
    if (!info) return;
    const d = daysLeft();
    note.textContent = !K.known ? '' : K.key ? (d != null && d <= 3 ? (d <= 0 ? 'Key expired' : `Key expires in ${d} ${d === 1 ? 'day' : 'days'}`) : 'On') : 'Off';
    note.className = 'set-note' + (d != null && d <= 3 ? ' warn' : '');
    info.textContent = !K.known ? '' : K.key
      ? `Key added ${dFmt.format(new Date(K.setAt))}${K.days ? `, a ${K.days}-day key: ${d > 0 ? `${d} ${d === 1 ? 'day' : 'days'} left` : 'expired'}` : ', never expires'}. ${K.today} ${K.today === 1 ? 'ask' : 'asks'} today, ${K.month} this month.`
      : 'No key yet. Until there is one, it knows a few set phrases: open a section, what\'s today, operate camera five.';
    rm.hidden = !K.key;
    $('#as_key').placeholder = K.key ? 'Paste a new key to replace it' : 'Paste your Claude API key (sk-ant-…)';
    for (const b of document.querySelectorAll('#asDays button')) b.setAttribute('aria-checked', String(String(wantDays) === b.dataset.days));
    sp.setAttribute('aria-checked', String(speakOn()));
  }
  async function saveKey() {
    const inp = $('#as_key'), btn = $('#asSave'), key = inp.value.trim();
    if (!key) return;
    if (!ctx.canSave()) { toast('Not connected yet. Try again in a moment.'); return; }
    btn.disabled = true;
    try {
      await call({ action: 'set-key', key, days: wantDays === 'never' ? 'never' : wantDays });
      inp.value = ''; toast('Assistant on'); await status(true);
    } catch (e) { toast(e.message || 'That did not save.'); }
    btn.disabled = false;
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('#asDays button, #asRemove, #asSpeak, #asDepth button, #asVoiceTest');
    if (!b) return;
    if (b.id === 'asVoiceTest') { speak(`${ctx.name()} online. All systems running.`, true); return; }
    if (b.dataset.depth) { put('pos.as.pitch', b.dataset.depth); fillVoices(); speak('Like this.', true); return; }
    if (b.id === 'asRemove') { try { await call({ action: 'clear-key' }); toast('Assistant key removed'); await status(true); } catch (err) { toast(err.message); } return; }
    if (b.id === 'asSpeak') { put('pos.as.speak', speakOn() ? '0' : null); fillSettings(); return; }
    wantDays = b.dataset.days === 'never' ? 'never' : +b.dataset.days; fillSettings();
  });

  return { panel, act, busy, holding, level, status, keyWarn, fillSettings, listening: () => T.phase === 'listen' || (X.on && !X.paused), canSession, sessionOn: () => X.on, inStage: () => busy() && !X.on };
};
