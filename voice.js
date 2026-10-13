// POS voice: its own voice, made on this device. A neural voice (Piper) turns the words into sound; then a rack of
// effects shapes it: pitch and size, robot, synth (a vocoder, hard-tuned to a note), doubling, grit, radio, echo and
// room, and tone. You build it in the Voice Lab (Settings > Assistant) and it's saved to your account, so every device
// sounds the same. Nothing said goes anywhere: the voice runs here. Only the voice itself is downloaded, once per
// device (from Hugging Face), and kept.
window.POSVoice = function (ctx) {
  const { esc, toast } = ctx;
  const $ = s => document.querySelector(s);
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };

  /* ---------- where the pieces come from ---------- */
  const HF = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/';
  const ORT = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/';
  const PHON = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-o91UDS6e.js';
  const PWASM = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize';
  const MODELS = [
    { id: 'en_US-ryan-medium', name: 'Ryan', note: 'American', mb: 63, path: 'en/en_US/ryan/medium/en_US-ryan-medium.onnx' },
    { id: 'en_US-joe-medium', name: 'Joe', note: 'American', mb: 63, path: 'en/en_US/joe/medium/en_US-joe-medium.onnx' },
    { id: 'en_US-hfc_male-medium', name: 'Cole', note: 'American', mb: 63, path: 'en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx' },
    { id: 'en_US-kusal-medium', name: 'Kusal', note: 'American', mb: 63, path: 'en/en_US/kusal/medium/en_US-kusal-medium.onnx' },
    { id: 'en_GB-alan-medium', name: 'Alan', note: 'British', mb: 63, path: 'en/en_GB/alan/medium/en_GB-alan-medium.onnx' },
    { id: 'en_GB-northern_english_male-medium', name: 'Northern', note: 'British, northern', mb: 63, path: 'en/en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx' },
    { id: 'en_US-ryan-high', name: 'Ryan HD', note: 'American, best quality', mb: 121, path: 'en/en_US/ryan/high/en_US-ryan-high.onnx' },
  ];
  const modelOf = id => MODELS.find(m => m.id === id) || MODELS[0];

  /* ---------- the settings: what the voice is, and the presets ---------- */
  const DEF = { engine: 'neural', model: 'en_US-ryan-medium', speed: 1, pitch: 0, size: 0, expr: 0.67, robot: 0, robotHz: 60, synth: 0, note: 45, double: 0, spread: 0.5,
    grit: 0, bits: 0, radio: 0, echo: 0, echoTime: 0.2, room: 0, roomSize: 0.35, bass: 0, mid: 0, treble: 0, gain: 0, preset: 'plain' };
  const PRESETS = {
    plain: { name: 'Plain' },
    jarvis: { name: 'Jarvis', pitch: -1, size: 0.2, double: 0.3, spread: 0.35, robot: 0.06, robotHz: 38, room: 0.16, roomSize: 0.3, bass: 2, treble: 2.5, speed: 1.04 },
    cyber: { name: 'Cyber', pitch: -3, size: 0.3, robot: 0.32, robotHz: 52, double: 0.45, spread: 0.55, grit: 0.12, bits: 0.22, treble: 3, room: 0.12, roomSize: 0.25 },
    machine: { name: 'Machine', pitch: -2, synth: 0.8, note: 43, robot: 0.18, robotHz: 85, double: 0.25, room: 0.1, treble: 2 },
    deep: { name: 'Deep core', pitch: -5, size: 0.5, bass: 5, double: 0.15, room: 0.2, roomSize: 0.55, speed: 0.95 },
    radio: { name: 'Radio', radio: 0.9, grit: 0.25, mid: 4, echo: 0.08, echoTime: 0.12 },
  };
  const presetOf = k => ({ ...DEF, ...PRESETS[k], preset: k, name: undefined });
  let P = (() => { try { return { ...DEF, ...JSON.parse(get('pos.voice') || 'null') }; } catch (e) { return { ...DEF }; } })();
  if (!get('pos.voice')) P = { ...presetOf('cyber') };
  const active = () => P.engine === 'neural';

  // the voice lives in your account (record "voice") so every device sounds alike
  async function loadSaved() {
    if (!ctx.sb || !ctx.canSave()) return;
    try {
      const { data } = await ctx.sb.from('records').select('data').eq('id', 'voice').maybeSingle();
      if (data && data.data && data.data.params) { P = { ...DEF, ...data.data.params }; put('pos.voice', JSON.stringify(P)); warm(); }
    } catch (e) {}
  }
  async function saveToAccount(p) {
    const data = { params: p, at: Date.now() };
    const { data: rows, error: e1 } = await ctx.sb.from('records').select('id').eq('id', 'voice');
    if (e1) throw e1;
    const { error } = rows && rows.length ? await ctx.sb.from('records').update({ data }).eq('id', 'voice') : await ctx.sb.from('records').insert({ id: 'voice', kind: 'voice', data });
    if (error) throw error;
  }

  /* ---------- downloads, kept on the device ---------- */
  const CACHE = 'pos-voice-v1';
  async function fetchKept(url, onProgress) {
    let cache = null;
    try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) return await hit.arrayBuffer(); } catch (e) { cache = null; }
    const r = await fetch(url);
    if (!r.ok) throw new Error('Download failed (' + r.status + ')');
    const total = +r.headers.get('content-length') || 0;
    let buf;
    if (onProgress && r.body && total) {
      const rd = r.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onProgress(got / total); }
      const all = new Uint8Array(got); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
      buf = all.buffer;
    } else buf = await r.arrayBuffer();
    if (cache) try { await cache.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) {}
    return buf;
  }
  async function isKept(url) { try { const c = await caches.open(CACHE); return !!(await c.match(url)); } catch (e) { return false; } }
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });

  /* ---------- the engine: words to sound, all on this device ---------- */
  const E = { ort: null, phon: null, wasm: null, data: null, models: {}, busy: Promise.resolve() };
  async function ortReady() {
    if (E.ort) return E.ort;
    if (!window.ort) await loadScript(ORT + 'ort.min.js');
    window.ort.env.wasm.wasmPaths = ORT; window.ort.env.wasm.numThreads = 1;
    return (E.ort = window.ort);
  }
  async function phonReady() {
    if (!E.phon) E.phon = (await import(PHON)).createPiperPhonemize;
    if (!E.wasm) E.wasm = await fetchKept(PWASM + '.wasm');
    if (!E.data) E.data = await fetchKept(PWASM + '.data');
  }
  async function modelReady(id, onProgress) {
    if (E.models[id]) return E.models[id];
    const m = modelOf(id), ort = await ortReady();
    await phonReady();
    const cfg = JSON.parse(new TextDecoder().decode(await fetchKept(HF + m.path + '.json')));
    const bin = await fetchKept(HF + m.path, onProgress);
    const session = await ort.InferenceSession.create(bin, { executionProviders: ['wasm'] });
    return (E.models[id] = { cfg, session });
  }
  function phonemize(text, voice) {
    return new Promise((resolve, reject) => {
      let done = false;
      E.phon({
        print: d => { if (done) return; try { done = true; resolve(JSON.parse(d).phoneme_ids); } catch (e) { reject(e); } },
        printErr: () => {},
        wasmBinary: E.wasm,
        getPreloadedPackage: () => E.data.slice(0),
        locateFile: u => (u.endsWith('.wasm') ? PWASM + '.wasm' : u.endsWith('.data') ? PWASM + '.data' : u),
      }).then(mod => mod.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data'])).catch(reject);
    });
  }
  const chunksOf = t => (String(t).replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]*/g) || []).map(s => s.trim()).filter(Boolean)
    .reduce((a, s) => { if (a.length && (a[a.length - 1] + ' ' + s).length < 220) a[a.length - 1] += ' ' + s; else a.push(s); return a; }, []);
  // returns { pcm: Float32Array, sr }
  async function synth(text, p) {
    const { cfg, session } = await modelReady(p.model), ort = E.ort, sr = cfg.audio.sample_rate;
    const inf = cfg.inference || {}, parts = [], gap = new Float32Array(Math.round(sr * 0.12));
    for (const c of chunksOf(text)) {
      const ids = await phonemize(c, cfg.espeak.voice);
      const feeds = {
        input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
        scales: new ort.Tensor('float32', Float32Array.from([(inf.noise_scale ?? 0.667) * (p.expr / 0.67), (inf.length_scale ?? 1) / p.speed, inf.noise_w ?? 0.8]), [3]),
      };
      if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
      const out = await session.run(feeds);
      if (parts.length) parts.push(gap);
      parts.push(out.output.data);
    }
    const n = parts.reduce((s, a) => s + a.length, 0), pcm = new Float32Array(n);
    let o = 0; for (const a of parts) { pcm.set(a, o); o += a.length; }
    return { pcm, sr };
  }

  /* ---------- pitch and size: pitch-synchronous overlap-add (TD-PSOLA). Pitch moves the note without
     changing how big the voice sounds; size moves the formants (a bigger or smaller throat) without moving
     the note. ---------- */
  function periods(x, sr) {
    // a pitch track every 10 ms, by autocorrelation on a half-rate copy (0 where it's unvoiced)
    const d = new Float32Array(x.length >> 1); for (let i = 0; i < d.length; i++) d[i] = (x[2 * i] + x[2 * i + 1]) * 0.5;
    const r = sr / 2, hop = Math.round(r * 0.01), win = Math.round(r * 0.032), lo = Math.floor(r / 380), hi = Math.ceil(r / 55);
    const n = Math.max(1, Math.floor((d.length - win - hi) / hop) + 1), out = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const s = f * hop; let e0 = 0;
      for (let i = 0; i < win; i++) e0 += d[s + i] * d[s + i];
      if (e0 < win * 2e-5) continue;
      let best = 0, bp = 0;
      for (let p = lo; p <= hi; p++) {
        let c = 0, e1 = 0;
        for (let i = 0; i < win; i++) { const b = d[s + i + p]; c += d[s + i] * b; e1 += b * b; }
        const v = c / Math.sqrt(e0 * e1 + 1e-9);
        if (v > best) { best = v; bp = p; }
      }
      if (best > 0.5) out[f] = bp * 2;
    }
    return { per: out, hop: hop * 2 };
  }
  function psola(x, sr, pitchF, timeF) {
    if (Math.abs(pitchF - 1) < 0.005 && Math.abs(timeF - 1) < 0.005) return x;
    const { per, hop } = periods(x, sr), unv = Math.round(sr * 0.008), N = x.length;
    const perAt = t => per[Math.min(per.length - 1, Math.max(0, Math.floor(t / hop)))] || 0;
    // marks on the waveform, one per cycle, snapped to each cycle's peak so the grains line up
    const marks = []; let t = 0;
    while (t < N) {
      const p = perAt(t) || unv;
      let m = t;
      if (perAt(t)) { let bv = -1e9; for (let i = Math.max(0, t - (p >> 2)); i < Math.min(N, t + (p >> 2)); i++) if (x[i] > bv) { bv = x[i]; m = i; } }
      marks.push([m, p, !!perAt(t)]);
      t = Math.max(m, t) + p;
    }
    const outN = Math.round(N * timeF), y = new Float32Array(outN + 2 * sr / 50), w = new Float32Array(y.length);
    let ts = 0, k = 0;
    while (ts < outN) {
      const ta = ts / timeF;
      while (k < marks.length - 1 && Math.abs(marks[k + 1][0] - ta) < Math.abs(marks[k][0] - ta)) k++;
      const [m, p, voiced] = marks[k], L = p;
      for (let i = -L; i < L; i++) {
        const src = m + i, dst = Math.round(ts) + i;
        if (src < 0 || src >= N || dst < 0 || dst >= y.length) continue;
        const h = 0.5 + 0.5 * Math.cos(Math.PI * i / L);
        y[dst] += x[src] * h; w[dst] += h;
      }
      ts += voiced ? p / pitchF : p;
    }
    for (let i = 0; i < y.length; i++) if (w[i] > 0.4) y[i] /= w[i];
    return y.subarray(0, outN);
  }
  function resample(x, f) { // play it at f times the speed: everything f times higher, 1/f as long
    const n = Math.floor(x.length / f), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { const s = i * f, a = Math.floor(s), b = Math.min(x.length - 1, a + 1), u = s - a; y[i] = x[a] * (1 - u) + x[b] * u; }
    return y;
  }
  function shape(pcm, sr, p) {
    const pf = Math.pow(2, p.pitch / 12), F = Math.pow(2, -p.size * 0.42); // size up: lower formants, a bigger voice
    const y = Math.abs(F - 1) > 0.005 ? resample(pcm, F) : pcm;
    return psola(y, sr, pf / F, F);
  }

  /* ---------- the rack: Web Audio nodes, the same for playing and for rendering ---------- */
  const irCache = new Map();
  function impulse(ac, size) {
    const key = ac.sampleRate + '|' + size.toFixed(2);
    if (irCache.has(key) && irCache.get(key).ac === ac) return irCache.get(key).b;
    const len = Math.round(ac.sampleRate * (0.25 + size * 2.4)), b = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let s = 7 + c; for (let i = 0; i < len; i++) { s = (s * 16807) % 2147483647; d[i] = ((s / 2147483647) * 2 - 1) * Math.pow(1 - i / len, 2.2 + (1 - size) * 2); } }
    irCache.set(key, { ac, b });
    return b;
  }
  const db = v => Math.pow(10, v / 20);
  const midiHz = n => 440 * Math.pow(2, (n - 69) / 12);
  function rack(ac, src, p, out) {
    const stop = [];
    const g = v => { const n = ac.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q, gain) => { const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = f; if (q != null) n.Q.value = q; if (gain != null) n.gain.value = gain; return n; };
    const osc = (type, f) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; stop.push(o); return o; };
    // tone
    const lo = bq('lowshelf', 180, null, p.bass), mid = bq('peaking', 1300, 0.8, p.mid), hi = bq('highshelf', 3600, null, p.treble);
    src.connect(lo); lo.connect(mid); mid.connect(hi);
    let node = hi;
    // robot: ring modulation, a metallic edge
    if (p.robot > 0.005) {
      const sum = g(1), dry = g(1 - p.robot * 0.75), ring = g(0), wet = g(p.robot * 1.6), o = osc('sine', p.robotHz);
      o.connect(ring.gain); node.connect(dry); node.connect(ring); ring.connect(wet); dry.connect(sum); wet.connect(sum);
      node = sum;
    }
    // synth: a channel vocoder, its carrier held on one note (the hard-tuned machine voice)
    if (p.synth > 0.005) {
      const sum = g(1), dry = g(1 - p.synth * 0.9), wet = g(p.synth * 6.5), carrier = g(1);
      const saw = osc('sawtooth', midiHz(p.note)), saw2 = osc('sawtooth', midiHz(p.note) * 2.005);
      const s2 = g(0.35); saw.connect(carrier); saw2.connect(s2); s2.connect(carrier);
      const nb = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      const noise = ac.createBufferSource(); noise.buffer = nb; noise.loop = true; stop.push(noise);
      const hiss = g(0.25); noise.connect(hiss);
      const rect = ac.createWaveShaper(), curve = new Float32Array(1025); for (let i = 0; i < curve.length; i++) curve[i] = Math.abs(i / 512 - 1); rect.curve = curve;
      const bands = 16;
      for (let i = 0; i < bands; i++) {
        const f = 140 * Math.pow(7400 / 140, i / (bands - 1));
        const mb = bq('bandpass', f, 7), env = ac.createWaveShaper(), lp = bq('lowpass', 32, 0.5), vca = g(0), cb = bq('bandpass', f, 7);
        env.curve = curve;
        node.connect(mb); mb.connect(env); env.connect(lp); lp.connect(vca.gain);
        (f > 4500 ? hiss : carrier).connect(cb); cb.connect(vca); vca.connect(wet);
      }
      node.connect(dry); dry.connect(sum); wet.connect(sum);
      node = sum;
    }
    // grit: drive and bit crush in one curve
    if (p.grit > 0.005 || p.bits > 0.005) {
      const ws = ac.createWaveShaper(), n = 4096, c = new Float32Array(n), k = 1 + p.grit * 30, steps = Math.pow(2, 16 - p.bits * 12.5);
      for (let i = 0; i < n; i++) { let x = i / (n / 2) - 1; x = Math.tanh(k * x) / Math.tanh(k); c[i] = Math.round(x * steps) / steps; }
      ws.curve = c; ws.oversample = p.bits > 0.3 ? 'none' : '4x';
      node.connect(ws); const comp = g(1 / (1 + p.grit * 0.6)); ws.connect(comp); node = comp;
    }
    // radio: a narrow band with a bit of bite
    if (p.radio > 0.005) {
      const sum = g(1), dry = g(1 - p.radio), wet = g(p.radio * 1.4), hp = bq('highpass', 420, 0.8), lp = bq('lowpass', 3100, 0.9), pk = bq('peaking', 1800, 1.2, 6);
      node.connect(dry); node.connect(hp); hp.connect(lp); lp.connect(pk); pk.connect(wet); dry.connect(sum); wet.connect(sum);
      node = sum;
    }
    // double: a pair of slightly detuned, moving copies left and right
    let pre = node;
    if (p.double > 0.005) {
      const sum = g(1); node.connect(sum);
      for (const [base, rate, pan] of [[0.013, 0.6, -1], [0.021, 0.83, 1]]) {
        const d = ac.createDelay(0.1), lfo = osc('sine', rate), depth = g(0.002 + p.spread * 0.006), wet = g(p.double * 0.8);
        d.delayTime.value = base; lfo.connect(depth); depth.connect(d.delayTime);
        node.connect(d); d.connect(wet);
        if (ac.createStereoPanner) { const pn = ac.createStereoPanner(); pn.pan.value = pan * (0.25 + p.spread * 0.6); wet.connect(pn); pn.connect(sum); } else wet.connect(sum);
      }
      pre = sum;
    }
    const master = g(1); pre.connect(master);
    // space: echo and room, sent from the doubled voice
    if (p.echo > 0.005) {
      const d = ac.createDelay(1), fb = g(0.32), wet = g(p.echo * 0.7), lp = bq('lowpass', 3800, 0.7);
      d.delayTime.value = p.echoTime; pre.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(wet); wet.connect(master);
    }
    if (p.room > 0.005) { const cv = ac.createConvolver(), wet = g(p.room * 0.9); cv.buffer = impulse(ac, p.roomSize); pre.connect(cv); cv.connect(wet); wet.connect(master); }
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 3.5; comp.attack.value = 0.004; comp.release.value = 0.18;
    const vol = g(db(p.gain) * 1.15);
    master.connect(comp); comp.connect(vol); vol.connect(out);
    return { start: t => { for (const o of stop) o.start(t); }, stop: t => { for (const o of stop) try { o.stop(t); } catch (e) {} } };
  }

  /* ---------- speaking ---------- */
  const A = { ac: null, an: null, buf: null, src: null, chain: null, speaking: false, cache: new Map(), gen: 0 };
  function audio() {
    if (!A.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      A.ac = new AC(); A.an = A.ac.createAnalyser(); A.an.fftSize = 512; A.buf = new Uint8Array(512); A.an.connect(A.ac.destination);
    }
    if (A.ac.state === 'suspended') A.ac.resume().catch(() => {});
    return A.ac;
  }
  const unlock = () => { try { audio(); } catch (e) {} };
  // the words for a setting, cached so trying effects doesn't redo the voice
  async function voiced(text, p) {
    const k1 = [p.model, p.speed, p.expr, text].join('|'), k2 = k1 + '|' + p.pitch + '|' + p.size;
    if (A.cache.has(k2)) return A.cache.get(k2);
    let raw = A.cache.get(k1);
    if (!raw) { raw = await synth(text, p); A.cache.set(k1, raw); }
    const shaped = { pcm: shape(raw.pcm, raw.sr, p), sr: raw.sr };
    A.cache.set(k2, shaped);
    if (A.cache.size > 24) A.cache.delete(A.cache.keys().next().value);
    return shaped;
  }
  function stop() {
    A.gen++;
    if (A.src) { try { A.src.onended = null; A.src.stop(); } catch (e) {} A.src = null; }
    if (A.chain) { A.chain.stop(); A.chain = null; }
    A.speaking = false;
  }
  // say something: resolves when it has finished speaking (or was cut off)
  async function say(text, p = P, hooks = {}) {
    stop();
    const my = ++A.gen;
    const v = await voiced(text, p);
    if (my !== A.gen) return;
    const ac = audio(), b = ac.createBuffer(1, v.pcm.length, v.sr);
    b.copyToChannel(v.pcm, 0);
    const src = ac.createBufferSource(); src.buffer = b;
    const chain = rack(ac, src, p, A.an), t0 = ac.currentTime + 0.03;
    chain.start(t0); src.start(t0);
    A.src = src; A.chain = chain; A.speaking = true;
    if (hooks.onstart) hooks.onstart();
    return new Promise(res => {
      src.onended = () => { setTimeout(() => { if (A.src === src) { chain.stop(); A.chain = null; A.src = null; A.speaking = false; } if (hooks.onend) hooks.onend(); res(); }, Math.min(2500, 200 + (p.room * 1800) + (p.echo * 1200))); };
    });
  }
  function level() {
    if (!A.speaking || !A.an) return 0;
    A.an.getByteTimeDomainData(A.buf);
    let s = 0; for (let i = 0; i < A.buf.length; i++) { const x = (A.buf[i] - 128) / 128; s += x * x; }
    return Math.min(1, Math.sqrt(s / A.buf.length) * 4.5);
  }
  // render to a WAV file (used to check presets, and to hand you a sample)
  async function render(text, p = P) {
    const v = await voiced(text, p), tail = 1.5, sr = 44100;
    const oac = new OfflineAudioContext(2, Math.ceil((v.pcm.length / v.sr + tail) * sr), sr);
    const b = oac.createBuffer(1, v.pcm.length, v.sr); b.copyToChannel(v.pcm, 0);
    const src = oac.createBufferSource(); src.buffer = b;
    const chain = rack(oac, src, p, oac.destination); chain.start(0); src.start(0);
    const out = await oac.startRendering();
    return wav(out);
  }
  function wav(ab) {
    const ch = ab.numberOfChannels, n = ab.length, sr = ab.sampleRate, buf = new ArrayBuffer(44 + n * ch * 2), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * ch * 2, true);
    const data = []; for (let c = 0; c < ch; c++) data.push(ab.getChannelData(c));
    let o = 44, peak = 0; for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) peak = Math.max(peak, Math.abs(data[c][i]));
    const k = peak > 0.98 ? 0.98 / peak : 1;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { dv.setInt16(o, Math.max(-1, Math.min(1, data[c][i] * k)) * 32767, true); o += 2; }
    return new Blob([buf], { type: 'audio/wav' });
  }
  // get the voice ready in the background, if it's already on this device (computers fetch it the first time)
  let warming = null;
  async function warm(force) {
    if (!active() || warming) return warming;
    const m = modelOf(P.model);
    const desk = !!(window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches);
    if (!force && !desk && !(await isKept(HF + m.path))) return null;
    warming = modelReady(P.model).catch(() => null).finally(() => { warming = null; });
    return warming;
  }
  const ready = () => active() && !!E.models[P.model];

  /* ---------- the Voice Lab ---------- */
  const KNOBS = [
    ['Voice', [['speed', 'Speed', 0.7, 1.4, 0.01, v => v.toFixed(2) + '×'], ['pitch', 'Pitch', -12, 12, 0.5, v => (v > 0 ? '+' : '') + v + ' st'], ['size', 'Size', -1, 1, 0.05, v => (v > 0 ? 'Bigger ' : v < 0 ? 'Smaller ' : '') + Math.round(Math.abs(v) * 100) + '%'], ['expr', 'Expression', 0, 1.5, 0.05, v => Math.round(v / 0.67 * 100) + '%']]],
    ['Robot', [['robot', 'Amount', 0, 1, 0.01, pc], ['robotHz', 'Tone', 15, 220, 1, v => v + ' Hz']]],
    ['Synth', [['synth', 'Amount', 0, 1, 0.01, pc], ['note', 'Note', 33, 60, 1, noteName]]],
    ['Double', [['double', 'Amount', 0, 1, 0.01, pc], ['spread', 'Spread', 0, 1, 0.01, pc]]],
    ['Grit', [['grit', 'Drive', 0, 1, 0.01, pc], ['bits', 'Crush', 0, 1, 0.01, pc]]],
    ['Radio', [['radio', 'Amount', 0, 1, 0.01, pc]]],
    ['Space', [['echo', 'Echo', 0, 1, 0.01, pc], ['echoTime', 'Echo time', 0.05, 0.6, 0.01, v => Math.round(v * 1000) + ' ms'], ['room', 'Room', 0, 1, 0.01, pc], ['roomSize', 'Room size', 0, 1, 0.01, pc]]],
    ['Tone', [['bass', 'Bass', -12, 12, 0.5, dbs], ['mid', 'Mid', -12, 12, 0.5, dbs], ['treble', 'Treble', -12, 12, 0.5, dbs], ['gain', 'Volume', -12, 6, 0.5, dbs]]],
  ];
  function pc(v) { return Math.round(v * 100) + '%'; }
  function dbs(v) { return (v > 0 ? '+' : '') + v + ' dB'; }
  function noteName(n) { return ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][n % 12] + (Math.floor(n / 12) - 1); }
  const LAB = { p: null, text: `${'POS'} online. All systems running. You have three things today, and one starts in twenty minutes.`, live: true, kept: {}, dl: null, busy: false };
  async function openLab() {
    const dlg = $('#voiceLab');
    if (!dlg) return;
    LAB.p = { ...P }; LAB.text = `${ctx.name ? ctx.name() : 'POS'} online. All systems running. You have three things today, and one starts in twenty minutes.`;
    for (const m of MODELS) LAB.kept[m.id] = await isKept(HF + m.path);
    paintLab();
    if (!dlg.open) dlg.showModal();
  }
  function paintLab() {
    const dlg = $('#voiceLab'), p = LAB.p;
    const models = MODELS.map(m => `<button type="button" class="vl-model${p.model === m.id ? ' on' : ''}" data-vl="model" data-id="${m.id}" role="radio" aria-checked="${p.model === m.id}"><b>${esc(m.name)}</b><span>${esc(m.note)}</span><small>${LAB.dl && LAB.dl.id === m.id ? `Downloading ${Math.round(LAB.dl.f * 100)}%` : LAB.kept[m.id] || E.models[m.id] ? 'On this device' : `${m.mb} MB download`}</small></button>`).join('');
    const presets = Object.entries(PRESETS).map(([k, v]) => `<button type="button" class="vl-chip${p.preset === k ? ' on' : ''}" data-vl="preset" data-id="${k}">${esc(v.name)}</button>`).join('');
    const knobs = KNOBS.map(([g, list]) => `<section class="vl-grp"><span class="vl-gl">${g}</span>${list.map(([k, l, mn, mx, st, f]) => `<label class="vl-k"><span class="vl-kl">${l}</span><input type="range" min="${mn}" max="${mx}" step="${st}" value="${p[k]}" data-k="${k}"><output id="vlo-${k}">${esc(f(p[k]))}</output></label>`).join('')}</section>`).join('');
    dlg.innerHTML = `<div class="vl">
      <div class="vl-head"><h2>Voice Lab</h2><div class="vl-eng seg3" role="radiogroup" aria-label="Which voice"><button type="button" role="radio" data-vl="engine" data-id="neural" aria-checked="${p.engine === 'neural'}">POS voice</button><button type="button" role="radio" data-vl="engine" data-id="device" aria-checked="${p.engine === 'device'}">Device voice</button></div><button type="button" class="circle" data-vl="close" aria-label="Close"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></div>
      ${p.engine === 'device' ? `<p class="vl-note">The device's own voices can't be shaped; pick one in Settings. Switch to POS voice to build your own.</p>` : `
      <div class="vl-try"><input id="vlText" type="text" value="${esc(LAB.text)}" aria-label="What to say"><button type="button" class="btn solid vl-play" data-vl="play">${LAB.busy ? 'Making…' : 'Play'}</button><button type="button" class="btn" data-vl="stop">Stop</button></div>
      <div class="vl-row"><span class="vl-gl">Start from</span><div class="vl-chips">${presets}</div></div>
      <div class="vl-row"><span class="vl-gl">Voice</span><div class="vl-models" role="radiogroup">${models}</div></div>
      <div class="vl-knobs">${knobs}</div>
      <label class="vl-live"><input type="checkbox" id="vlLive"${LAB.live ? ' checked' : ''}> Play as I change things</label>`}
      <div class="vl-foot"><button type="button" class="btn" data-vl="revert">Undo changes</button><button type="button" class="btn" data-vl="download"${p.engine === 'device' ? ' hidden' : ''}>Save a sample</button><button type="button" class="btn solid" data-vl="save">Save voice</button></div>
    </div>`;
  }
  let liveT = 0;
  const playLab = async () => {
    const p = LAB.p, m = modelOf(p.model);
    if (!E.models[p.model]) { LAB.dl = { id: p.model, f: 0 }; paintLab(); }
    LAB.busy = true;
    try {
      await modelReady(p.model, f => { LAB.dl = { id: p.model, f }; const s = document.querySelector(`.vl-model[data-id="${p.model}"] small`); if (s) s.textContent = `Downloading ${Math.round(f * 100)}%`; });
      LAB.kept[p.model] = true;
      if (LAB.dl) { LAB.dl = null; paintLab(); }
      await say(LAB.text, p);
    } catch (e) { toast(`The voice did not load: ${e.message || e}`); LAB.dl = null; }
    LAB.busy = false;
    const b = $('.vl-play'); if (b) b.textContent = 'Play';
    void m;
  };
  document.addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('#voiceLab [data-vl]');
    if (!b) return;
    const k = b.dataset.vl, p = LAB.p;
    if (k === 'close') { stop(); $('#voiceLab').close(); return; }
    if (k === 'engine') { p.engine = b.dataset.id; paintLab(); return; }
    if (k === 'preset') { const keep = { engine: p.engine, model: p.model }; LAB.p = { ...presetOf(b.dataset.id), ...keep }; paintLab(); if (LAB.live) playLab(); return; }
    if (k === 'model') { p.model = b.dataset.id; paintLab(); playLab(); return; }
    if (k === 'play') { LAB.text = $('#vlText').value || LAB.text; const pb = $('.vl-play'); if (pb) pb.textContent = 'Making…'; playLab(); return; }
    if (k === 'stop') { stop(); return; }
    if (k === 'revert') { LAB.p = { ...P }; paintLab(); return; }
    if (k === 'download') {
      try { const blob = await render($('#vlText').value || LAB.text, p); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pos-voice.wav'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
      catch (err) { toast('That did not render: ' + (err.message || err)); }
      return;
    }
    if (k === 'save') {
      P = { ...p }; put('pos.voice', JSON.stringify(P));
      if (ctx.canSave()) { try { await saveToAccount(P); toast('Voice saved. Every device will use it.'); } catch (err) { toast('Saved on this device. It did not reach your account.'); } }
      if (ctx.onChange) ctx.onChange();
      warm(true);
      return;
    }
  });
  document.addEventListener('input', e => {
    const k = e.target && e.target.dataset && e.target.dataset.k;
    if (!k || !e.target.closest('#voiceLab')) return;
    const knob = KNOBS.flatMap(g => g[1]).find(x => x[0] === k);
    LAB.p[k] = parseFloat(e.target.value); LAB.p.preset = 'custom';
    const o = document.getElementById('vlo-' + k); if (o) o.textContent = knob[5](LAB.p[k]);
    for (const c of document.querySelectorAll('#voiceLab .vl-chip.on')) c.classList.remove('on');
  });
  document.addEventListener('change', e => {
    if (e.target && e.target.id === 'vlLive') { LAB.live = e.target.checked; return; }
    if (e.target && e.target.dataset && e.target.dataset.k && e.target.closest('#voiceLab') && LAB.live) { clearTimeout(liveT); liveT = setTimeout(playLab, 120); }
  });

  const summary = () => (P.engine === 'neural' ? `${modelOf(P.model).name} · ${PRESETS[P.preset] ? PRESETS[P.preset].name : 'Custom'}` : 'Device voice');
  return { say, stop, level, unlock, active, ready, warm, loadSaved, openLab, render, summary, speaking: () => A.speaking, presets: PRESETS, models: MODELS, presetOf, _p: () => P };
};
