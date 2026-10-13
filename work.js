// POS Work: the weekly CG checklist. Every campus's CG machine gets its graphics put in by Sunday, one list top to bottom
// in alphabetical order; Simpsonville has three (CG1, then CG2 and the North Auditorium tucked in under it). A week runs
// Monday to Sunday, so Monday at midnight starts a fresh list due the next Sunday. A tap checks or unchecks one (Undo in the toast). Records: kind "cg-week", id "cg-<Sunday>", { due: 'YYYY-MM-DD', done: { <machine id>: when } }.
window.POSWork = function (ctx) {
  const { esc } = ctx;
  const KIND = 'cg-week';
  const R = window.POSRecords({ ...ctx, onLoad: () => keepMine() }, [KIND], 'pos-work');
  const S = R.S;
  const MACHINES = [
    { id: 'anderson', name: 'Anderson' },
    { id: 'fiveforks', name: 'Five Forks' },
    { id: 'fountaininn', name: 'Fountain Inn' },
    { id: 'gcc', name: 'GCC' },
    { id: 'greenville', name: 'Greenville' },
    { id: 'harrisonbridge', name: 'Harrison Bridge' },
    { id: 'laurens', name: 'Laurens' },
    { id: 'mauldin', name: 'Mauldin' },
    { id: 'simp-cg1', name: 'Simpsonville – CG1' },
    { id: 'simp-cg2', name: 'Simpsonville – CG2', sub: true },
    { id: 'simp-north', name: 'Simpsonville – NA', sub: true, label: 'Simpsonville North Auditorium' },
    { id: 'union', name: 'Union' },
  ];
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = { check: svg('<path d="m6 12.5 4 4 8-9"/>') };

  const pad = n => String(n).padStart(2, '0');
  const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // the Sunday this week's list is due: today on a Sunday, and from Monday on, the coming one
  function dueDate(now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
    return d;
  }
  const weekId = () => 'cg-' + dkey(dueDate());
  const doneMap = () => { const r = S[KIND].find(x => x.id === weekId()); return (r && r.done) || {}; };

  // a tap shows at once; the saves go one after another, and a reload in between keeps what was just tapped
  let chain = Promise.resolve(), mine = null;
  function keepMine() {
    if (!mine || Date.now() > mine.until) return;
    const r = S[KIND].find(x => x.id === mine.id);
    if (r) r.done = { ...mine.done }; else S[KIND].push({ id: mine.id, due: mine.due, done: { ...mine.done } });
  }
  function toggle(mid) {
    if (!ctx.canSave() || !MACHINES.some(m => m.id === mid)) return;
    const done = { ...doneMap() };
    if (done[mid]) delete done[mid]; else done[mid] = Date.now();
    saveDone(done);
  }
  function saveDone(done) {
    const id = weekId(), due = id.slice(3);
    mine = { id, due, done, until: Date.now() + 60e3 };
    keepMine();
    ctx.rerender();
    chain = chain.then(async () => {
      const data = { due, done: { ...mine.done } };
      try {
        const { data: rows, error: e1 } = await ctx.sb.from('records').select('id').eq('id', id);
        if (e1) throw e1;
        const { error } = rows && rows.length ? await ctx.sb.from('records').update({ data }).eq('id', id) : await ctx.sb.from('records').insert({ id, kind: KIND, data });
        if (error) throw error;
        if (mine && mine.id === id) mine.until = Date.now() + 3000;
      } catch (err) {
        ctx.toast('That did not save. Check your connection and try again.');
        mine = null; R.load();
      }
    });
  }

  /* ---------- markup: a short list down the side of Work. A tap checks or unchecks; Undo is in the toast ---------- */
  const SHORT = { 'simp-cg1': 'Simpsonville CG1', 'simp-cg2': 'CG2', 'simp-north': 'North Aud.' };
  const fmtDue = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  function cgList() {
    if (S.failed) return '<section class="cg"><span class="lab">CG</span><p class="empty">Did not load. ' + posName() + ' tries again when you come back.</p></section>';
    if (!S.loaded) return '<section class="cg"><span class="lab">CG</span><p class="empty">Loading…</p></section>';
    const due = dueDate(), done = doneMap();
    const left = MACHINES.filter(m => !done[m.id]).length;
    const today = dkey(due) === dkey(new Date());
    const rows = MACHINES.map(m => {
      const on = !!done[m.id];
      return `<button type="button" class="cg-r${on ? ' on' : ''}${m.sub ? ' sub' : ''}" data-act="wk-cg" data-id="${m.id}" aria-pressed="${on}" aria-label="${esc(m.label || m.name)}, ${on ? 'put in' : 'not put in yet'}"><span class="wk-c">${ICON.check}</span><span class="name">${esc(SHORT[m.id] || m.name)}</span></button>`;
    }).join('');
    return `<section class="cg${left ? '' : ' all'}${left && today ? ' late' : ''}" aria-label="CG for ${esc(fmtDue(due))}">
      <div class="cg-h"><span class="lab">CG · ${esc(fmtDue(due))}</span><div class="cg-n">${left ? `<b>${left}</b><span>left</span>` : `<b>${ICON.check}</b><span>All in</span>`}</div></div>
      <div class="float cg-list">${rows}</div>
    </section>`;
  }
  function act(name, b) {
    if (!ctx.canSave() || name !== 'wk-cg') return;
    const id = b.dataset.id, m = MACHINES.find(x => x.id === id);
    if (!m) return;
    const was = !!doneMap()[id];
    toggle(id);
    ctx.toast(`${m.label || m.name}: ${was ? 'not put in' : 'put in'}`, () => toggle(id));
  }
  // how many are left this week (for a badge)
  const left = () => (S.loaded ? MACHINES.filter(m => !doneMap()[m.id]).length : 0);
  return { cgList, act, left, start: R.start, stop: R.stop, dueDate };
};
