// POS Lights: rooms, and the lights in each. Pick one light or the whole room, then set it on or off, its brightness,
// and its tone from deep red to daylight (1000–6500K). A light with a node is a real Oasis light: POS reads and sets it
// through the lights edge function (which holds the Oasis key); a light without one is just controls.
// Records: kind "room" { name, createdAt }, kind "light" { roomId, name, type, brand, node, on, level 0-100, mode 'white'|'color', kelvin, hue, createdAt }.
window.POSLights = function (ctx) {
  const { esc, toast } = ctx;
  const R = window.POSRecords({ ...ctx, onLoad: () => overlay() }, ['room', 'light'], 'pos-lights');
  const S = R.S;
  const KMIN = 1000, KMAX = 6500;
  const TYPES = [['uplight', 'Wall uplight'], ['bulb', 'Lamp bulb'], ['ceiling', 'Ceiling light'], ['strip', 'Light strip'], ['other', 'Other']];
  const HUES = [[0, 'Red'], [22, 'Orange'], [40, 'Amber'], [56, 'Yellow'], [95, 'Lime'], [135, 'Green'], [170, 'Teal'], [192, 'Cyan'], [218, 'Blue'], [250, 'Indigo'], [280, 'Purple'], [305, 'Magenta'], [330, 'Pink']];
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    uplight: svg('<path d="M7.5 13.5h9l-1.6 4.5H9.1z"/><path d="M12 4v5.5M7.4 5.6l1.7 4.2M16.6 5.6l-1.7 4.2"/>'),
    bulb: svg('<path d="M9 17.5h6M10 20.5h4M12 3.5a5.5 5.5 0 0 0-3.2 10c.7.5 1.2 1.3 1.2 2.1v.4h4v-.4c0-.8.5-1.6 1.2-2.1A5.5 5.5 0 0 0 12 3.5z"/>'),
    ceiling: svg('<path d="M12 3.5v4M5.5 14a6.5 6.5 0 0 1 13 0z"/><path d="M10.3 17a1.7 1.7 0 0 0 3.4 0"/>'),
    strip: svg('<rect x="3.5" y="9.5" width="17" height="5" rx="2.5"/><path d="M7.5 12h.01M12 12h.01M16.5 12h.01"/>'),
    other: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6"/>'),
    room: svg('<path d="M6.5 20.5v-15A1.5 1.5 0 0 1 8 4h8a1.5 1.5 0 0 1 1.5 1.5v15M4.5 20.5h15M14 12.5v.01"/>'),
    bed: svg('<path d="M3.5 18.5v-6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v6M3.5 15.5h17M6.5 10.5V8a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 17.5 8v2.5"/>'),
    power: svg('<path d="M12 4v7"/><path d="M7.3 7.3a6.5 6.5 0 1 0 9.4 0"/>'),
    chev: svg('<path d="M9.5 6.5 15 12l-5.5 5.5"/>'),
    edit: svg('<path d="M4.5 19.5h3.6L19 8.6 15.4 5 4.5 15.9zM13.6 6.8l3.6 3.6"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
  };

  /* ---------- color ---------- */
  // a color temperature as the light it gives (Tanner Helland's fit of the blackbody curve)
  function kRGB(k) {
    const t = k / 100;
    let r, g, b;
    if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307; }
    else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); b = 255; }
    const c = x => Math.max(0, Math.min(255, Math.round(x)));
    return [c(r), c(g), c(b)];
  }
  function hRGB(h, s = 100, l = 56) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map(x => Math.round(x * 255));
  }
  const rgbOf = l => (l.mode === 'color' ? hRGB(l.hue || 0, l.sat ?? 100) : kRGB(l.kelvin || 2700));
  const css = (c, a) => (a == null ? `rgb(${c.join(',')})` : `rgba(${c.join(',')},${a})`);
  const kName = k => (k < 1300 ? 'Deep red' : k < 1800 ? 'Amber' : k < 2500 ? 'Candlelight' : k < 3200 ? 'Warm white' : k < 4200 ? 'Neutral white' : k < 5500 ? 'Cool white' : 'Daylight');
  const hName = h => HUES.reduce((best, x) => { const d = Math.min(Math.abs(x[0] - h), 360 - Math.abs(x[0] - h)); return d < best.d ? { d, n: x[1] } : best; }, { d: 999, n: '' }).n;
  const K_TRACK = `linear-gradient(90deg,${[1000, 1500, 2000, 2700, 3500, 4500, 5500, 6500].map(k => css(kRGB(k))).join(',')})`;
  const H_TRACK = `linear-gradient(90deg,${[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360].map(h => css(hRGB(h))).join(',')})`;

  /* ---------- state ---------- */
  const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  const rooms = () => S.room.slice().sort(byCreated);
  const lightsIn = id => S.light.filter(l => l.roomId === id).sort(byCreated);
  const loose = () => S.light.filter(l => !S.room.some(r => r.id === l.roomId)).sort(byCreated);
  const lightById = id => S.light.find(l => l.id === id);
  const UI = { shut: new Set(), sel: {} };
  try { UI.shut = new Set(JSON.parse(localStorage.getItem('pos.lights.shut') || '[]')); } catch (e) {}
  const keepShut = () => { try { localStorage.setItem('pos.lights.shut', JSON.stringify([...UI.shut])); } catch (e) {} };
  const isOn = l => !!l.on && (l.level ?? 100) > 0;
  // what the room's controls show: the first light that's on, or the first light
  const lead = list => list.find(isOn) || list[0];
  const selOf = room => { const id = UI.sel[room.id]; return id && lightById(id) && lightById(id).roomId === room.id ? lightById(id) : null; };

  /* ---------- the real lights (Oasis cloud, through the lights function) ---------- */
  // what each light last told us, by node; a light we just changed keeps our values for a few seconds
  // (the cloud takes a moment to catch up, and an older answer would flick the controls back)
  const CL = { nodes: new Map(), at: 0, asking: false, expired: false, down: false };
  const held = new Map();
  const nodeOf = l => (l && l.node ? CL.nodes.get(l.node) : null);
  const offline = l => { const n = nodeOf(l); return !!(n && n.online === false); };
  function overlay() {
    for (const l of S.light) {
      const n = nodeOf(l);
      if (!n || (held.get(l.node) || 0) > Date.now()) continue;
      l.on = n.on;
      if (Number.isFinite(n.level)) l.level = n.level;
      if (Number.isFinite(n.kelvin)) { l.kelvin = Math.max(KMIN, Math.min(KMAX, n.kelvin)); l.mode = 'white'; }
    }
  }
  const call = async body => {
    const { data, error } = await ctx.sb.functions.invoke('lights', { body });
    if (error) throw error;
    return data || {};
  };
  async function pull() {
    if (CL.asking || !ctx.canSave() || !S.light.some(l => l.node)) return;
    CL.asking = true;
    try {
      const d = await call({ action: 'state' });
      CL.expired = !!d.expired; CL.down = false; CL.at = Date.now();
      if (Array.isArray(d.nodes)) { CL.nodes = new Map(d.nodes.map(n => [n.id, n])); overlay(); }
    } catch (e) { CL.down = true; CL.at = Date.now(); }
    CL.asking = false;
    ctx.rerender();
  }
  // what a light needs sent: only what differs from what it last said
  function paramsFor(l) {
    const n = nodeOf(l) || {}, p = {};
    if (!isOn(l)) { if (n.on !== false) p.Power = false; return p; }
    if (n.on !== true) p.Power = true;
    const lv = Math.max(1, Math.min(100, Math.round(l.level ?? 100))), k = Math.max(KMIN, Math.min(KMAX, Math.round(l.kelvin || 2700)));
    if (n.level !== lv) p.Brightness = lv;
    if (n.kelvin !== k) p.CCT = k;
    return p;
  }
  let sending = false, queued = null;
  async function push(list) {
    list = list.filter(l => l && l.node);
    if (!list.length || !ctx.canSave()) return;
    if (sending) { queued = new Set([...(queued || []), ...list]); return; }
    const items = list.map(l => ({ id: l.node, params: paramsFor(l), l })).filter(x => Object.keys(x.params).length);
    if (!items.length) return;
    sending = true;
    for (const x of items) {
      held.set(x.id, Date.now() + 8000);
      const n = CL.nodes.get(x.id) || { id: x.id };
      CL.nodes.set(x.id, { ...n, ...(x.params.Power !== undefined ? { on: x.params.Power } : {}), ...(x.params.Brightness !== undefined ? { level: x.params.Brightness } : {}), ...(x.params.CCT !== undefined ? { kelvin: x.params.CCT } : {}) });
    }
    try {
      const d = await call({ action: 'set', items: items.map(({ id, params }) => ({ id, params })) });
      if (d.expired) { CL.expired = true; toast("The lights' sign-in ran out."); ctx.rerender(); }
      else if (CL.expired || CL.down) { CL.expired = false; CL.down = false; ctx.rerender(); }
    } catch (e) {
      CL.down = true; toast("The lights didn't answer.");
      for (const x of items) held.delete(x.id);
      CL.at = 0; ctx.rerender();
    }
    sending = false;
    if (queued) { const q = [...queued]; queued = null; push(q); }
  }
  // while a slider is held, send at most every 0.4s
  let pushT = null, pushList = null;
  function pushSoon(list) {
    pushList = list;
    if (pushT) return;
    pushT = setTimeout(() => { pushT = null; const l = pushList; pushList = null; push(l); }, 400);
  }
  // ask again every 20s while the lights are on screen
  let pollT = null;
  const poll = () => { if (document.visibilityState === 'visible' && document.querySelector('.lights') && Date.now() - CL.at > 15000) pull(); };

  /* ---------- markup ---------- */
  function stateText(l) {
    if (offline(l)) return 'Offline';
    if (!isOn(l)) return 'Off';
    return `${l.level ?? 100}% · ${l.mode === 'color' ? hName(l.hue || 0) : `${l.kelvin || 2700}K`}`;
  }
  function glowVars(l) {
    const c = rgbOf(l), lv = isOn(l) ? (l.level ?? 100) / 100 : 0;
    return `--lc:${css(c)};--lg:${css(c, (0.1 + lv * 0.28).toFixed(3))};--ls:${css(c, (0.35 + lv * 0.5).toFixed(3))};--ll:${lv.toFixed(2)}`;
  }
  function tile(l, sel) {
    const on = isOn(l);
    return `<div class="lt-tile${on ? ' on' : ''}${sel ? ' sel' : ''}" data-light="${esc(l.id)}" style="${glowVars(l)}">
      <button type="button" class="lt-pick" data-act="lt-pick" data-room="${esc(l.roomId)}" data-id="${esc(l.id)}" aria-pressed="${sel}"><span class="lt-dot">${ICON[l.type] || ICON.other}</span><span class="lt-tx"><span class="name">${esc(l.name)}</span><span class="meta" data-st>${esc(stateText(l))}</span></span></button>
      <button type="button" class="lt-pow" data-act="lt-power" data-id="${esc(l.id)}" aria-pressed="${on}" aria-label="${esc(l.name)} ${on ? 'off' : 'on'}">${ICON.power}</button>
    </div>`;
  }
  function roomTile(room, list, sel) {
    const n = list.filter(isOn).length, l = lead(list) || {};
    return `<div class="lt-tile all${n ? ' on' : ''}${sel ? ' sel' : ''}" style="${list.length ? glowVars(n ? l : { ...l, on: false }) : ''}">
      <button type="button" class="lt-pick" data-act="lt-pick" data-room="${esc(room.id)}" data-id="" aria-pressed="${sel}"><span class="lt-dot">${/bed/i.test(room.name) ? ICON.bed : ICON.room}</span><span class="lt-tx"><span class="name">Whole room</span><span class="meta" data-st>${list.length ? `${n} of ${list.length} on` : 'No lights yet'}</span></span></button>
      ${list.length ? `<button type="button" class="lt-pow" data-act="lt-power" data-room="${esc(room.id)}" aria-pressed="${!!n}" aria-label="Whole room ${n ? 'off' : 'on'}">${ICON.power}</button>` : ''}
    </div>`;
  }
  const slider = (key, label, val, min, max, step) => `<div class="lt-sl lt-${key}" role="slider" tabindex="0" aria-label="${label}" data-lt="${key}" data-min="${min}" data-max="${max}" data-step="${step}" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${val}" style="--p:${((val - min) / (max - min)).toFixed(4)}"><i></i></div>`;
  function panel(room, list) {
    const one = selOf(room), l = one || lead(list);
    if (!l) return '';
    const on = one ? isOn(one) : list.some(isOn);
    const level = l.level ?? 100, kelvin = l.kelvin || 2700, hue = l.hue || 0, color = l.mode === 'color';
    const type = one ? (TYPES.find(t => t[0] === one.type) || TYPES[4])[1] : null;
    const real = (one ? [one] : list).some(x => x.node); // the Oasis lights take a tone, not a color
    return `<div class="lt-panel" data-room="${esc(room.id)}" data-light="${one ? esc(one.id) : ''}" style="${glowVars({ ...l, on })};--k-track:${K_TRACK};--h-track:${H_TRACK}">
      <div class="lt-ph">
        <div class="lt-pt"><span class="lab">${one ? esc([one.brand, type].filter(Boolean).join(' · ')) : `${list.length} ${list.length === 1 ? 'light' : 'lights'}`}</span><span class="lt-pn">${esc(one ? one.name : 'Whole room')}</span></div>
        ${one && ctx.canSave() ? `<button type="button" class="circle" data-act="lt-edit" data-id="${esc(one.id)}" aria-label="Edit ${esc(one.name)}">${ICON.edit}</button>` : ''}
        <button type="button" class="switch lt-sw" role="switch" aria-checked="${on}" data-act="lt-power" ${one ? `data-id="${esc(one.id)}"` : `data-room="${esc(room.id)}"`} aria-label="${on ? 'Turn off' : 'Turn on'}"><span class="sw" aria-hidden="true"></span></button>
      </div>
      <div class="lt-ctl"><div class="lt-row"><span class="lab">Brightness</span><span class="fig" data-out="level">${on ? level + '%' : 'Off'}</span></div>${slider('level', 'Brightness', on ? level : 0, 0, 100, 1)}</div>
      <div class="lt-ctl${!color || real ? ' act' : ''}" data-mode="white"><div class="lt-row"><span class="lab">${real ? 'Tone' : 'White'}</span><span class="meta" data-out="kelvin">${kelvin}K · ${kName(kelvin)}</span></div>${slider('kelvin', 'Color temperature', kelvin, KMIN, KMAX, 100)}<div class="lt-ends"><span>Red</span><span>Daylight</span></div></div>
      ${real ? '' : `<div class="lt-ctl${color ? ' act' : ''}" data-mode="color"><div class="lt-row"><span class="lab">Color</span><span class="meta" data-out="hue">${color ? esc(hName(hue)) : 'Pick a color'}</span></div>
        <div class="lt-pal" role="group" aria-label="Colors">${HUES.map(([h, n]) => `<button type="button" class="lt-sw8" data-act="lt-hue" data-hue="${h}" style="--c:${css(hRGB(h))}" aria-pressed="${color && hName(hue) === n}" aria-label="${n}" title="${n}"></button>`).join('')}</div>
        ${slider('hue', 'Hue', hue, 0, 359, 1)}</div>`}
    </div>`;
  }
  function roomCard(room) {
    const list = lightsIn(room.id), open = !UI.shut.has(room.id), one = selOf(room), n = list.filter(isOn).length;
    return `<section class="float lt-room${open ? ' open' : ''}" data-room-card="${esc(room.id)}">
      <div class="lt-rh">
        <button type="button" class="lt-open" data-act="lt-room" data-id="${esc(room.id)}" aria-expanded="${open}"><span class="lt-ric">${/bed/i.test(room.name) ? ICON.bed : ICON.room}</span><span class="lt-tx"><span class="lt-rn">${esc(room.name)}</span><span class="meta" data-rst>${list.length ? `${n ? `${n} of ${list.length} on` : 'All off'}` : 'No lights yet'}</span></span><span class="lt-chev">${ICON.chev}</span></button>
        ${ctx.canSave() ? `<button type="button" class="circle" data-act="lt-room-edit" data-id="${esc(room.id)}" aria-label="Edit ${esc(room.name)}">${ICON.edit}</button>` : ''}
        ${list.length ? `<button type="button" class="switch lt-sw" role="switch" aria-checked="${!!n}" data-act="lt-power" data-room="${esc(room.id)}" aria-label="${esc(room.name)} ${n ? 'off' : 'on'}"><span class="sw" aria-hidden="true"></span></button>` : ''}
      </div>
      ${open ? `<div class="lt-body">
        <div class="lt-side"><div class="lt-tiles">${roomTile(room, list, !one)}${list.map(l => tile(l, one && one.id === l.id)).join('')}</div>
          ${ctx.canSave() ? `<button type="button" class="btn lt-add" data-act="lt-add" data-room="${esc(room.id)}">${ICON.plus}Add a light</button>` : ''}</div>
        ${panel(room, list)}
      </div>` : ''}
    </section>`;
  }
  function view() {
    let body;
    if (S.failed) body = '<p class="empty">Lights did not load. Check the connection; POS tries again when you come back to it.</p>';
    else if (!S.loaded) body = '<p class="empty">Loading…</p>';
    else if (!S.room.length) body = `<p class="empty">No rooms yet. Add a room, then the lights in it.</p>${ctx.canSave() ? '<div><button type="button" class="btn solid" data-act="lt-room-edit">Add a room</button></div>' : ''}`;
    else {
      const extra = loose();
      body = rooms().map(roomCard).join('')
        + (extra.length ? `<section class="sec"><div class="sec-head"><span class="lab">Not in a room</span></div><div class="lt-tiles">${extra.map(l => tile(l, false)).join('')}</div></section>` : '')
        + (ctx.canSave() ? '<div><button type="button" class="btn" data-act="lt-room-edit">Add a room</button></div>' : '');
    }
    if (S.loaded && ctx.canSave() && Date.now() - CL.at > 15000) setTimeout(pull, 0);
    const note = !S.light.some(l => l.node) ? '' : CL.expired ? "<p class=\"lt-note warn\">The lights' sign-in ran out. They'll answer again once the new key is in.</p>"
      : CL.down ? "<p class=\"lt-note warn\">The lights aren't answering right now.</p>" : '';
    return `<div class="lights">${note}<div class="lights-scroll" id="lightsScroll" data-keep>${body}</div></div>`;
  }

  /* ---------- changing lights ---------- */
  // what one light becomes when a control moves
  function patchFor(l, key, v) {
    if (key === 'level') return { level: v, on: v > 0 };
    if (key === 'kelvin') return { kelvin: v, mode: 'white', on: true, level: l.level || 100 };
    if (key === 'hue') return { hue: v, sat: 100, mode: 'color', on: true, level: l.level || 100 };
    return {};
  }
  const targetsOf = el => { const p = el.closest('.lt-panel'); return p.dataset.light ? [lightById(p.dataset.light)].filter(Boolean) : lightsIn(p.dataset.room); };
  async function commit(list, keys) {
    if (!ctx.canSave() || !list.length) return;
    clearTimeout(pushT); pushT = null; pushList = null;
    push(list);
    const ok = (await Promise.all(list.map(l => R.save(R.db.update('light', l.id, Object.fromEntries(keys.map(k => [k, l[k]]))))))).every(Boolean);
    if (!ok) R.load();
  }
  const KEYS = ['on', 'level', 'kelvin', 'hue', 'sat', 'mode'];
  async function setLights(list, fn) {
    for (const l of list) Object.assign(l, fn(l));
    await commit(list, KEYS);
  }
  // while a slider moves, repaint in place (a full redraw would drop the drag); saved when it's let go
  function paintRoom(card) {
    const room = S.room.find(r => r.id === card.dataset.roomCard);
    if (!room) return;
    const list = lightsIn(room.id), n = list.filter(isOn).length, one = selOf(room);
    card.querySelector('[data-rst]').textContent = n ? `${n} of ${list.length} on` : 'All off';
    for (const sw of card.querySelectorAll('.lt-rh .lt-sw')) sw.setAttribute('aria-checked', !!n);
    const tiles = card.querySelector('.lt-tiles');
    if (tiles) tiles.innerHTML = roomTile(room, list, !one) + list.map(l => tile(l, one && one.id === l.id)).join('');
    const p = card.querySelector('.lt-panel');
    if (!p) return;
    const l = one || lead(list), on = one ? isOn(one) : !!n, level = l.level ?? 100, kelvin = l.kelvin || 2700, hue = l.hue || 0, color = l.mode === 'color';
    p.setAttribute('style', `${glowVars({ ...l, on })};--k-track:${K_TRACK};--h-track:${H_TRACK}`);
    p.querySelector('.lt-ph .lt-sw').setAttribute('aria-checked', on);
    p.querySelector('[data-out="level"]').textContent = on ? level + '%' : 'Off';
    p.querySelector('[data-out="kelvin"]').textContent = `${kelvin}K · ${kName(kelvin)}`;
    const hueOut = p.querySelector('[data-out="hue"]'), colorCtl = p.querySelector('[data-mode="color"]');
    if (hueOut) hueOut.textContent = color ? hName(hue) : 'Pick a color';
    p.querySelector('[data-mode="white"]').classList.toggle('act', !color || !colorCtl);
    if (colorCtl) colorCtl.classList.toggle('act', color);
    for (const b of p.querySelectorAll('.lt-sw8')) b.setAttribute('aria-pressed', color && hName(hue) === b.title);
    const put = (key, v) => { const s = p.querySelector(`[data-lt="${key}"]`); if (s && s !== drag?.el) { s.style.setProperty('--p', ((v - +s.dataset.min) / (+s.dataset.max - +s.dataset.min)).toFixed(4)); s.setAttribute('aria-valuenow', v); } };
    put('level', on ? level : 0); put('kelvin', kelvin); put('hue', hue);
  }
  function move(el, v) {
    const min = +el.dataset.min, max = +el.dataset.max;
    v = Math.max(min, Math.min(max, v));
    el.style.setProperty('--p', ((v - min) / (max - min)).toFixed(4));
    el.setAttribute('aria-valuenow', v);
    const key = el.dataset.lt;
    const list = targetsOf(el);
    for (const l of list) Object.assign(l, patchFor(l, key, v));
    paintRoom(el.closest('.lt-room'));
    if (drag && drag.el === el) pushSoon(list);
  }
  const valueAt = (el, x) => {
    const r = el.getBoundingClientRect(), min = +el.dataset.min, max = +el.dataset.max, step = +el.dataset.step;
    const p = Math.max(0, Math.min(1, (x - r.left - 17) / Math.max(1, r.width - 34)));
    return Math.round((min + p * (max - min)) / step) * step;
  };
  let drag = null;
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest && e.target.closest('.lt-sl');
    if (!el || !ctx.canSave() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    drag = { el, id: e.pointerId, list: targetsOf(el) };
    el.classList.add('held');
    move(el, valueAt(el, e.clientX));
  });
  document.addEventListener('pointermove', e => { if (drag && e.pointerId === drag.id) move(drag.el, valueAt(drag.el, e.clientX)); });
  const letGo = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    d.el.classList.remove('held');
    commit(d.list, KEYS);
  };
  document.addEventListener('pointerup', letGo);
  document.addEventListener('pointercancel', letGo);
  // keyboard: arrows nudge, Page keys jump, Home/End go to the ends; saved a moment after the last key
  let keyT = null;
  document.addEventListener('keydown', e => {
    const el = e.target.closest && e.target.closest('.lt-sl');
    if (!el || !ctx.canSave()) return;
    const step = +el.dataset.step, min = +el.dataset.min, max = +el.dataset.max, cur = +el.getAttribute('aria-valuenow');
    const big = Math.max(step, Math.round((max - min) / 10 / step) * step);
    const to = { ArrowLeft: cur - step, ArrowDown: cur - step, ArrowRight: cur + step, ArrowUp: cur + step, PageDown: cur - big, PageUp: cur + big, Home: min, End: max }[e.key];
    if (to == null) return;
    e.preventDefault();
    const list = targetsOf(el);
    move(el, to);
    clearTimeout(keyT);
    keyT = setTimeout(() => commit(list, KEYS), 500);
  });
  const busy = () => !!drag;

  /* ---------- forms ---------- */
  const f = (label, inner) => `<label class="f"><span class="lab">${label}</span>${inner}</label>`;
  const val = id => (document.getElementById(id) || {}).value?.trim() || '';
  function openRoom(id) {
    const r = id ? S.room.find(x => x.id === id) : null;
    const n = r ? lightsIn(r.id).length : 0;
    window.POSSheet.open({
      title: r ? r.name : 'Add a room',
      body: f('Room name', `<input id="lr_name" maxlength="40" autocomplete="off" placeholder="Living room" value="${esc(r ? r.name : '')}">`),
      delLabel: n ? `Delete room and its ${n} ${n === 1 ? 'light' : 'lights'}` : 'Delete room',
      remove: r ? async () => {
        const ok = (await Promise.all([R.save(R.db.remove('room', r.id)), ...lightsIn(r.id).map(l => R.save(R.db.remove('light', l.id)))])).every(Boolean);
        if (ok) toast(`${r.name} deleted`);
        return ok;
      } : null,
      submit: async () => {
        const name = val('lr_name');
        if (!name) return 'Give the room a name.';
        if (r) return R.save(R.db.update('room', r.id, { name }));
        const nid = R.newId('room');
        const ok = await R.save(R.db.set('room', nid, { name, createdAt: Date.now() }));
        if (ok) { toast(`${name} added. Add its lights next.`); openLight(null, nid); return false; }
        return ok;
      },
    });
  }
  function openLight(id, roomId) {
    const l = id ? lightById(id) : null;
    const rid = l ? l.roomId : roomId || (rooms()[0] || {}).id;
    const opt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
    window.POSSheet.open({
      title: l ? l.name : 'Add a light',
      body: f('Name', `<input id="ll_name" maxlength="40" autocomplete="off" placeholder="Desk lamp" value="${esc(l ? l.name : '')}">`)
        + `<div class="two">${f('Kind', `<select id="ll_type">${TYPES.map(([k, t]) => opt(k, t, l ? l.type === k : k === 'bulb')).join('')}</select>`)}${f('Brand', `<input id="ll_brand" maxlength="30" placeholder="Oasis" value="${esc(l ? l.brand || '' : 'Oasis')}">`)}</div>`
        + f('Room', `<select id="ll_room">${rooms().map(r => opt(r.id, r.name, r.id === rid)).join('')}</select>`),
      remove: l ? async () => { const ok = await R.save(R.db.remove('light', l.id)); if (ok) { toast(`${l.name} removed`); if (UI.sel[l.roomId] === l.id) UI.sel[l.roomId] = ''; } return ok; } : null,
      submit: async () => {
        const name = val('ll_name'), roomId2 = val('ll_room');
        if (!name) return 'Give the light a name.';
        if (!roomId2) return 'Add a room first.';
        const d = { name, type: val('ll_type') || 'other', brand: val('ll_brand'), roomId: roomId2 };
        if (l) return R.save(R.db.update('light', l.id, d));
        const ok = await R.save(R.db.set('light', R.newId('light'), { ...d, on: false, level: 100, mode: 'white', kelvin: 2700, hue: 30, sat: 100, createdAt: Date.now() }));
        if (ok) { UI.shut.delete(roomId2); keepShut(); toast(`${name} added`); }
        return ok;
      },
    });
  }

  /* ---------- taps routed here by POS (data-act="lt-…") ---------- */
  function act(name, b) {
    if (name === 'lt-room') {
      const id = b.dataset.id;
      if (UI.shut.has(id)) UI.shut.delete(id); else UI.shut.add(id);
      keepShut(); ctx.rerender();
    } else if (name === 'lt-pick') {
      UI.sel[b.dataset.room] = b.dataset.id || ''; ctx.rerender();
    } else if (!ctx.canSave()) {
      return;
    } else if (name === 'lt-power') {
      if (b.dataset.id) { const l = lightById(b.dataset.id); if (l) { const on = !isOn(l); setLights([l], x => ({ on, level: on && !x.level ? 100 : x.level })); } }
      else { const list = lightsIn(b.dataset.room), on = !list.some(isOn); setLights(list, x => ({ on, level: on && !x.level ? 100 : x.level })); }
    } else if (name === 'lt-hue') {
      const p = b.closest('.lt-panel'), hue = +b.dataset.hue;
      setLights(p.dataset.light ? [lightById(p.dataset.light)].filter(Boolean) : lightsIn(p.dataset.room), l => patchFor(l, 'hue', hue));
    } else if (name === 'lt-edit') openLight(b.dataset.id);
    else if (name === 'lt-add') openLight(null, b.dataset.room);
    else if (name === 'lt-room-edit') openRoom(b.dataset.id);
  }
  const add = () => (S.room.length ? openLight(null, rooms()[0].id) : openRoom(null));
  function start() { R.start(); clearInterval(pollT); pollT = setInterval(poll, 5000); CL.at = 0; }
  function stop() { R.stop(); clearInterval(pollT); pollT = null; CL.nodes = new Map(); CL.at = 0; CL.expired = false; CL.down = false; }
  return { view, act, add, busy, start, stop };
};
