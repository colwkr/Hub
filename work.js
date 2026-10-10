// POS Work: the weekly CG checklist. Every campus's CG machine gets its graphics put in by Sunday; Simpsonville has three
// (CG1, CG2 and the North Auditorium). A week runs Monday to Sunday, so Monday at midnight starts a fresh list due the
// next Sunday. Records: kind "cg-week", id "cg-<Sunday>", { due: 'YYYY-MM-DD', done: { <machine id>: when } }.
window.POSWork = function (ctx) {
  const { esc } = ctx;
  const KIND = 'cg-week';
  const R = window.POSRecords({ ...ctx, onLoad: () => keepMine() }, [KIND], 'pos-work');
  const S = R.S;
  const MACHINES = [
    { id: 'anderson', name: 'Anderson' },
    { id: 'fiveforks', name: 'Five Forks' },
    { id: 'fountaininn', name: 'Fountain Inn' },
    { id: 'greenville', name: 'Greenville' },
    { id: 'gcc', name: 'GCC' },
    { id: 'harrisonbridge', name: 'Harrison Bridge' },
    { id: 'laurens', name: 'Laurens' },
    { id: 'mauldin', name: 'Mauldin' },
    { id: 'union', name: 'Union' },
    { id: 'simp-cg1', name: 'CG1', group: 'Simpsonville' },
    { id: 'simp-cg2', name: 'CG2', group: 'Simpsonville' },
    { id: 'simp-north', name: 'North Auditorium', group: 'Simpsonville' },
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
    const id = weekId(), due = id.slice(3);
    const done = { ...doneMap() };
    if (done[mid]) delete done[mid]; else done[mid] = Date.now();
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
  function tile(m, done) {
    const on = !!done[m.id];
    return `<button type="button" class="wk-t${on ? ' on' : ''}" data-act="wk-cg" data-id="${m.id}" aria-pressed="${on}"><span class="wk-c">${ICON.check}</span><span class="wk-tx"><span class="name">${esc(m.name)}</span><span class="meta">${on ? 'Put in' : 'Not started'}</span></span></button>`;
  }
  function cgCard() {
    if (S.failed) return '<section class="float wk-cg"><p class="empty">CG list did not load. POS tries again when you come back to it.</p></section>';
    if (!S.loaded) return '<section class="float wk-cg"><p class="empty">Loading…</p></section>';
    const due = dueDate(), done = doneMap();
    const n = MACHINES.filter(m => done[m.id]).length, left = MACHINES.length - n;
    const late = left && dueText(due) === 'Due today';
    const main = MACHINES.filter(m => !m.group), simp = MACHINES.filter(m => m.group === 'Simpsonville');
    return `<section class="float wk-cg${left ? '' : ' all'}">
      <div class="wk-h">
        <div class="wk-when"><span class="lab">CG · ${dueText(due)}</span><span class="wk-due">${esc(fmtDue(due))}</span></div>
        <div class="wk-big${late ? ' late' : ''}">${left ? `<b>${left}</b><span>left</span>` : `<span class="wk-allc">${ICON.check}</span><span>All put in</span>`}</div>
      </div>
      <div class="wk-bar" role="progressbar" aria-label="CG put in" aria-valuemin="0" aria-valuemax="${MACHINES.length}" aria-valuenow="${n}"><i style="width:${(n / MACHINES.length * 100).toFixed(1)}%"></i></div>
      <div class="wk-tiles">${main.map(m => tile(m, done)).join('')}</div>
      <div class="wk-sub"><span class="lab">Simpsonville</span><div class="wk-tiles">${simp.map(m => tile(m, done)).join('')}</div></div>
    </section>`;
  }
  function act(name, b) {
    if (name === 'wk-cg') toggle(b.dataset.id);
  }
  // how many are left this week (for a badge)
  const left = () => (S.loaded ? MACHINES.filter(m => !doneMap()[m.id]).length : 0);
  return { cgCard, act, left, start: R.start, stop: R.stop, dueDate };
};
