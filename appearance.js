// POS appearance, per device: Light / Dark / Automatic, and an optional wallpaper (built-in or your own photo).
// The status bar is filled with the exact color along the top of the screen (--chrome), so the two always meet with no line.
// With a wallpaper, that color is read from the top of the picture as it sits on this screen, after the light/dark tint.
window.POSLook = (function () {
  const root = document.documentElement;
  const $ = s => document.querySelector(s);
  const meta = $('#themeColor');
  const layer = $('#wallLayer');
  const BASE = { dark: '#0B0C0E', light: '#F4F4F7' };               // --chrome without a wallpaper
  const SCRIM = { dark: [6, 6, 8, 0.34], light: [255, 255, 255, 0.3] }; // must match --scrim in the style sheet
  const PRESETS = [
    { id: 'rose', name: 'Rose' },
    { id: 'aurora', name: 'Aurora' },
    { id: 'dune', name: 'Dune' },
    { id: 'mist', name: 'Mist' },
  ];
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };

  let mode = get('pos.mode') || 'dark';          // 'light' | 'dark' | 'auto'
  let wall = get('pos.wall') || 'none';          // 'none' | a preset id | 'photo:<stamp>'
  let photoKey = get('pos.photoKey');            // the wall value for your current photo
  let photoURL = null;                           // thumbnail of your photo, when you have one
  let shown = null;                              // { id, url, el, w, h, width } — what the wallpaper layer is showing
  let toast = () => {};

  /* ---------- your photo lives in IndexedDB (localStorage is too small for pictures) ---------- */
  const idb = (() => {
    let p = null;
    const open = () => p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('pos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = (mode, fn) => open().then(db => new Promise((res, rej) => {
      const tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    }));
    return { get: k => run('readonly', s => s.get(k)), set: (k, v) => run('readwrite', s => s.put(v, k)), del: k => run('readwrite', s => s.delete(k)) };
  })();

  const themeNow = () => (mode === 'auto'
    ? (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : mode === 'light' ? 'light' : 'dark');

  function setChrome(c) {
    if (c) root.style.setProperty('--chrome', c); else root.style.removeProperty('--chrome');
    const v = c || BASE[themeNow()];
    if (meta && meta.getAttribute('content') !== v) meta.setAttribute('content', v);
  }

  /* ---------- the built-in wallpapers, drawn in code so there are no image files to load ---------- */
  function paint(id, cv) {
    const x = cv.getContext('2d'), w = cv.width, h = cv.height, M = Math.max(w, h), m = Math.min(w, h);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const lin = (x0, y0, x1, y1, stops) => { const g = x.createLinearGradient(x0, y0, x1, y1); for (const [o, c] of stops) g.addColorStop(o, c); return g; };
    const glow = (cx, cy, r, rgb, a) => {
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(0.55, `rgba(${rgb},${a * 0.45})`); g.addColorStop(1, `rgba(${rgb},0)`);
      x.fillStyle = g; x.fillRect(0, 0, w, h);
    };
    x.save();
    if (id === 'rose') {
      // deep wine ground with a bloom of soft folds in the lower right
      x.fillStyle = lin(0, 0, w * 0.5, h, [[0, '#0c0305'], [0.55, '#1c060b'], [1, '#33091a']]); x.fillRect(0, 0, w, h);
      const cx = w * 0.72, cy = h * 0.66, R = M * 0.6;
      glow(cx, cy, R * 1.15, '226,92,116', 0.5);
      const N = 14;
      for (let k = 0; k < N; k++) {
        const f = 1 - k / N;
        const r1 = R * (0.12 + 0.88 * f) * (0.96 + 0.08 * rnd());
        const r0 = r1 * (0.5 + 0.18 * rnd());
        const a0 = k * 2.31 + rnd() * 0.6, sweep = 2.2 + 1.5 * rnd();
        const lift = 0.62 + 0.38 * f; // outer folds a little darker, the heart lighter
        fold(x, cx, cy, r0, r1, a0, sweep, k * 0.41, 1.16, 0.84, k, {
          light: `rgba(${Math.round(255)},${Math.round(206 + 20 * (1 - f))},${Math.round(212 + 18 * (1 - f))},1)`,
          mid: `rgba(${Math.round(232 * lift + 20)},${Math.round(120 * lift + 24)},${Math.round(136 * lift + 24)},1)`,
          deep: `rgba(${Math.round(150 * lift)},${Math.round(36 * lift)},${Math.round(58 * lift)},1)`,
          edge: 'rgba(255,238,241,0.6)', shadow: 'rgba(30,0,6,0.6)', m,
        });
      }
    } else if (id === 'aurora') {
      x.fillStyle = lin(0, 0, 0, h, [[0, '#04060d'], [1, '#0a0f22']]); x.fillRect(0, 0, w, h);
      x.globalCompositeOperation = 'lighter';
      glow(w * 0.16, h * 0.24, M * 0.56, '32,201,170', 0.55);
      glow(w * 0.9, h * 0.32, M * 0.5, '112,82,255', 0.5);
      glow(w * 0.55, h * 0.8, M * 0.56, '38,108,255', 0.42);
      glow(w * 0.04, h * 0.86, M * 0.34, '60,222,124', 0.26);
      x.globalCompositeOperation = 'source-over';
      silk(x, w, h, m, 7, 0.32, 0.11, 'rgba(210,255,246,', 0.14, 0.42);
    } else if (id === 'dune') {
      x.fillStyle = lin(0, 0, 0, h, [[0, '#fbeee3'], [0.45, '#f6d6bd'], [1, '#e8b08c']]); x.fillRect(0, 0, w, h);
      glow(w * 0.76, h * 0.2, m * 0.6, '255,247,236', 0.95);
      const layers = ['#efc2a0', '#e6ad86', '#db976d', '#cd8158', '#bd6c46', '#a85a39'];
      layers.forEach((c, i) => {
        const base = h * (0.4 + i * 0.1), amp = h * (0.055 + 0.012 * i), ph = i * 1.7;
        x.beginPath(); x.moveTo(0, h);
        x.lineTo(0, base + amp * Math.sin(ph));
        for (let s = 1; s <= 24; s++) {
          const t = s / 24, px = w * t;
          const py = base + amp * Math.sin(ph + t * 3.3) + amp * 0.45 * Math.sin(ph * 2 + t * 7.1);
          x.lineTo(px, py);
        }
        x.lineTo(w, h); x.closePath();
        x.fillStyle = lin(0, base - amp, 0, base + h * 0.22, [[0, shade(c, 0.06)], [1, shade(c, -0.2)]]);
        x.save(); x.shadowColor = 'rgba(120,60,30,0.25)'; x.shadowBlur = m * 0.04; x.shadowOffsetY = -m * 0.01; x.fill(); x.restore();
        x.strokeStyle = 'rgba(255,248,240,0.5)'; x.lineWidth = Math.max(1, m * 0.0022);
        x.beginPath();
        for (let s = 0; s <= 24; s++) {
          const t = s / 24, px = w * t;
          const py = base + amp * Math.sin(ph + t * 3.3) + amp * 0.45 * Math.sin(ph * 2 + t * 7.1);
          s ? x.lineTo(px, py) : x.moveTo(px, py);
        }
        x.stroke();
      });
    } else if (id === 'mist') {
      x.fillStyle = lin(0, 0, 0, h, [[0, '#f3f5f9'], [1, '#d6dde8']]); x.fillRect(0, 0, w, h);
      glow(w * 0.18, h * 0.3, M * 0.5, '214,200,242', 0.85);
      glow(w * 0.86, h * 0.62, M * 0.55, '172,198,232', 0.8);
      glow(w * 0.5, h * 0.06, M * 0.4, '255,255,255', 0.9);
      glow(w * 0.28, h * 0.92, M * 0.38, '242,212,214', 0.6);
      silk(x, w, h, m, 9, 0.2, 0.08, 'rgba(255,255,255,', 0.2, 0.6);
    }
    x.restore();
  }
  // one crescent fold of the rose: tapered ends, lighter rim, soft shadow beneath, a thin highlight on the edge
  function fold(x, cx, cy, r0, r1, a0, sweep, rot, ex, ey, k, c) {
    const S = 72, cr = Math.cos(rot), sr = Math.sin(rot);
    const P = (ang, r) => { const px = Math.cos(ang) * r * ex, py = Math.sin(ang) * r * ey; return [cx + px * cr - py * sr, cy + px * sr + py * cr]; };
    const wob = t => 1 + 0.045 * Math.sin(t * Math.PI * 3 + k);
    const outer = [], inner = [];
    for (let i = 0; i <= S; i++) {
      const t = i / S, a = a0 + sweep * t, thick = (r1 - r0) * Math.pow(Math.sin(Math.PI * t), 0.65);
      outer.push(P(a, r1 * wob(t)));
      inner.push(P(a, r1 * wob(t) - thick));
    }
    x.beginPath();
    outer.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py)));
    for (let i = inner.length - 1; i >= 0; i--) x.lineTo(inner[i][0], inner[i][1]);
    x.closePath();
    const g = x.createRadialGradient(cx, cy, r0 * 0.55, cx, cy, r1 * 1.06);
    g.addColorStop(0, c.deep); g.addColorStop(0.68, c.mid); g.addColorStop(1, c.light);
    x.save(); x.shadowColor = c.shadow; x.shadowBlur = Math.max(8, r1 * 0.1); x.shadowOffsetY = r1 * 0.025; x.fillStyle = g; x.fill(); x.restore();
    x.beginPath();
    outer.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py)));
    x.strokeStyle = c.edge; x.lineWidth = Math.max(1, c.m * 0.0018); x.stroke();
  }
  // flowing satin bands: wide faint strokes with a thin bright line through each
  function silk(x, w, h, m, n, top, gap, rgbaPrefix, wideA, thinA) {
    for (let i = 0; i < n; i++) {
      const y0 = h * (top + gap * i), amp = h * (0.05 + 0.015 * (i % 3)), ph = i * 1.3;
      const path = () => {
        x.beginPath();
        for (let s = 0; s <= 40; s++) {
          const t = s / 40, px = -w * 0.05 + w * 1.1 * t, py = y0 + amp * Math.sin(ph + t * 4.2) + amp * 0.35 * Math.sin(ph * 1.7 + t * 9);
          s ? x.lineTo(px, py) : x.moveTo(px, py);
        }
      };
      path(); x.strokeStyle = `${rgbaPrefix}${wideA})`; x.lineWidth = m * 0.07; x.lineCap = 'round'; x.stroke();
      path(); x.strokeStyle = `${rgbaPrefix}${thinA})`; x.lineWidth = Math.max(1, m * 0.0016); x.stroke();
    }
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16), f = v => Math.max(0, Math.min(255, Math.round(v * (1 + amt))));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  /* ---------- the color along the top of the picture, as it sits on this screen, after the tint ---------- */
  function topColor(src, sw, sh, theme) {
    const bw = layer.clientWidth || innerWidth, bh = layer.clientHeight || innerHeight;
    const s = Math.max(bw / sw, bh / sh), vw = bw / s, vh = bh / s;
    const sx = (sw - vw) / 2, sy = (sh - vh) / 2;
    const c = document.createElement('canvas'); c.width = 32; c.height = 2;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(src, sx, sy, vw, Math.max(1, vh * 0.012), 0, 0, 32, 2);
    const d = x.getImageData(0, 0, 32, 2).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    const [qr, qg, qb, a] = SCRIM[theme];
    const mix = (v, q) => Math.round((v / n) * (1 - a) + q * a);
    return '#' + [mix(r, qr), mix(g, qg), mix(b, qb)].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  const loadImg = url => new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = url; });
  async function source(id) {
    if (id.startsWith('photo')) {
      const blob = await idb.get('wallPhoto');
      if (!blob) return null;
      const url = URL.createObjectURL(blob), img = await loadImg(url);
      return { url, el: img, w: img.naturalWidth, h: img.naturalHeight };
    }
    if (!PRESETS.some(p => p.id === id)) return null;
    const bw = layer.clientWidth || innerWidth, bh = layer.clientHeight || innerHeight;
    const scale = Math.min(Math.min(1.5, window.devicePixelRatio || 1), 2200 / Math.max(bw, bh));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bw * scale)); cv.height = Math.max(1, Math.round(bh * scale));
    paint(id, cv);
    const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.9));
    if (!blob) return null;
    return { url: URL.createObjectURL(blob), el: cv, w: cv.width, h: cv.height };
  }

  /* ---------- put the chosen look on screen ---------- */
  let turn = 0;
  async function apply() {
    const theme = themeNow(), my = ++turn;
    root.setAttribute('data-theme', theme);
    if (wall === 'none') {
      root.removeAttribute('data-wall');
      layer.classList.remove('on');
      setChrome(null);
      setTimeout(() => { if (my === turn && wall === 'none' && shown) { layer.style.backgroundImage = ''; URL.revokeObjectURL(shown.url); shown = null; } }, 500);
      refresh();
      return;
    }
    root.setAttribute('data-wall', '');
    const cached = get(`pos.chrome|${theme}|${wall}`);
    if (cached) setChrome(cached);
    const width = layer.clientWidth;
    const fresh = !shown || shown.id !== wall || (!wall.startsWith('photo') && shown.width !== width);
    if (fresh) {
      let s = null;
      try { s = await source(wall); } catch (e) { s = null; }
      if (my !== turn) { if (s) URL.revokeObjectURL(s.url); return; }
      if (!s) {
        wall = 'none'; put('pos.wall', null);
        toast('That wallpaper could not be loaded, so POS went back to no wallpaper.');
        return apply();
      }
      if (shown) URL.revokeObjectURL(shown.url);
      shown = { ...s, id: wall, width };
      layer.style.backgroundImage = `url("${s.url}")`;
    }
    layer.classList.add('on');
    let c = null;
    try { c = topColor(shown.el, shown.w, shown.h, theme); } catch (e) { c = cached || BASE[theme]; }
    put(`pos.chrome|${theme}|${wall}`, c);
    setChrome(c);
    refresh();
  }

  /* ---------- Settings: the mode switch and the wallpaper picker ---------- */
  const PLUS = '<span class="plus"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg></span>';
  let built = false;
  function build() {
    const box = $('#wallOpts');
    if (!box) return;
    const opt = (id, name, inner) => `<button type="button" class="wall-opt" role="radio" aria-checked="false" data-act="wall" data-wallid="${id}"><span class="wsw">${inner}</span>${name}</button>`;
    box.innerHTML = opt('none', 'None', '')
      + PRESETS.map(p => opt(p.id, p.name, `<canvas width="128" height="184" data-preset="${p.id}"></canvas>`)).join('')
      + opt('photo', 'Photo', PLUS);
    for (const cv of box.querySelectorAll('canvas[data-preset]')) paint(cv.dataset.preset, cv);
    built = true;
  }
  function refresh() {
    if (!$('#wallOpts')) return;
    if (!built) build();
    const cur = wall.startsWith('photo') ? 'photo' : wall;
    for (const b of document.querySelectorAll('[data-act="mode"]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    for (const b of document.querySelectorAll('[data-act="wall"]')) b.setAttribute('aria-checked', String(b.dataset.wallid === cur));
    const ph = document.querySelector('[data-wallid="photo"] .wsw');
    if (ph) {
      const want = photoURL ? `<img src="${photoURL}" alt="">` : PLUS;
      if (ph.dataset.src !== (photoURL || '')) { ph.innerHTML = want; ph.dataset.src = photoURL || ''; }
    }
    $('#wallRemove').hidden = wall === 'none';
    $('#wallPick').textContent = photoURL ? 'Choose a different photo' : 'Choose a photo';
    $('#wallNote').textContent = wall === 'none' ? 'None' : wall.startsWith('photo') ? 'Your photo' : (PRESETS.find(p => p.id === wall) || {}).name || '';
  }
  function setWall(id) {
    wall = id;
    put('pos.wall', id === 'none' ? null : id);
    apply();
  }
  function pick() { const f = $('#wallFile'); f.value = ''; f.click(); }
  // a phone photo is shrunk to at most 2400 px on its long side before it's saved, so it loads fast
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImg(url);
      const s = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.naturalWidth * s)); cv.height = Math.max(1, Math.round(img.naturalHeight * s));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      return await new Promise((res, rej) => cv.toBlob(b => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.86));
    } finally { URL.revokeObjectURL(url); }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-act="mode"],[data-act="wall"]');
    if (!b) return;
    if (b.dataset.act === 'mode') { mode = b.dataset.mode; put('pos.mode', mode); apply(); return; }
    const id = b.dataset.wallid;
    if (id === 'photo') { if (photoURL && photoKey) setWall(photoKey); else pick(); return; }
    setWall(id);
  });
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  on('#wallPick', 'click', pick);
  on('#wallRemove', 'click', () => setWall('none'));
  on('#wallFile', 'change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const blob = await shrink(file);
      await idb.set('wallPhoto', blob);
      if (photoURL) URL.revokeObjectURL(photoURL);
      photoURL = URL.createObjectURL(blob);
      if (photoKey) for (const t of ['dark', 'light']) put(`pos.chrome|${t}|${photoKey}`, null);
      photoKey = 'photo:' + Date.now().toString(36);
      put('pos.photoKey', photoKey);
      setWall(photoKey);
    } catch (err) {
      toast('That picture could not be used. Try a JPEG or PNG photo.');
    }
  });

  // Automatic follows the device; a rotation or window resize re-fits the wallpaper and re-reads its top color
  if (window.matchMedia) {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const fn = () => { if (mode === 'auto') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
  }
  let rt = null;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (wall !== 'none') apply(); }, 250); });

  (async () => {
    try { const blob = await idb.get('wallPhoto'); if (blob) photoURL = URL.createObjectURL(blob); } catch (e) {}
    refresh();
  })();
  apply();

  return { apply, refresh, setToast: fn => { toast = fn; }, paint, presets: PRESETS };
})();
