// POS Packages: what's on its way, where it is, and when it gets here. Each package is a record (kind "package") that
// the packages edge function keeps current (Track123, every 30 minutes); shipping emails add new ones on their own.
// The map is the point: the state it's in lights up, home is marked, and the line between says how far it has left.
window.POSPackages = function (ctx) {
  const { esc, toast } = ctx;
  const R = window.POSRecords(ctx, ['package'], 'pos-packages');
  const S = R.S;
  const UI = { open: new Set(), key: null, asked: false, busy: new Set(), armed: null };
  const M = () => window.POSUSMap;
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    box: svg('<path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z"/><path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9M7.8 5.5l8.4 4"/>'),
    refresh: svg('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
    chev: svg('<path d="M9.5 6.5 15 12l-5.5 5.5"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7"/>'),
  };

  /* ---------- the facts about one package ---------- */
  const pad = n => String(n).padStart(2, '0');
  const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => fromKey(dkey(new Date()));
  const daysTo = k => Math.round((fromKey(k) - today()) / 864e5);
  const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  const mdFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const tFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const etaOf = p => p.etaCarrier || p.etaMail || null;
  const R_MI = 3958.8, rad = d => d * Math.PI / 180;
  const miles = (a, b) => { const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2; return 2 * R_MI * Math.asin(Math.sqrt(x)); };
  const home = () => { const pl = ctx.places && ctx.places(); return pl && pl.home ? pl.home() : null; };
  const placed = w => !!(w && Number.isFinite(w.lat) && Number.isFinite(w.lon));
  // an event's time: as the carrier wrote it where it happened, else the moment
  function evTime(e) {
    if (e.wall) { const [d, t] = e.wall.split(' '), [h, m] = t.split(':').map(Number); const dt = fromKey(d); dt.setHours(h, m); return dt; }
    return new Date(e.at);
  }
  const whenTxt = dt => { const k = dkey(dt), n = daysTo(k); return `${n === 0 ? 'Today' : n === -1 ? 'Yesterday' : mdFmt.format(dt)}, ${tFmt.format(dt)}`; };
  const dayTxt = k => { const n = daysTo(k); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n > 1 && n < 7 ? wdFmt.format(fromKey(k)) : mdFmt.format(fromKey(k)); };
  // the line you read first
  function headline(p) {
    const eta = etaOf(p);
    if (p.stage === 'delivered') { const e = (p.events || [])[0]; return { big: 'Delivered', small: e ? whenTxt(evTime(e)) : 'Delivered', tone: 'done' }; }
    if (p.stage === 'out') return { big: 'Out for delivery', small: 'Arriving today', tone: 'now' };
    if (p.stage === 'exception') return { big: 'Held up', small: ((p.events || [])[0] || {}).text || 'The carrier flagged a problem', tone: 'warn' };
    if (eta) {
      const n = daysTo(eta);
      if (n < 0) return { big: 'Running late', small: `It was due ${mdFmt.format(fromKey(eta))}`, tone: 'warn' };
      const word = dayTxt(eta);
      return { big: `Arriving ${word}`, small: n > 1 ? `${mdFmt.format(fromKey(eta))} · ${n} days` : mdFmt.format(fromKey(eta)), tone: n <= 1 ? 'now' : '' };
    }
    return p.stage === 'transit' ? { big: 'On the way', small: 'No delivery date yet', tone: '' } : { big: 'Shipped', small: 'Waiting on the first scan', tone: '' };
  }
  const STEPS = [['label', 'Shipped'], ['transit', 'On the way'], ['out', 'Out for delivery'], ['delivered', 'Delivered']];
  const stepOf = p => Math.max(0, STEPS.findIndex(s => s[0] === (p.stage === 'exception' ? 'transit' : p.stage)));
  const stateName = c => (M() && M().names[c]) || c;

  /* ---------- the map ---------- */
  // the drawing is framed around what matters: the package, home, and where it started
  function frame(pts) {
    const m = M();
    if (!pts.length) return { x: 0, y: 0, w: m.W, h: m.H };
    let x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
    let w = Math.max(x1 - x0 + 170, 170), h = Math.max(y1 - y0 + 130, 106);
    if (w / h > 1.6) h = w / 1.6; else w = h * 1.6;
    if (w > m.W) { w = m.W; h = m.H; }
    let x = (x0 + x1) / 2 - w / 2, y = (y0 + y1) / 2 - h / 2;
    x = Math.max(-20, Math.min(m.W - w + 20, x)); y = Math.max(-20, Math.min(m.H - h + 20, y));
    return { x, y, w, h };
  }
  // which state a spot on the drawing falls in (home's state gets outlined)
  let probe = null;
  const stateCache = new Map();
  function stateAt(pt) {
    const k = pt.map(v => Math.round(v)).join(',');
    if (stateCache.has(k)) return stateCache.get(k);
    let hit = null;
    try {
      probe = probe || document.createElement('canvas').getContext('2d');
      for (const [c, d] of Object.entries(M().states)) if (probe.isPointInPath(new Path2D(d), pt[0], pt[1])) { hit = c; break; }
    } catch (e) { hit = null; }
    stateCache.set(k, hit);
    return hit;
  }
  function mapSvg(p) {
    const m = M(), h = home();
    if (!m) return '';
    const P = w => m.project(w.lon, w.lat);
    const hp = placed(h) ? P(h) : null, wp = placed(p.where) ? P(p.where) : null, fp = placed(p.from) ? P(p.from) : null;
    const delivered = p.stage === 'delivered';
    const pts = [hp, delivered ? null : wp].filter(Boolean); // where it started trails off the edge: what matters is here and home
    const vb = frame(pts), u = vb.w / 640; // a marker "pixel" at any zoom (the map shows about 640 wide on the iPad)
    const hereState = !delivered && p.where && p.where.state, homeState = hp ? stateAt(hp) : null;
    const states = Object.entries(m.states).map(([c, d]) => `<path d="${d}" class="pk-st${c === hereState ? ' here' : ''}${c === homeState ? ' home' : ''}"/>`).join('');
    let route = '', mid = null;
    if (wp && hp && !delivered) {
      const dx = hp[0] - wp[0], dy = hp[1] - wp[1], len = Math.hypot(dx, dy) || 1;
      const cx = (wp[0] + hp[0]) / 2 - dy / len * len * 0.18, cy = (wp[1] + hp[1]) / 2 + dx / len * len * 0.18;
      mid = [0.25 * wp[0] + 0.5 * cx + 0.25 * hp[0], 0.25 * wp[1] + 0.5 * cy + 0.25 * hp[1]];
      route = `<path class="pk-route" d="M${wp[0].toFixed(1)} ${wp[1].toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${hp[0].toFixed(1)} ${hp[1].toFixed(1)}"/>`;
    }
    const trail = fp && wp && !delivered && Math.hypot(fp[0] - wp[0], fp[1] - wp[1]) > 4 ? `<path class="pk-trail" d="M${fp[0].toFixed(1)} ${fp[1].toFixed(1)} L${wp[0].toFixed(1)} ${wp[1].toFixed(1)}"/><circle class="pk-from" cx="${fp[0].toFixed(1)}" cy="${fp[1].toFixed(1)}" r="${(2.6 * u).toFixed(2)}"/>` : '';
    const mi = placed(h) && placed(p.where) && !delivered ? miles(h, p.where) : null;
    const pill = mid && mi != null && mi >= 15 ? (() => {
      const t = `${mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString()} mi`, fs = 11 * u, w = (t.length * 0.6 + 1.6) * fs, hh = fs * 1.9;
      return `<g class="pk-pill"><rect x="${(mid[0] - w / 2).toFixed(1)}" y="${(mid[1] - hh / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${hh.toFixed(1)}" rx="${(hh / 2).toFixed(1)}"/><text x="${mid[0].toFixed(1)}" y="${(mid[1] + fs * 0.36).toFixed(1)}" font-size="${fs.toFixed(2)}">${t}</text></g>`;
    })() : '';
    const homeMark = hp ? `<g class="pk-home" transform="translate(${hp[0].toFixed(1)} ${hp[1].toFixed(1)}) scale(${u.toFixed(3)})"><circle r="9"/><path d="M-4.5 0.5 0 -4 4.5 0.5V4.5H-4.5z"/></g>` : '';
    const boxMark = wp && !delivered ? `<g class="pk-here" transform="translate(${wp[0].toFixed(1)} ${wp[1].toFixed(1)}) scale(${u.toFixed(3)})"><circle class="pk-pulse" r="9"/><circle class="pk-dot" r="6.5"/></g>` : '';
    return `<svg class="pk-map" viewBox="${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(mapLabel(p, mi))}">
      <g class="pk-land">${states}</g>${trail}${route}${pill}${homeMark}${boxMark}</svg>`;
  }
  function mapLabel(p, mi) {
    if (p.stage === 'delivered') return 'Delivered home';
    if (!placed(p.where)) return 'Map of home; the package has no location yet';
    return `The package is in ${p.where.city ? p.where.city + ', ' : ''}${stateName(p.where.state)}${mi != null ? `, about ${Math.round(mi)} miles from home` : ''}`;
  }

  /* ---------- markup ---------- */
  function card(p) {
    const hd = headline(p), step = stepOf(p), last = (p.events || [])[0], open = UI.open.has(p.id);
    const where = p.stage === 'delivered' ? null : placed(p.where) ? `${p.where.city ? p.where.city + ', ' : ''}${stateName(p.where.state || '')}` : null;
    const h = home(), mi = where && placed(h) ? miles(h, p.where) : null;
    const title = p.name || (p.store ? `From ${p.store}` : 'Package');
    return `<article class="float pk-card${hd.tone ? ' t-' + hd.tone : ''}" data-pkg="${esc(p.id)}">
      <div class="pk-top">
        <span class="pk-what">${esc(title)}</span>
        <h3 class="pk-big">${esc(hd.big)}</h3>
        <span class="pk-small">${esc(hd.small)}</span>
        ${where ? `<p class="pk-where"><span class="pk-in">In ${esc(where)}</span>${mi != null ? `<span class="pk-far">${mi < 1 ? 'Nearly home' : `${mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString()} miles from home`}</span>` : ''}</p>` : ''}
      </div>
      <div class="pk-mapbox">${mapSvg(p)}${!placed(p.where) && p.stage !== 'delivered' ? `<span class="pk-note">${UI.key === false ? 'Its location shows here once live tracking is on' : 'Its location shows here after the first scan'}</span>` : ''}</div>
      <div class="pk-rest">
        <ol class="pk-steps" aria-label="Progress">${STEPS.map(([k, l], i) => `<li class="${i < step ? 'done' : i === step ? 'now' : ''}"${i === step ? ' aria-current="step"' : ''}><i></i><span>${l}</span></li>`).join('')}</ol>
        ${last ? `<button type="button" class="pk-last" data-act="pk-hist" data-id="${esc(p.id)}" aria-expanded="${open}"><span class="pk-ltx"><span>${esc(last.text)}</span><span class="meta">${esc([last.place, whenTxt(evTime(last))].filter(Boolean).join(' · '))}</span></span>${(p.events || []).length > 1 ? `<span class="pk-chev">${ICON.chev}</span>` : ''}</button>` : ''}
        ${open ? `<ol class="pk-hist">${(p.events || []).slice(1).map(e => `<li><span>${esc(e.text)}</span><span class="meta">${esc([e.place, whenTxt(evTime(e))].filter(Boolean).join(' · '))}</span></li>`).join('')}</ol>` : ''}
        <div class="pk-foot">
          <a class="pk-num" href="${esc(p.url || '#')}" target="_blank" rel="noopener" title="Open on ${esc(p.carrier || 'the carrier')}'s site">${esc(p.carrier || 'Tracking')} ${esc(p.trackNo)}</a>
          ${ctx.canSave() ? `<button type="button" class="circle" data-act="pk-refresh" data-id="${esc(p.id)}" aria-label="Check now" title="Check now"${UI.busy.has(p.id) ? ' disabled' : ''}>${ICON.refresh}</button>
          <button type="button" class="circle${UI.armed === p.id ? ' armed' : ''}" data-act="pk-del" data-id="${esc(p.id)}" aria-label="${UI.armed === p.id ? 'Tap again to remove' : 'Remove'}" title="${UI.armed === p.id ? 'Tap again to remove' : 'Remove'}">${ICON.trash}</button>` : ''}
        </div>
      </div>
    </article>`;
  }
  const doneRow = p => `<button type="button" class="pk-row" data-act="pk-open-done" data-id="${esc(p.id)}"><span class="pk-ric">${ICON.box}</span><span class="pk-rtx"><span class="name">${esc(p.name || p.store || 'Package')}</span><span class="meta">${esc(headline(p).small)}</span></span>${ICON.chev}</button>`;
  function keyCard() {
    return `<section class="float pk-key"><h3>Turn on live tracking</h3>
      <p>POS uses Track123 to see where packages are. It's free for up to 50 packages a month.</p>
      ${ctx.canSave() ? `<form class="pk-keyform" id="pkKey" autocomplete="off"><input id="pk_key" placeholder="Paste your Track123 key" autocomplete="off" spellcheck="false"><button type="submit" class="btn solid">Turn on</button></form>` : ''}</section>`;
  }
  function view() {
    if (S.failed) return '<div class="pkgs"><p class="empty">Packages did not load. Check the connection; POS tries again when you come back to it.</p></div>';
    if (!S.loaded) return '<div class="pkgs"><p class="empty">Loading…</p></div>';
    askKey();
    const all = S.package.slice().sort((a, b) => (etaOf(a) || '9').localeCompare(etaOf(b) || '9') || (b.createdAt || 0) - (a.createdAt || 0));
    const recent = p => p.stage === 'delivered' && Date.now() - (p.deliveredAt || p.checkedAt || 0) > 2 * 86400000;
    const active = all.filter(p => !recent(p)), done = all.filter(recent).sort((a, b) => (b.deliveredAt || 0) - (a.deliveredAt || 0)).slice(0, 10);
    const body = (UI.key === false ? keyCard() : '')
      + (active.length ? active.map(card).join('') : `<div class="float pk-empty"><span class="pk-ric">${ICON.box}</span><p>Nothing on its way. Add a tracking number, or POS picks them up from shipping emails.</p>${ctx.canSave() ? '<button type="button" class="btn solid" data-act="pk-add">Add a package</button>' : ''}</div>`)
      + (done.length ? `<section class="sec"><div class="sec-head"><span class="lab">Delivered</span></div><div class="float list">${done.map(doneRow).join('')}</div></section>` : '');
    return `<div class="pkgs"><div class="pkgs-scroll" id="pkgsScroll" data-keep>${body}</div></div>`;
  }

  /* ---------- talking to the packages function ---------- */
  const call = async body => {
    const { data, error } = await ctx.sb.functions.invoke('packages', { body });
    if (error) { let msg = ''; try { msg = (await error.context.json()).error; } catch (e) { /* no detail */ } throw new Error(msg || 'POS could not reach the tracker.'); }
    return data || {};
  };
  async function askKey() {
    if (UI.asked || !ctx.canSave()) return;
    UI.asked = true;
    try { const d = await call({ action: 'status' }); UI.key = !!d.key; ctx.rerender(); } catch (e) { UI.asked = false; }
  }
  document.addEventListener('submit', async e => {
    if (!e.target || e.target.id !== 'pkKey') return;
    e.preventDefault();
    const inp = document.getElementById('pk_key'), key = inp ? inp.value.trim() : '';
    if (!key) { if (inp) inp.focus(); return; }
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking…';
    try { const d = await call({ action: 'set-key', key }); UI.key = true; toast(d.checked ? `Live tracking on. Checked ${d.checked} ${d.checked === 1 ? 'package' : 'packages'}.` : 'Live tracking on'); R.load(); }
    catch (err) { toast(err.message || 'That key did not work.'); btn.disabled = false; btn.textContent = 'Turn on'; }
  });
  function addSheet() {
    const f = (label, inner, hint) => `<label class="f"><span class="lab">${label}</span>${inner}${hint ? `<span class="meta">${hint}</span>` : ''}</label>`;
    window.POSSheet.open({
      title: 'Add a package',
      body: f('Tracking number', '<input id="pk_no" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="1Z… or 9400…">', 'UPS, USPS, FedEx, Amazon and DHL work out on their own.')
        + f('What it is', '<input id="pk_name" maxlength="80" autocomplete="off" placeholder="Optional, like Desk lamp">'),
      saveLabel: 'Add package',
      submit: async () => {
        const trackNo = (document.getElementById('pk_no').value || '').replace(/\s+/g, '');
        if (trackNo.length < 8) return 'Paste the tracking number from the shipping email.';
        try { await call({ action: 'add', trackNo, name: (document.getElementById('pk_name').value || '').trim() || null }); R.load(); toast('Package added'); return true; }
        catch (err) { return err.message; }
      },
    });
  }
  async function act(name, b) {
    const id = b.dataset.id;
    if (name === 'pk-hist') { if (UI.open.has(id)) UI.open.delete(id); else UI.open.add(id); ctx.rerender(); return; }
    if (name === 'pk-open-done') { const p = S.package.find(x => x.id === id); if (p && p.url) window.open(p.url, '_blank', 'noopener'); return; }
    if (!ctx.canSave()) return;
    if (name === 'pk-add') addSheet();
    else if (name === 'pk-refresh') {
      UI.busy.add(id); ctx.rerender();
      try { const d = await call({ action: 'refresh', ids: [id] }); toast(d.why === 'no-key' ? 'Live tracking is off. Add the Track123 key first.' : 'Checked just now'); R.load(); }
      catch (err) { toast(err.message); }
      UI.busy.delete(id); ctx.rerender();
    } else if (name === 'pk-del') {
      if (UI.armed !== id) { UI.armed = id; ctx.rerender(); setTimeout(() => { if (UI.armed === id) { UI.armed = null; ctx.rerender(); } }, 4000); return; }
      UI.armed = null;
      const p = S.package.find(x => x.id === id);
      if (await R.save(R.db.remove('package', id))) toast(`Removed ${p && p.name ? p.name : 'the package'}`);
    }
  }
  // out for delivery, or arriving today: worth a number on the rail
  const badge = () => (S.loaded ? S.package.filter(p => p.stage === 'out' || (p.stage !== 'delivered' && etaOf(p) && daysTo(etaOf(p)) === 0)).length : 0);
  // for the quiet Home: out for delivery, or delivered today
  const homeToday = () => (S.loaded ? S.package.filter(p => !p.archived && (p.stage === 'out' || (p.stage === 'delivered' && p.deliveredAt && new Date(p.deliveredAt).toDateString() === new Date().toDateString())))
    .map(p => ({ id: p.id, name: p.name || p.store || 'A package', out: p.stage === 'out' })) : []);
  // what's on its way, for the assistant: a name and the line you'd read first
  const summary = () => (S.loaded ? S.package.slice().sort((a, b) => (a.stage === 'delivered') - (b.stage === 'delivered') || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8)
    .map(p => { const h = headline(p); return { name: String(p.name || p.store || p.trackNo || 'Package').slice(0, 60), status: `${h.big}${h.small ? ' · ' + h.small : ''}`.slice(0, 80) }; }) : []);
  return { view, act, add: addSheet, badge, homeToday, summary, start: R.start, stop: () => { R.stop(); UI.asked = false; UI.key = null; } };
};
