// POS Reminders: things to remember that aren't tasks. No time on the calendar, nothing scheduled: a line to keep in
// mind, maybe a few details under it, and maybe a day it should come back up. Lives next to Notes.
// Records: kind "reminder" { text, details, on: 'YYYY-MM-DD' | null, done, doneAt, createdAt }.
window.POSReminders = function (ctx) {
  const { esc, toast } = ctx;
  const R = window.POSRecords(ctx, ['reminder'], 'pos-reminders');
  const S = R.S;
  const UI = { showDone: false };
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    check: svg('<path d="m6 12.5 4 4 8-9"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    bell: svg('<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
    chev: svg('<path d="M9.5 6.5 15 12l-5.5 5.5"/>'),
  };
  const pad = n => String(n).padStart(2, '0');
  const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => dkey(new Date());
  const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const dFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  function onText(k) {
    if (!k) return '';
    const days = Math.round((fromKey(k) - fromKey(today())) / 864e5);
    return days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : dFmt.format(fromKey(k));
  }
  const byId = id => S.reminder.find(r => r.id === id);
  const open = () => S.reminder.filter(r => !r.done);
  // now: no day, or its day has come; later: a day still ahead (soonest first)
  const nowList = () => open().filter(r => !r.on || r.on <= today()).sort((a, b) => (a.on || '9') .localeCompare(b.on || '9') || (b.createdAt || 0) - (a.createdAt || 0));
  const laterList = () => open().filter(r => r.on && r.on > today()).sort((a, b) => a.on.localeCompare(b.on));
  const doneList = () => S.reminder.filter(r => r.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const due = () => (S.loaded ? open().filter(r => r.on && r.on <= today()).length : 0);

  /* ---------- markup ---------- */
  function row(r) {
    const lines = String(r.details || '').split('\n').map(x => x.trim()).filter(Boolean);
    const late = r.on && r.on <= today() && !r.done;
    return `<div class="rm-row${r.done ? ' done' : ''}">
      <button type="button" class="chk" data-act="rm-done" data-id="${esc(r.id)}" aria-pressed="${!!r.done}" aria-label="${r.done ? 'Bring back' : 'Done with'}: ${esc(r.text)}">${ICON.check}</button>
      <button type="button" class="rm-main" data-act="rm-edit" data-id="${esc(r.id)}">
        <span class="name">${esc(r.text)}</span>
        ${lines.length ? `<ul class="rm-lines">${lines.map(x => `<li>${esc(x.replace(/^[-•*]\s*/, ''))}</li>`).join('')}</ul>` : ''}
      </button>
      ${r.on ? `<span class="rm-on${late ? ' due' : ''}">${esc(onText(r.on))}</span>` : ''}
    </div>`;
  }
  const sec = (label, list) => (list.length ? `<section class="sec"><div class="sec-head"><span class="lab">${label}</span></div><div class="float list rm-list">${list.map(row).join('')}</div></section>` : '');
  function view() {
    if (S.failed) return '<div class="rem"><p class="empty">Reminders did not load. Check the connection; POS tries again when you come back to it.</p></div>';
    if (!S.loaded) return '<div class="rem"><p class="empty">Loading…</p></div>';
    const now = nowList(), later = laterList(), done = doneList();
    const add = ctx.canSave() ? `<form class="rm-add float" id="rmAdd" data-hold-render autocomplete="off"><span class="rm-add-ic">${ICON.plus}</span><input id="rm_text" maxlength="200" placeholder="Remind me to…" enterkeyhint="done"><input id="rm_on" type="date" aria-label="Bring it up on (optional)" title="Bring it up on (optional)"><button type="submit" class="btn solid">Add</button></form>` : '';
    const body = !S.reminder.length ? '<p class="empty">Nothing to remember yet. Things that aren\'t tasks go here: ideas to come back to, things to start someday.</p>'
      : sec('Now', now) + sec('Later', later) + (!now.length && !later.length ? '<p class="empty">All caught up.</p>' : '')
        + (done.length ? `<button type="button" class="link rm-donebtn" data-act="rm-showdone" aria-expanded="${UI.showDone}">${UI.showDone ? 'Hide done' : `Done (${done.length})`}</button>${UI.showDone ? sec('Done', done.slice(0, 30)) : ''}` : '');
    return `<div class="rem"><div class="rem-scroll" id="remScroll" data-keep>${add}${body}</div></div>`;
  }

  /* ---------- changes ---------- */
  async function addOne(text, on) {
    text = String(text || '').trim().slice(0, 200);
    if (!text || !ctx.canSave()) return false;
    const ok = await R.save(R.db.set('reminder', R.newId('reminder'), { text, details: '', on: on || null, done: false, doneAt: null, createdAt: Date.now() }));
    if (ok) toast(on ? `Reminder for ${onText(on).toLowerCase() === 'today' ? 'today' : onText(on)}` : 'Reminder added');
    return ok;
  }
  document.addEventListener('submit', async e => {
    if (!e.target || e.target.id !== 'rmAdd') return;
    e.preventDefault();
    const t = document.getElementById('rm_text'), d = document.getElementById('rm_on');
    if (!t || !t.value.trim()) { if (t) t.focus(); return; }
    const text = t.value, on = d && d.value ? d.value : null;
    t.value = ''; if (d) d.value = '';
    // let go of the box so the list can redraw with the new one; on a keyboard, carry on typing the next
    t.blur();
    await addOne(text, on);
    if (!window.matchMedia('(pointer:coarse)').matches) requestAnimationFrame(() => { const x = document.getElementById('rm_text'); if (x) x.focus(); });
  });
  function edit(r) {
    const f = (label, inner, hint) => `<label class="f"><span class="lab">${label}</span>${inner}${hint ? `<span class="meta">${hint}</span>` : ''}</label>`;
    window.POSSheet.open({
      title: 'Reminder',
      body: f('Remind me to', `<input id="rme_text" maxlength="200" autocomplete="off" value="${esc(r.text)}">`)
        + f('Details', `<textarea id="rme_details" rows="5" maxlength="4000" placeholder="One per line (optional)">${esc(r.details || '')}</textarea>`)
        + f('Bring it up on', `<input id="rme_on" type="date" value="${esc(r.on || '')}">`, 'Optional. Until then it waits under Later.'),
      delLabel: 'Delete reminder',
      remove: async () => { const ok = await R.save(R.db.remove('reminder', r.id)); if (ok) toast('Reminder deleted'); return ok; },
      submit: async () => {
        const text = (document.getElementById('rme_text').value || '').trim();
        if (!text) return 'Write what to remember.';
        const details = (document.getElementById('rme_details').value || '').trim();
        const on = document.getElementById('rme_on').value || null;
        return R.save(R.db.update('reminder', r.id, { text, details, on }));
      },
    });
  }
  function act(name, b) {
    if (name === 'rm-showdone') { UI.showDone = !UI.showDone; ctx.rerender(); return; }
    if (!ctx.canSave()) return;
    const r = b.dataset.id ? byId(b.dataset.id) : null;
    if (name === 'rm-done' && r) {
      const done = !r.done;
      R.save(R.db.update('reminder', r.id, { done, doneAt: done ? Date.now() : null }));
      if (done) toast('Done: ' + r.text, () => R.save(R.db.update('reminder', r.id, { done: false, doneAt: null })));
    } else if (name === 'rm-edit' && r) edit(r);
  }
  const add = () => { const t = document.getElementById('rm_text'); if (t) t.focus(); };
  return { view, act, add, due, start: R.start, stop: R.stop };
};
