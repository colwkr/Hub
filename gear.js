// POS Gear: the broadcast gear list. One entry per camera, with every part on it (body, lens, matte box, monitor, and
// whatever else rides along) and its signal path: what cable goes out of what, and into what.
// Records: kind "gear-cam" { name, where, notes, pos, parts: [{ id, role, make, model, serial, notes }],
//   links: [{ id, from, cable, len, to, notes }] }.
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
  };
  // the parts a camera is described by, in this order; the first four are always shown, even before they're filled in
  const ROLES = ['Body', 'Lens', 'Matte box', 'Monitor', 'Support', 'Power', 'Other'];
  const CORE = ROLES.slice(0, 4);
  const CABLES = ['12G-SDI', '6G-SDI', '3G-SDI', 'HD-SDI', 'HDMI', 'SMPTE fiber', 'Fiber', 'Ethernet', 'USB-C', 'XLR', 'Power', 'Other'];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const cams = () => S[KIND].slice().sort((a, b) => (a.pos ?? 1e12) - (b.pos ?? 1e12) || String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  const camById = id => S[KIND].find(c => c.id === id) || null;
  const partsOf = c => (Array.isArray(c.parts) ? c.parts : []);
  const linksOf = c => (Array.isArray(c.links) ? c.links : []);
  const label = p => [p.make, p.model].filter(Boolean).join(' ') || p.notes || 'Not filled in';
  const partName = p => `${p.role}${p.make || p.model ? ` (${[p.make, p.model].filter(Boolean).join(' ')})` : ''}`;

  /* ---------- markup ---------- */
  function camRow(c, on) {
    const ps = partsOf(c), body = ps.find(p => p.role === 'Body'), lens = ps.find(p => p.role === 'Lens');
    const bits = [body ? label(body) : 'No body yet', lens ? label(lens) : ''].filter(Boolean);
    return `<button type="button" class="mrow gr-row${on ? ' on' : ''}" data-act="gr-open" data-id="${esc(c.id)}"${on ? ' aria-current="true"' : ''}>
      <span class="cal-ic" aria-hidden="true">${ICON.cam}</span>
      <span class="tmain"><span class="name">${esc(c.name)}</span><span class="meta"><span>${esc(bits.join(' · '))}</span>${c.where ? `<span>${esc(c.where)}</span>` : ''}</span></span>
      <span class="gr-n" title="Parts and cables"><b>${ps.length}</b> parts<br><b>${linksOf(c).length}</b> cables</span>${ICON.chev}</button>`;
  }
  function partRow(c, p) {
    return `<button type="button" class="gr-part" data-act="gr-part" data-cam="${esc(c.id)}" data-id="${esc(p.id)}">
      <span class="lab">${esc(p.role)}</span><span class="gr-pv"><span class="name">${esc(label(p))}</span>${p.serial || p.notes ? `<span class="meta">${p.serial ? `S/N ${esc(p.serial)}` : ''}${p.serial && p.notes ? ' · ' : ''}${p.notes && (p.make || p.model) ? esc(p.notes) : ''}</span>` : ''}</span>${ICON.chev}</button>`;
  }
  const emptyPart = (c, role) => `<button type="button" class="gr-part blank" data-act="gr-part" data-cam="${esc(c.id)}" data-role="${esc(role)}"><span class="lab">${esc(role)}</span><span class="gr-pv"><span class="meta">Add the ${esc(role.toLowerCase())}</span></span>${ICON.plus}</button>`;
  function linkRow(c, l, i) {
    return `<button type="button" class="gr-link" data-act="gr-link" data-cam="${esc(c.id)}" data-id="${esc(l.id)}">
      <span class="gr-step">${i + 1}</span>
      <span class="gr-hop"><span class="gr-end">${esc(l.from || 'Somewhere')}</span>
        <span class="gr-wire">${ICON.arrow}<span>${esc([l.cable, l.len].filter(Boolean).join(' · ') || 'Cable')}</span></span>
        <span class="gr-end">${esc(l.to || 'Somewhere')}</span>${l.notes ? `<span class="meta">${esc(l.notes)}</span>` : ''}</span></button>`;
  }
  function detail(c) {
    const ps = partsOf(c);
    const rows = [];
    for (const role of ROLES) {
      const list = ps.filter(p => p.role === role);
      if (list.length) rows.push(...list.map(p => partRow(c, p)));
      else if (CORE.includes(role)) rows.push(emptyPart(c, role));
    }
    const links = linksOf(c);
    return `<section class="float mt-detail gr-detail" data-hold-render data-cam="${esc(c.id)}" aria-label="Camera">
      <div class="mt-top">
        <button type="button" class="circle mt-back" data-act="gr-back" aria-label="All cameras">${ICON.left}</button>
        <input class="mt-title" data-gf="name" value="${esc(c.name)}" maxlength="80" aria-label="Camera name" placeholder="Camera name" enterkeyhint="done" autocomplete="off">
        <button type="button" class="circle mt-del" data-act="gr-del" aria-label="Delete camera" title="Delete camera">${ICON.trash}</button>
      </div>
      <div class="mt-scroll" id="grScroll" data-keep>
        <label class="mt-sec"><span class="lab">Where it lives</span><input class="gr-where" data-gf="where" value="${esc(c.where || '')}" maxlength="120" placeholder="Room and spot, like Simpsonville main, center platform" autocomplete="off" enterkeyhint="done"></label>
        <div class="mt-sec"><div class="sec-head"><span class="lab">Parts</span><button type="button" class="link" data-act="gr-part" data-cam="${esc(c.id)}" data-role="">Add a part</button></div>
          <div class="gr-parts">${rows.join('')}</div></div>
        <div class="mt-sec"><div class="sec-head"><span class="lab">Signal path</span><span class="meta">What goes out of what</span></div>
          ${links.length ? `<div class="gr-links">${links.map((l, i) => linkRow(c, l, i)).join('')}</div>` : '<p class="meta">Nothing yet. Start at the camera: which output, which cable, and where it goes.</p>'}
          <button type="button" class="btn gr-addlink" data-act="gr-link" data-cam="${esc(c.id)}">${ICON.plus}<span>Add a connection</span></button></div>
        <label class="mt-sec"><span class="lab">Notes</span><textarea class="mt-notes" data-gf="notes" placeholder="Settings, quirks, what to check before a service" aria-label="Camera notes">${esc(c.notes || '')}</textarea></label>
      </div>
    </section>`;
  }
  function view() {
    if (S.failed) return '<p class="empty">The gear list did not load. POS tries again when you come back to it.</p>';
    if (!S.loaded) return '<p class="empty">Loading…</p>';
    const list = cams();
    const sel = list.find(c => c.id === UI.sel) || null;
    if (!sel) UI.sel = null;
    const nParts = list.reduce((n, c) => n + partsOf(c).length, 0), nLinks = list.reduce((n, c) => n + linksOf(c).length, 0);
    const side = `<div class="mt-list" id="grList" data-keep>
        <div class="gr-sum"><div><b class="fig">${list.length}</b><span>${list.length === 1 ? 'camera' : 'cameras'}</span></div><div><b class="fig">${nParts}</b><span>parts</span></div><div><b class="fig">${nLinks}</b><span>cables</span></div></div>
        ${ctx.canSave() ? `<button type="button" class="btn solid mt-new" data-act="gr-new">${ICON.plus}<span>Add a camera</span></button>` : ''}
        <section class="sec"><div class="sec-head"><h2 class="lab">Cameras</h2></div><div class="float list">${list.length ? list.map(c => camRow(c, sel && c.id === sel.id)).join('') : '<p class="empty">No cameras yet. Add one, then its body, lens, matte box, monitor and where its video goes.</p>'}</div></section>
      </div>`;
    const pane = sel ? detail(sel) : `<div class="float mt-none"><span class="cal-ic">${ICON.cam}</span><p class="name">Pick a camera, or add one.</p><p class="meta">Each camera keeps its parts and its signal path in one place.</p>${ctx.canSave() ? '<button type="button" class="btn" data-act="gr-new">Add a camera</button>' : ''}</div>`;
    return `<div class="mtg gr${sel ? ' has-sel' : ''}">${side}<div class="mt-pane">${pane}</div></div>`;
  }

  /* ---------- changes ---------- */
  const f = (lbl, inner, hint) => `<label class="f"><span class="lab">${lbl}</span>${inner}${hint ? `<span class="meta">${hint}</span>` : ''}</label>`;
  const val = id => ((document.getElementById(id) || {}).value || '').trim();
  const opt = (v, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`;
  async function put(c, patch) { return R.save(R.db.update(KIND, c.id, patch)); }
  function addCamera() {
    if (!ctx.canSave()) return;
    const n = S[KIND].length + 1;
    window.POSSheet.open({
      title: 'Add a camera',
      body: f('Name', `<input id="gr_name" maxlength="80" autocomplete="off" placeholder="Cam ${n}, like Cam ${n} – Center">`)
        + f('Where it lives', '<input id="gr_where" maxlength="120" autocomplete="off" placeholder="Optional, like Simpsonville main, center platform">'),
      saveLabel: 'Add camera',
      submit: async () => {
        const name = val('gr_name');
        if (!name) return 'Give the camera a name.';
        const id = R.newId('gear');
        const pos = S[KIND].reduce((m, c) => Math.max(m, c.pos || 0), 0) + 1000;
        const ok = await R.save(R.db.set(KIND, id, { name: name.slice(0, 80), where: val('gr_where').slice(0, 120), notes: '', pos, parts: [], links: [] }));
        if (ok) { UI.sel = id; ctx.rerender(); }
        return ok || 'That did not save. Check your connection and try again.';
      },
    });
  }
  function editPart(c, partId, role) {
    const p = partId ? partsOf(c).find(x => x.id === partId) : null;
    if (partId && !p) return;
    const r0 = p ? p.role : role || 'Body';
    window.POSSheet.open({
      title: p ? `${c.name}: ${p.role}` : `${c.name}: add ${role ? role.toLowerCase() : 'a part'}`,
      body: f('Part', `<select id="gp_role">${ROLES.map(x => opt(x, r0)).join('')}</select>`)
        + f('Make', `<input id="gp_make" maxlength="60" autocomplete="off" placeholder="Sony, Canon, Blackmagic…" value="${esc(p ? p.make || '' : '')}">`)
        + f('Model', `<input id="gp_model" maxlength="80" autocomplete="off" placeholder="FX6, CJ20ex7.8B…" value="${esc(p ? p.model || '' : '')}">`)
        + f('Serial number', `<input id="gp_serial" maxlength="60" autocomplete="off" placeholder="Optional" value="${esc(p ? p.serial || '' : '')}">`)
        + f('Notes', `<textarea id="gp_notes" rows="3" maxlength="500" placeholder="Mount, settings, what it plugs into…">${esc(p ? p.notes || '' : '')}</textarea>`),
      delLabel: 'Remove part',
      remove: p && ctx.canSave() ? async () => { const ok = await put(c, { parts: partsOf(c).filter(x => x.id !== p.id) }); if (ok) toast(`${p.role} removed`); return ok; } : null,
      submit: ctx.canSave() ? async () => {
        const np = { id: p ? p.id : uid(), role: ROLES.includes(val('gp_role')) ? val('gp_role') : 'Other', make: val('gp_make').slice(0, 60), model: val('gp_model').slice(0, 80), serial: val('gp_serial').slice(0, 60), notes: val('gp_notes').slice(0, 500) };
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
    const body = partsOf(c).find(p => p.role === 'Body');
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

  // the camera's name, where it lives and its notes save a moment after you stop typing
  let pend = null, pendT = null;
  function flush() {
    clearTimeout(pendT);
    const p = pend; pend = null;
    if (!p) return;
    const c = camById(p.id);
    if (c) R.save(R.db.update(KIND, c.id, p.patch));
  }
  document.addEventListener('input', e => {
    const box = e.target.closest && e.target.closest('.gr-detail[data-cam]');
    if (!box || !e.target.dataset.gf || !ctx.canSave()) return;
    const k = e.target.dataset.gf, v = k === 'notes' ? e.target.value.slice(0, 4000) : e.target.value.trim().slice(0, k === 'name' ? 80 : 120);
    if (k === 'name' && !v) return;
    pend = { id: box.dataset.cam, patch: { ...(pend && pend.id === box.dataset.cam ? pend.patch : {}), [k]: v } };
    clearTimeout(pendT); pendT = setTimeout(flush, 800);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset && (e.target.dataset.gf === 'name' || e.target.dataset.gf === 'where')) { e.preventDefault(); e.target.blur(); } });
  document.addEventListener('focusout', e => { if (e.target.dataset && e.target.dataset.gf) { if (e.target.dataset.gf === 'name' && !e.target.value.trim()) { const c = camById(e.target.closest('.gr-detail').dataset.cam); if (c) e.target.value = c.name; } flush(); } });

  async function act(name, b) {
    if (name === 'gr-open') { flush(); UI.sel = b.dataset.id; ctx.rerender(); return; }
    if (name === 'gr-back') { flush(); UI.sel = null; ctx.rerender(); return; }
    if (!ctx.canSave()) return;
    if (name === 'gr-new') { addCamera(); return; }
    const c = camById(b.dataset.cam || UI.sel);
    if (!c) return;
    if (name === 'gr-part') editPart(c, b.dataset.id || null, b.dataset.role || '');
    else if (name === 'gr-link') editLink(c, b.dataset.id || null);
    else if (name === 'gr-del') {
      if (!b.classList.contains('armed')) { b.classList.add('armed'); toast(`Tap the bin again to delete ${c.name} and its parts list`); setTimeout(() => b.classList.remove('armed'), 4000); return; }
      flush();
      UI.sel = null;
      const old = { ...c };
      if (await R.save(R.db.remove(KIND, c.id))) toast(`Deleted: ${c.name}`, () => { const { id, ...d } = old; R.save(R.db.set(KIND, id, d)); });
    }
  }
  const add = () => addCamera();
  const open = id => { UI.sel = id || null; };
  return { view, act, add, open, start: R.start, stop: R.stop, count: () => S[KIND].length };
};
