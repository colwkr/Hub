// POS Work: the weekly CG checklist. Every campus's CG machine gets its graphics put in by Sunday, one list top to bottom
// in alphabetical order; Simpsonville has three (CG1, then CG2 and the North Auditorium tucked in under it). A week runs
// Monday to Sunday, so Monday at midnight starts a fresh list due the next Sunday. Checking or unchecking one asks first,
// and Reset clears the whole week (after asking). Records: kind "cg-week", id "cg-<Sunday>", { due: 'YYYY-MM-DD', done: { <machine id>: when } }.
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

  /* ---------- markup ---------- */
  const fmtDue = d => d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  function dueText(d) {
    const days = Math.round((d - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 864e5);
    return days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`;
  }
  // a tap asks first: the row turns into its question, with the answer and Cancel; it lets go on its own after a bit
  let armed = null, armT = null;
  function arm(id) {
    armed = id;
    clearTimeout(armT);
    if (id) armT = setTimeout(() => { armed = null; ctx.rerender(); }, 8000);
    ctx.rerender();
  }
  function row(m, done) {
    const on = !!done[m.id];
    if (armed === m.id) return `<div class="wk-r ask${on ? ' on' : ''}${m.sub ? ' sub' : ''}" role="group" aria-label="${esc(m.label || m.name)}"><span class="wk-c">${ICON.check}</span><span class="name">${esc(m.name)}</span>
      <button type="button" class="btn solid wk-yes" data-act="wk-yes" data-id="${m.id}">${on ? 'Mark not started' : 'Mark put in'}</button><button type="button" class="btn wk-no" data-act="wk-no">Cancel</button></div>`;
    return `<button type="button" class="wk-r${on ? ' on' : ''}${m.sub ? ' sub' : ''}" data-act="wk-cg" data-id="${m.id}" aria-pressed="${on}" aria-label="${esc(m.label || m.name)}, ${on ? 'put in' : 'not started'}"><span class="wk-c">${ICON.check}</span><span class="name">${esc(m.name)}</span><span class="meta">${on ? 'Put in' : 'Not started'}</span></button>`;
  }
  function cgCard() {
    if (S.failed) return '<section class="float wk-cg"><p class="empty">CG list did not load. POS tries again when you come back to it.</p></section>';
    if (!S.loaded) return '<section class="float wk-cg"><p class="empty">Loading…</p></section>';
    const due = dueDate(), done = doneMap();
    const n = MACHINES.filter(m => done[m.id]).length, left = MACHINES.length - n;
    const late = left && dueText(due) === 'Due today';
    return `<section class="float wk-cg${left ? '' : ' all'}">
      <div class="wk-h">
        <div class="wk-when"><span class="lab">CG · ${dueText(due)}</span><span class="wk-due">${esc(fmtDue(due))}</span></div>
        <div class="wk-big${late ? ' late' : ''}">${left ? `<b>${left}</b><span>left</span>` : `<span class="wk-allc">${ICON.check}</span><span>All put in</span>`}</div>
      </div>
      ${n && ctx.canSave() ? (armed === '_all'
        ? `<div class="wk-reset ask" role="group" aria-label="Reset the week"><span>Uncheck all ${n}?</span><button type="button" class="btn solid wk-yes" data-act="wk-reset-yes">Reset all</button><button type="button" class="btn wk-no" data-act="wk-no">Cancel</button></div>`
        : `<div class="wk-reset"><button type="button" class="btn wk-resetbtn" data-act="wk-reset">Reset all</button></div>`) : ''}
      <div class="wk-bar" role="progressbar" aria-label="CG put in" aria-valuemin="0" aria-valuemax="${MACHINES.length}" aria-valuenow="${n}"><i style="width:${(n / MACHINES.length * 100).toFixed(1)}%"></i></div>
      <div class="wk-list">${MACHINES.map(m => row(m, done)).join('')}</div>
    </section>`;
  }
  function act(name, b) {
    if (!ctx.canSave()) return;
    if (name === 'wk-cg') arm(b.dataset.id);
    else if (name === 'wk-reset') arm('_all');
    else if (name === 'wk-no') arm(null);
    else if (name === 'wk-yes') { const id = b.dataset.id; armed = null; clearTimeout(armT); const was = !!doneMap()[id]; toggle(id); const m = MACHINES.find(x => x.id === id); if (m) ctx.toast(`${m.label || m.name}: ${was ? 'not started' : 'put in'}`); }
    else if (name === 'wk-reset-yes') { armed = null; clearTimeout(armT); saveDone({}); ctx.toast('CG reset: all unchecked'); }
  }
  // how many are left this week (for a badge)
  const left = () => (S.loaded ? MACHINES.filter(m => !doneMap()[m.id]).length : 0);
  return { cgCard, act, left, start: R.start, stop: R.stop, dueDate };
};
