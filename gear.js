// POS Gear, sorted the way the production team thinks: Audio, Video and Lighting, each split into areas
// (Video › Broadcast) and what's in them (Broadcast › Cameras, 3D cam plot). Cameras is the broadcast gear list. One entry per camera: whether it's in the broadcast, what it does (when in the
// service it's used, its job, how it's rigged, where it sits and how far from the speaker), every part on it (body,
// lens, matte box, monitor and whatever else rides along) and its signal path: what goes out of what, on which cable,
// into what. Compare puts every camera side by side, and the sensor mix shows how much of the broadcast is which sensor.
// Records: kind "gear-cam" { name, status: 'in'|'out', uses: ['worship','host','message'], job, rig, where, dist, notes, pos,
//   parts: [{ id, role, make, model, serial, notes, sensor, size, mount, range }], links: [{ id, from, cable, len, to, notes }] }.
window.POSGear = function (ctx) {
  const { esc, toast } = ctx;
  const KIND = 'gear-cam';
  const R = window.POSRecords(ctx, [KIND], 'pos-gear');
  const S = R.S;
  const UI = { sel: null };
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    cam: svg('<rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 10.5 5-3v9l-5-3"/><circle cx="9.5" cy="12" r="2.2"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    left: svg('<path d="m14.5 6.5-5.5 5.5 5.5 5.5"/>'),
    chev: svg('<path d="M9.5 6.5 15 12l-5.5 5.5"/>'),
    trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>'),
    arrow: svg('<path d="M12 5v14M7 14l5 5 5-5"/>'),
    cube: svg('<path d="M12 3.5 19.5 7.5v9L12 20.5 4.5 16.5v-9z"/><path d="M4.5 7.5 12 11.5l7.5-4M12 11.5v9"/>'),
    tower: svg('<path d="M12 10v10.5M8.5 20.5h7"/><circle cx="12" cy="8" r="2"/><path d="M8 4.5a5 5 0 0 0 0 7M16 4.5a5 5 0 0 1 0 7"/>'),
  };
  // the parts a camera is described by, in this order; the first four are always shown, even before they're filled in
  const ROLES = ['Body', 'Lens', 'Matte box', 'Monitor', 'Rigging', 'Support', 'Power', 'Converter', 'Comms', 'Other'];
  const CORE = ROLES.slice(0, 4);
  const CABLES = ['SDI', '12G-SDI', '6G-SDI', '3G-SDI', 'HD-SDI', 'HDMI', 'SMPTE fiber', 'Fiber', 'Ethernet', 'USB-C', 'XLR', 'Power', 'Other'];
  const USES = [['worship', 'Worship'], ['host', 'Host'], ['message', 'Message']];
  const RIGS = ['Tripod', 'Easyrig', 'Handheld', 'Gimbal', 'Jib', 'Dolly', 'PTZ', 'Other'];
  const SENSORS = ['2/3"', '1"', 'Micro Four Thirds', 'Super 35', 'Full frame', 'Other'];
  // bodies POS knows: picking one fills in its sensor and mount (from the maker's spec sheets)
  const BODIES = [
    { re: /ursa\s*broadcast\s*g2/i, sensor: 'Super 35', size: '6K Super 35', mount: 'B4 (EF, PL, F optional)' },
    { re: /ursa\s*broadcast/i, sensor: '2/3"', size: '2/3" B4 format, 4K (sensor 13.056 × 7.344 mm)', mount: 'B4 2/3"' },
    { re: /\bfx30\b/i, sensor: 'Super 35', size: '23.3 × 15.5 mm (APS-C)', mount: 'Sony E' },
  ];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const cams = () => S[KIND].slice().sort((a, b) => (a.pos ?? 1e12) - (b.pos ?? 1e12) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  const camById = id => S[KIND].find(c => c.id === id) || null;
  const partsOf = c => (Array.isArray(c.parts) ? c.parts : []);
  const linksOf = c => (Array.isArray(c.links) ? c.links : []);
  const usesOf = c => (Array.isArray(c.uses) ? c.uses : []);
  const inUse = c => c.status !== 'out';
  const label = p => [p.make, p.model].filter(Boolean).join(' ') || p.notes || 'Not filled in';
  const partName = p => `${p.role}${p.make || p.model ? ` (${[p.make, p.model].filter(Boolean).join(' ')})` : ''}`;
  const part = (c, role) => partsOf(c).find(p => p.role === role) || null;
  const sensorOf = c => { const b = part(c, 'Body'); return b && b.sensor ? b.sensor : null; };
  const usesText = c => { const u = usesOf(c); return u.length === 3 ? 'Whole service' : USES.filter(([k]) => u.includes(k)).map(([, l]) => l).join(', '); };
  const distText = c => (c.dist != null && c.dist !== '' ? `${c.dist} ft` : '');

  /* ---------- the sensor mix: of the cameras in the broadcast, how much is which sensor, overall and by part of the service ---------- */
  const TONES = ['var(--ink)', 'var(--ink-3)', 'var(--warn)', 'var(--good)', 'var(--bad)'];
  function mixRow(lbl, list, order) {
    const n = list.length;
    if (!n) return `<div class="gr-mix-row"><span class="gr-mix-l">${esc(lbl)}</span><span class="meta">No cameras</span></div>`;
    const counts = order.map(s => [s, list.filter(c => (sensorOf(c) || 'Unknown') === s).length]).filter(([, k]) => k);
    return `<div class="gr-mix-row"><span class="gr-mix-l">${esc(lbl)} <b>${n}</b></span>
      <span class="gr-mix-bar" role="img" aria-label="${esc(counts.map(([s, k]) => `${s}: ${k} of ${n}`).join(', '))}">${counts.map(([s, k]) => `<i style="flex:${k};background:${TONES[order.indexOf(s) % TONES.length]}"></i>`).join('')}</span>
      <span class="gr-mix-pc">${counts.map(([s, k]) => `<span><i style="background:${TONES[order.indexOf(s) % TONES.length]}"></i>${esc(s)} ${Math.round(k / n * 100)}%</span>`).join('')}</span></div>`;
  }
  function sensorMix(list) {
    const live = list.filter(inUse);
    if (!live.length) return '';
    const order = [...new Set(live.map(c => sensorOf(c) || 'Unknown'))].sort((a, b) => live.filter(c => (sensorOf(c) || 'Unknown') === b).length - live.filter(c => (sensorOf(c) || 'Unknown') === a).length);
    return `<section class="sec gr-mix"><div class="sec-head"><h2 class="lab">Sensor mix</h2><span class="meta">Cameras in the broadcast</span></div><div class="float gr-mix-box">
      ${mixRow('In use', live, order)}${USES.map(([k, l]) => mixRow(l, live.filter(c => usesOf(c).includes(k)), order)).join('')}</div></section>`;
  }

  /* ---------- markup ---------- */
  const statusPill = c => (inUse(c) ? '<span class="pill gr-on">In use</span>' : '<span class="pill gr-off">Not in use</span>');
  function partRow(c, p) {
    const spec = p.role === 'Body' ? [p.sensor, p.mount].filter(Boolean).join(' · ') : p.role === 'Lens' ? [p.range, p.mount].filter(Boolean).join(' · ') : '';
    const sub = [spec, p.serial ? `S/N ${p.serial}` : '', p.notes && (p.make || p.model) ? p.notes : ''].filter(Boolean).join(' · ');
    return `<button type="button" class="gr-part" data-act="gr-part" data-cam="${esc(c.id)}" data-id="${esc(p.id)}">
      <span class="lab">${esc(p.role)}</span><span class="gr-pv"><span class="name">${esc(label(p))}</span>${sub ? `<span class="meta">${esc(sub)}</span>` : ''}</span>${ICON.chev}</button>`;
  }
  const blankPart = (c, role) => `<button type="button" class="gr-part blank" data-act="gr-part" data-cam="${esc(c.id)}" data-role="${esc(role)}"><span class="lab">${esc(role)}</span><span class="gr-pv"><span class="meta">Add the ${esc(role.toLowerCase())}</span></span>${ICON.plus}</button>`;
  function linkRow(c, l, i) {
    return `<button type="button" class="gr-link" data-act="gr-link" data-cam="${esc(c.id)}" data-id="${esc(l.id)}">
      <span class="gr-step">${i + 1}</span>
      <span class="gr-hop"><span class="gr-end">${esc(l.from || 'Somewhere')}</span>
        <span class="gr-wire">${ICON.arrow}<span>${esc([l.cable, l.len].filter(Boolean).join(' · ') || 'Cable')}</span></span>
        <span class="gr-end">${esc(l.to || 'Somewhere')}</span>${l.notes ? `<span class="meta">${esc(l.notes)}</span>` : ''}</span></button>`;
  }
  function detail(c) {
    const ps = partsOf(c), rows = [];
    for (const role of ROLES) {
      const list = ps.filter(p => p.role === role);
      if (list.length) rows.push(...list.map(p => partRow(c, p)));
      else if (CORE.includes(role)) rows.push(blankPart(c, role));
    }
    const links = linksOf(c), u = usesOf(c);
    return `<section class="float mt-detail gr-detail" data-hold-render data-cam="${esc(c.id)}" aria-label="Camera">
      <div class="mt-top">
        <button type="button" class="circle mt-back" data-act="gr-back" aria-label="All cameras">${ICON.left}</button>
        <input class="mt-title" data-gf="name" value="${esc(c.name)}" maxlength="80" aria-label="Camera name" placeholder="Camera name" enterkeyhint="done" autocomplete="off">
        <button type="button" class="circle mt-del" data-act="gr-del" aria-label="Delete camera" title="Delete camera">${ICON.trash}</button>
      </div>
      <div class="mt-scroll" id="grScroll" data-keep>
        <div class="gr-what">
          <div class="mt-sec"><span class="lab" id="grStH">In the broadcast</span>
            <div class="seg3 gr-st" role="radiogroup" aria-labelledby="grStH">${[['in', 'In use'], ['out', 'Not in use']].map(([v, l]) => `<button type="button" role="radio" data-act="gr-status" data-v="${v}" aria-checked="${(inUse(c) ? 'in' : 'out') === v}">${l}</button>`).join('')}</div></div>
          <div class="mt-sec"><span class="lab" id="grUseH">Used during</span>
            <div class="gr-uses" role="group" aria-labelledby="grUseH">${USES.map(([k, l]) => `<button type="button" class="gr-use" data-act="gr-use" data-v="${k}" aria-pressed="${u.includes(k)}">${l}</button>`).join('')}</div></div>
          <label class="mt-sec"><span class="lab">Its job</span><input class="gr-in" data-gf="job" value="${esc(c.job || '')}" maxlength="160" placeholder="Like: center wide, message close-up" autocomplete="off" enterkeyhint="done"></label>
          <div class="gr-pair">
            <label class="mt-sec"><span class="lab">Rig</span><select class="gr-in" data-gf="rig"><option value="">Not set</option>${RIGS.map(r => `<option${c.rig === r ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
            <label class="mt-sec"><span class="lab">To the speaker</span><span class="xin"><input class="gr-in" data-gf="dist" type="number" inputmode="decimal" min="0" max="999" step="1" value="${c.dist ?? ''}" placeholder="0"><span class="unit">ft</span></span></label>
          </div>
          <label class="mt-sec"><span class="lab">Position</span><input class="gr-in" data-gf="where" value="${esc(c.where || '')}" maxlength="120" placeholder="Like: center platform, back of the room" autocomplete="off" enterkeyhint="done"></label>
        </div>
        <div class="mt-sec"><div class="sec-head"><span class="lab">Parts</span><button type="button" class="link" data-act="gr-part" data-cam="${esc(c.id)}" data-role="">Add a part</button></div>
          <div class="gr-parts">${rows.join('')}</div></div>
        <div class="mt-sec"><div class="sec-head"><span class="lab">Signal path</span><span class="meta">What goes out of what</span></div>
          ${links.length ? `<div class="gr-links">${links.map((l, i) => linkRow(c, l, i)).join('')}</div>` : '<p class="meta">Nothing yet. Start at the camera: which output, which cable, and where it goes.</p>'}
          <button type="button" class="btn gr-addlink" data-act="gr-link" data-cam="${esc(c.id)}">${ICON.plus}<span>Add a connection</span></button></div>
        <label class="mt-sec"><span class="lab">Notes</span><textarea class="mt-notes" data-gf="notes" placeholder="Settings, quirks, what to check before a service" aria-label="Camera notes">${esc(c.notes || '')}</textarea></label>
      </div>
    </section>`;
  }
  // every camera side by side, one row each
  const cell = v => (v ? esc(v) : '<span class="gr-none">—</span>');
  const partCell = (c, role) => cell(partsOf(c).filter(p => p.role === role).map(label).join(' + ')); // a cage and a CineBack are both rigging
  const COLS = [
    ['Status', c => statusPill(c)],
    ['Used during', c => cell(inUse(c) ? usesText(c) : '')],
    ['Its job', c => cell(c.job)],
    ['Rig', c => cell(c.rig)],
    ['Body', c => partCell(c, 'Body')],
    ['Sensor', c => { const b = part(c, 'Body'); return b && b.sensor ? `<b>${esc(b.sensor)}</b>${b.size ? `<span class="meta">${esc(b.size)}</span>` : ''}` : cell(''); }],
    ['Lens', c => { const p = part(c, 'Lens'); return p ? `${esc(label(p))}${p.range ? `<span class="meta">${esc(p.range)}</span>` : ''}` : cell(''); }],
    ['Mount', c => { const b = part(c, 'Body'); return cell(b && b.mount); }],
    ['Matte box', c => partCell(c, 'Matte box')],
    ['Monitor', c => partCell(c, 'Monitor')],
    ['Rigging', c => partCell(c, 'Rigging')],
    ['Power', c => partCell(c, 'Power')],
    ['Converter', c => partCell(c, 'Converter')],
    ['Support', c => partCell(c, 'Support')],
    ['Comms', c => partCell(c, 'Comms')],
    ['Position', c => cell(c.where)],
    ['To the speaker', c => cell(distText(c))],
    ['Signal path', c => { const ls = linksOf(c); return ls.length ? esc(ls.map(l => l.cable || '?').join(' → ')) + `<span class="meta">ends at ${esc(ls[ls.length - 1].to || '?')}</span>` : cell(''); }],
  ];
  function compare(list) {
    if (!list.length) return '<p class="empty">No cameras yet.</p>';
    return `<div class="gr-table-wrap" id="grTable" data-keep><table class="gr-table"><thead><tr><th scope="col">Camera</th>${COLS.map(([h]) => `<th scope="col">${h}</th>`).join('')}</tr></thead>
      <tbody>${list.map(c => `<tr class="${inUse(c) ? '' : 'off'}"><th scope="row"><button type="button" class="link" data-act="gr-open" data-id="${esc(c.id)}">${esc(c.name)}</button></th>${COLS.map(([, f]) => `<td>${f(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  /* ---------- AVL: each department is a tree of areas; the deepest place you went is remembered per department ---------- */
  const TREE = {
    audio: { name: 'Audio', kids: [] },
    video: { name: 'Video', kids: [{ id: 'broadcast', name: 'Broadcast', kids: [{ id: 'cameras', name: 'Cameras' }, { id: 'camplot', name: '3D cam plot', href: 'cam.html' }] }] },
    lighting: { name: 'Lighting', kids: [] },
  };
  const PATH = (() => { try { const p = JSON.parse(localStorage.getItem('pos.avlPath') || 'null'); return p && typeof p === 'object' ? p : { video: ['broadcast'] }; } catch (e) { return { video: ['broadcast'] }; } })();
  function goTo(dept, ids) {
    PATH[dept] = ids; UI.sel = null;
    try { localStorage.setItem('pos.avlPath', JSON.stringify(PATH)); } catch (e) {}
  }
  // the places along the remembered path (anything that no longer exists is dropped)
  function walk(dept) {
    const nodes = [TREE[dept]];
    for (const id of Array.isArray(PATH[dept]) ? PATH[dept] : []) {
      const k = (nodes[nodes.length - 1].kids || []).find(x => x.id === id && !x.href);
      if (!k) break;
      nodes.push(k);
    }
    return nodes;
  }
  const at = dept => { const n = walk(dept); return n[n.length - 1].id || ''; };
  function crumbs(dept, nodes, sel) {
    const ids = nodes.slice(1).map(n => n.id);
    const parts = nodes.map((n, i) => (i === nodes.length - 1 && !sel)
      ? `<span class="avl-cur" aria-current="page">${esc(n.name)}</span>`
      : `<button type="button" class="avl-crumb" data-act="gr-go" data-dept="${dept}" data-path="${esc(ids.slice(0, i).join('/'))}">${esc(n.name)}</button>`);
    if (sel) parts.push(`<span class="avl-cur" aria-current="page">${esc(sel.name)}</span>`);
    const up = sel ? `data-act="gr-back"` : nodes.length > 1 ? `data-act="gr-go" data-dept="${dept}" data-path="${esc(ids.slice(0, -1).join('/'))}"` : '';
    return `<nav class="avl-bar" aria-label="Where you are">${up ? `<button type="button" class="circle avl-up" ${up} aria-label="Back">${ICON.left}</button>` : ''}<span class="avl-path">${parts.join('<span class="avl-sep" aria-hidden="true">›</span>')}</span></nav>`;
  }
  // a tile for each place you can go next: its name, and the one number that matters there
  function tile(dept, ids, k, list) {
    const live = list.filter(inUse).length;
    const info = k.id === 'broadcast' ? [ICON.tower, live, live === 1 ? 'camera in use' : 'cameras in use']
      : k.id === 'cameras' ? [ICON.cam, list.length, `${list.length === 1 ? 'camera' : 'cameras'} · ${live} in use`]
      : k.id === 'camplot' ? [ICON.cube, '', 'The room in 3D, each camera’s real view, and a multiview to practice cuts']
      : [ICON.chev, '', ''];
    const inner = `<span class="avl-ic">${info[0]}</span><span class="avl-name">${esc(k.name)}</span><span class="avl-fig">${info[1] !== '' ? `<b>${info[1]}</b>` : ''}<span>${esc(info[2])}</span></span>`;
    if (k.href) return `<a class="float avl-tile" href="${esc(k.href)}">${inner}</a>`;
    return `<button type="button" class="float avl-tile" data-act="gr-go" data-dept="${dept}" data-path="${esc(ids.concat(k.id).join('/'))}">${inner}</button>`;
  }
  function camerasPage(list) {
    const live = list.filter(inUse);
    const nParts = list.reduce((n, c) => n + partsOf(c).length, 0), nLinks = list.reduce((n, c) => n + linksOf(c).length, 0);
    const sum = `<div class="gr-sum"><div><b class="fig">${live.length}</b><span>in use</span></div><div><b class="fig">${list.length}</b><span>${list.length === 1 ? 'camera' : 'cameras'}</span></div><div><b class="fig">${nParts}</b><span>parts</span></div><div><b class="fig">${nLinks}</b><span>cables</span></div></div>`;
    return `<div class="gr-cmp"><div class="gr-cmp-scroll" id="grCmp" data-keep>${sum}<section class="sec"><div class="sec-head"><h2 class="lab">Every camera</h2>${ctx.canSave() ? '<button type="button" class="link" data-act="gr-new">Add a camera</button>' : ''}</div>${compare(list)}<p class="meta gr-tip">Tap a camera’s name to open everything on it.</p></section>${sensorMix(list)}</div></div>`;
  }
  function view(dept) {
    dept = TREE[dept] ? dept : 'video';
    if (S.failed) return '<p class="empty">The gear list did not load. POS tries again when you come back to it.</p>';
    if (!S.loaded) return '<p class="empty">Loading…</p>';
    const nodes = walk(dept), here = nodes[nodes.length - 1], ids = nodes.slice(1).map(n => n.id), list = cams();
    const sel = here.id === 'cameras' && UI.sel ? list.find(c => c.id === UI.sel) || null : null;
    if (!sel) UI.sel = null;
    const bar = crumbs(dept, nodes, sel);
    if (sel) return `<div class="avl">${bar}<div class="mtg gr has-sel solo"><div class="mt-pane">${detail(sel)}</div></div></div>`;
    if (here.id === 'cameras') return `<div class="avl">${bar}${camerasPage(list)}</div>`;
    const kids = here.kids || [];
    const body = kids.length ? `<div class="avl-tiles">${kids.map(k => tile(dept, ids, k, list)).join('')}</div>`
      : `<div class="float mt-none avl-none"><p class="name">Nothing in ${esc(here.name)} yet.</p><p class="meta">Its areas and gear will sort in here the same way Video does: an area, then what's in it.</p></div>`;
    return `<div class="avl">${bar}<div class="avl-scroll" id="avlScroll" data-keep>${body}</div></div>`;
  }

  /* ---------- changes ---------- */
  const f = (lbl, inner, hint, cls = '') => `<label class="f${cls}"><span class="lab">${lbl}</span>${inner}${hint ? `<span class="meta">${hint}</span>` : ''}</label>`;
  const val = id => ((document.getElementById(id) || {}).value || '').trim();
  const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  async function put(c, patch) { return R.save(R.db.update(KIND, c.id, patch)); }
  function addCamera() {
    if (!ctx.canSave()) return;
    const n = S[KIND].length + 1;
    window.POSSheet.open({
      title: 'Add a camera',
      body: f('Name', `<input id="gr_name" maxlength="80" autocomplete="off" placeholder="Camera ${n}">`)
        + f('Position', '<input id="gr_where" maxlength="120" autocomplete="off" placeholder="Optional, like center platform">'),
      saveLabel: 'Add camera',
      submit: async () => {
        const name = val('gr_name');
        if (!name) return 'Give the camera a name.';
        const id = R.newId('gear');
        const pos = S[KIND].reduce((m, c) => Math.max(m, c.pos || 0), 0) + 1000;
        const ok = await R.save(R.db.set(KIND, id, { name: name.slice(0, 80), status: 'in', uses: [], job: '', rig: '', where: val('gr_where').slice(0, 120), dist: null, notes: '', pos, parts: [], links: [] }));
        if (ok) { goTo('video', ['broadcast', 'cameras']); UI.sel = id; ctx.rerender(); }
        return ok || 'That did not save. Check your connection and try again.';
      },
    });
  }
  // a body POS knows fills in its sensor and mount
  function knownBody() {
    const m = `${val('gp_make')} ${val('gp_model')}`, k = BODIES.find(b => b.re.test(m));
    if (!k) return;
    const s = document.getElementById('gp_sensor'), z = document.getElementById('gp_size'), mt = document.getElementById('gp_mount');
    if (s && !s.value) s.value = k.sensor;
    if (z && !z.value) z.value = k.size;
    if (mt && !mt.value) mt.value = k.mount;
  }
  function roleFields(role) {
    const box = document.getElementById('recBody');
    if (!box) return;
    for (const el of box.querySelectorAll('[data-for-role]')) el.hidden = !el.dataset.forRole.split(',').includes(role);
  }
  function editPart(c, partId, role) {
    const p = partId ? partsOf(c).find(x => x.id === partId) : null;
    if (partId && !p) return;
    const r0 = p ? p.role : role || 'Body', g = k => esc(p ? p[k] || '' : '');
    window.POSSheet.open({
      title: p ? `${c.name}: ${p.role}` : `${c.name}: add ${role ? role.toLowerCase() : 'a part'}`,
      body: f('Part', `<select id="gp_role">${ROLES.map(x => opt(x, r0)).join('')}</select>`)
        + f('Make', `<input id="gp_make" maxlength="60" autocomplete="off" placeholder="Sony, Fujifilm, SmallRig…" value="${g('make')}">`)
        + f('Model', `<input id="gp_model" maxlength="80" autocomplete="off" placeholder="FX30, MK18-55mm T2.9…" value="${g('model')}">`)
        + `<div data-for-role="Body">${f('Sensor', `<select id="gp_sensor"><option value="">Not set</option>${SENSORS.map(x => opt(x, p ? p.sensor : '')).join('')}</select>`)}${f('Sensor size', `<input id="gp_size" maxlength="80" autocomplete="off" placeholder="23.3 × 15.5 mm" value="${g('size')}">`)}</div>`
        + `<div data-for-role="Lens">${f('Focal range', `<input id="gp_range" maxlength="60" autocomplete="off" placeholder="18–105mm f/4" value="${g('range')}">`)}</div>`
        + `<div data-for-role="Body,Lens">${f('Mount', `<input id="gp_mount" maxlength="40" autocomplete="off" placeholder="Sony E, B4, EF…" value="${g('mount')}">`)}</div>`
        + f('Serial number', `<input id="gp_serial" maxlength="60" autocomplete="off" placeholder="Optional" value="${g('serial')}">`)
        + f('Notes', `<textarea id="gp_notes" rows="3" maxlength="500" placeholder="Version, settings, what it plugs into…">${esc(p ? p.notes || '' : '')}</textarea>`),
      ready: box => {
        roleFields(r0);
        box.querySelector('#gp_role').addEventListener('change', e => roleFields(e.target.value));
        for (const id of ['gp_make', 'gp_model']) box.querySelector('#' + id).addEventListener('change', () => { if (val('gp_role') === 'Body') knownBody(); });
      },
      delLabel: 'Remove part',
      remove: p && ctx.canSave() ? async () => { const ok = await put(c, { parts: partsOf(c).filter(x => x.id !== p.id) }); if (ok) toast(`${p.role} removed`); return ok; } : null,
      submit: ctx.canSave() ? async () => {
        const rl = ROLES.includes(val('gp_role')) ? val('gp_role') : 'Other';
        if (rl === 'Body') knownBody();
        const np = { id: p ? p.id : uid(), role: rl, make: val('gp_make').slice(0, 60), model: val('gp_model').slice(0, 80), serial: val('gp_serial').slice(0, 60), notes: val('gp_notes').slice(0, 500),
          sensor: rl === 'Body' && SENSORS.includes(val('gp_sensor')) ? val('gp_sensor') : '', size: rl === 'Body' ? val('gp_size').slice(0, 80) : '',
          range: rl === 'Lens' ? val('gp_range').slice(0, 60) : '', mount: rl === 'Body' || rl === 'Lens' ? val('gp_mount').slice(0, 40) : '' };
        if (!np.make && !np.model && !np.notes) return 'Add the make, the model, or a note.';
        const parts = p ? partsOf(c).map(x => (x.id === p.id ? np : x)) : partsOf(c).concat([np]);
        return put(c, { parts });
      } : null,
      saveLabel: p ? 'Save' : 'Add part',
    });
  }
  // where things go, from what's already been typed anywhere in the list (and this camera's parts)
  function places(c) {
    const seen = new Set();
    for (const p of partsOf(c)) seen.add(partName(p));
    for (const k of S[KIND]) for (const l of linksOf(k)) { if (l.from) seen.add(l.from); if (l.to) seen.add(l.to); }
    return [...seen].filter(Boolean).slice(0, 80);
  }
  function editLink(c, linkId) {
    const l = linkId ? linksOf(c).find(x => x.id === linkId) : null;
    if (linkId && !l) return;
    const prev = !l && linksOf(c).length ? linksOf(c)[linksOf(c).length - 1] : null;
    const body = part(c, 'Body');
    const from0 = l ? l.from : prev ? String(prev.to || '').replace(/\s+(in|input)\b.*$/i, '') : body ? `${partName(body)} SDI out` : ''; // the next hop starts at the device the last one went into
    window.POSSheet.open({
      title: l ? 'Connection' : 'Add a connection',
      body: `<datalist id="gl_places">${places(c).map(x => `<option value="${esc(x)}"></option>`).join('')}</datalist>`
        + f('Out of', `<input id="gl_from" list="gl_places" maxlength="120" autocomplete="off" placeholder="Body SDI out 1" value="${esc(from0 || '')}">`, 'The device and which output.')
        + f('Cable', `<select id="gl_cable">${CABLES.map(x => opt(x, l ? l.cable : '12G-SDI')).join('')}</select>`)
        + f('Length', `<input id="gl_len" maxlength="20" autocomplete="off" placeholder="50 ft" value="${esc(l ? l.len || '' : '')}">`)
        + f('Into', `<input id="gl_to" list="gl_places" maxlength="120" autocomplete="off" placeholder="Router in 3, switcher in 1…" value="${esc(l ? l.to || '' : '')}">`, 'The device and which input.')
        + f('Notes', `<input id="gl_notes" maxlength="200" autocomplete="off" placeholder="Optional, like the wall plate number" value="${esc(l ? l.notes || '' : '')}">`),
      delLabel: 'Remove connection',
      remove: l && ctx.canSave() ? async () => put(c, { links: linksOf(c).filter(x => x.id !== l.id) }) : null,
      submit: ctx.canSave() ? async () => {
        const nl = { id: l ? l.id : uid(), from: val('gl_from').slice(0, 120), cable: CABLES.includes(val('gl_cable')) ? val('gl_cable') : 'Other', len: val('gl_len').slice(0, 20), to: val('gl_to').slice(0, 120), notes: val('gl_notes').slice(0, 200) };
        if (!nl.from || !nl.to) return 'Say what it comes out of and what it goes into.';
        const links = l ? linksOf(c).map(x => (x.id === l.id ? nl : x)) : linksOf(c).concat([nl]);
        return put(c, { links });
      } : null,
      saveLabel: l ? 'Save' : 'Add connection',
    });
  }

  // typed fields save a moment after you stop typing; picks (status, used during, rig) save at once
  let pend = null, pendT = null;
  function flush() {
    clearTimeout(pendT);
    const p = pend; pend = null;
    if (!p) return;
    const c = camById(p.id);
    if (c) R.save(R.db.update(KIND, c.id, p.patch));
  }
  function fieldVal(el) {
    const k = el.dataset.gf;
    if (k === 'notes') return el.value.slice(0, 4000);
    if (k === 'dist') { const n = parseFloat(el.value); return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null; }
    return el.value.trim().slice(0, k === 'name' ? 80 : k === 'job' ? 160 : 120);
  }
  document.addEventListener('input', e => {
    const box = e.target.closest && e.target.closest('.gr-detail[data-cam]');
    if (!box || !e.target.dataset.gf || e.target.tagName === 'SELECT' || !ctx.canSave()) return;
    const k = e.target.dataset.gf, v = fieldVal(e.target);
    if (k === 'name' && !v) return;
    pend = { id: box.dataset.cam, patch: { ...(pend && pend.id === box.dataset.cam ? pend.patch : {}), [k]: v } };
    clearTimeout(pendT); pendT = setTimeout(flush, 800);
  });
  document.addEventListener('change', e => {
    const box = e.target.closest && e.target.closest('.gr-detail[data-cam]');
    if (!box || e.target.dataset.gf !== 'rig' || !ctx.canSave()) return;
    const c = camById(box.dataset.cam);
    if (c) put(c, { rig: RIGS.includes(e.target.value) ? e.target.value : '' });
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset && ['name', 'where', 'job', 'dist'].includes(e.target.dataset.gf)) { e.preventDefault(); e.target.blur(); } });
  document.addEventListener('focusout', e => { if (e.target.dataset && e.target.dataset.gf && e.target.closest && e.target.closest('.gr-detail')) { if (e.target.dataset.gf === 'name' && !e.target.value.trim()) { const c = camById(e.target.closest('.gr-detail').dataset.cam); if (c) e.target.value = c.name; } flush(); } });

  async function act(name, b) {
    if (name === 'gr-go') { flush(); if (TREE[b.dataset.dept]) goTo(b.dataset.dept, (b.dataset.path || '').split('/').filter(Boolean)); ctx.rerender(); return; }
    if (name === 'gr-open') { flush(); UI.sel = b.dataset.id; ctx.rerender(); return; }
    if (name === 'gr-back') { flush(); UI.sel = null; ctx.rerender(); return; }
    if (!ctx.canSave()) return;
    if (name === 'gr-new') { addCamera(); return; }
    const c = camById(b.dataset.cam || UI.sel);
    if (!c) return;
    if (name === 'gr-part') editPart(c, b.dataset.id || null, b.dataset.role || '');
    else if (name === 'gr-link') editLink(c, b.dataset.id || null);
    else if (name === 'gr-status') { flush(); const v = b.dataset.v === 'out' ? 'out' : 'in'; if ((inUse(c) ? 'in' : 'out') !== v) put(c, { status: v }); }
    else if (name === 'gr-use') {
      flush();
      const u = usesOf(c), k = b.dataset.v;
      put(c, { uses: USES.map(([x]) => x).filter(x => (x === k ? !u.includes(k) : u.includes(x))) });
    } else if (name === 'gr-del') {
      if (!b.classList.contains('armed')) { b.classList.add('armed'); toast(`Tap the bin again to delete ${c.name} and its parts list`); setTimeout(() => b.classList.remove('armed'), 4000); return; }
      flush();
      UI.sel = null;
      const old = { ...c };
      if (await R.save(R.db.remove(KIND, c.id))) toast(`Deleted: ${c.name}`, () => { const { id, ...d } = old; R.save(R.db.set(KIND, id, d)); });
    }
  }
  const add = () => addCamera();
  // where Gear used to be: Video › Broadcast › Cameras
  const toCameras = () => goTo('video', ['broadcast', 'cameras']);
  return { view, act, add, at, toCameras, start: R.start, stop: R.stop, count: () => S[KIND].length };
};
