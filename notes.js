// POS Notes: plain notes that save as you type. A list (pinned first, then the latest) and the note you're writing;
// side by side on the iPad and the computer, one at a time on the phone.
// Records: kind "note" { title, body, pinned, createdAt, updatedAt }.
window.POSNotes = function (ctx) {
  const { esc, toast, sb } = ctx;
  const UI = { sel: null, q: '', armed: false, saved: new Set(), local: new Map(), state: '' };
  const R = window.POSRecords({ ...ctx, onLoad }, ['note'], 'pos-notes');
  const S = R.S;
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    search: svg('<circle cx="11" cy="11" r="6"/><path d="m19.5 19.5-4.2-4.2"/>'),
    pin: svg('<path d="M9 4.5h6M10 4.5v5.2l-3 3.3h10l-3-3.3V4.5M12 13v6.5"/>'),
    trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7"/>'),
    back: svg('<path d="M14.5 6.5 9 12l5.5 5.5"/>'),
    note: svg('<path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M13.5 3.5V8h5M8.5 12.5h7M8.5 16h5"/>'),
  };
  const $ = s => document.querySelector(s);
  const tFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const yFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const wFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms), n = new Date(), day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ago = Math.round((day(n) - day(d)) / 864e5);
    if (ago === 0) return tFmt.format(d);
    if (ago === 1) return 'Yesterday';
    if (ago < 7) return wFmt.format(d);
    return d.getFullYear() === n.getFullYear() ? dFmt.format(d) : yFmt.format(d);
  }
  const noteById = id => S.note.find(n => n.id === id);
  const firstLine = s => (s || '').split('\n').map(x => x.trim()).find(Boolean) || '';
  const headOf = n => (n.title || '').trim() || firstLine(n.body) || 'New note';
  function snippetOf(n) {
    let body = (n.body || '').trim();
    if (!(n.title || '').trim()) body = body.split('\n').slice(1).join(' ');
    return body.replace(/\s+/g, ' ').slice(0, 140);
  }
  const sorted = () => S.note.slice().sort((a, b) => (!!b.pinned - !!a.pinned) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const matches = (n, q) => !q || `${n.title || ''}\n${n.body || ''}`.toLowerCase().includes(q.toLowerCase());

  // what's typed here wins over a copy from the server that's older (a reload can land mid-sentence)
  function onLoad() {
    for (const n of S.note) UI.saved.add(n.id);
    for (const [id, mine] of UI.local) {
      const srv = noteById(id);
      if (!srv) { if (!UI.saved.has(id)) S.note.push({ ...mine }); else UI.local.delete(id); }
      else if ((mine.updatedAt || 0) >= (srv.updatedAt || 0)) Object.assign(srv, mine);
      else UI.local.delete(id);
    }
  }

  /* ---------- markup ---------- */
  function rows() {
    const list = sorted().filter(n => matches(n, UI.q));
    if (!S.note.length) return '<p class="empty nt-empty">No notes yet. Start one with the + button.</p>';
    if (!list.length) return `<p class="empty nt-empty">Nothing matches “${esc(UI.q)}”.</p>`;
    return list.map(n => `<button type="button" class="nt-row${n.id === UI.sel ? ' sel' : ''}" data-act="nt-open" data-id="${esc(n.id)}"><span class="nt-rt"><span class="name">${n.pinned ? ICON.pin : ''}${esc(headOf(n))}</span><span class="meta"><b>${esc(when(n.updatedAt))}</b>${snippetOf(n) ? ' ' + esc(snippetOf(n)) : ''}</span></span></button>`).join('');
  }
  const bar = n => `<button type="button" class="btn nt-back" data-act="nt-back">${ICON.back}Notes</button>
    <span class="meta nt-state" data-nt-state>${n ? esc(UI.state || `Edited ${when(n.updatedAt)}`) : 'New note'}</span>
    ${n && ctx.canSave() ? `<button type="button" class="circle" data-act="nt-pin" aria-pressed="${!!n.pinned}" aria-label="${n.pinned ? 'Unpin' : 'Pin to the top'}" title="${n.pinned ? 'Unpin' : 'Pin to the top'}">${ICON.pin}</button>
    <button type="button" class="circle nt-del${UI.armed ? ' armed' : ''}" data-act="nt-del" aria-label="${UI.armed ? 'Tap again to delete' : 'Delete note'}" title="${UI.armed ? 'Tap again to delete' : 'Delete note'}">${ICON.trash}</button>` : ''}`;
  function editor() {
    const n = UI.sel && UI.sel !== 'new' ? noteById(UI.sel) : null;
    if (!UI.sel || (UI.sel !== 'new' && !n)) {
      return `<div class="nt-ed float nt-none"><span class="nt-big">${ICON.note}</span><p class="empty">Pick a note, or start a new one.</p>${ctx.canSave() ? '<button type="button" class="btn solid" data-act="nt-new">New note</button>' : ''}</div>`;
    }
    const can = ctx.canSave();
    return `<div class="nt-ed float" data-hold-render data-note="${n ? esc(n.id) : ''}">
      <div class="nt-bar">${bar(n)}</div>
      <input id="nt_title" class="nt-title" placeholder="Title" maxlength="140" autocomplete="off" value="${n ? esc(n.title || '') : ''}"${can ? '' : ' readonly'}>
      <textarea id="nt_body" class="nt-body" placeholder="Start writing" maxlength="50000"${can ? '' : ' readonly'}>${n ? esc(n.body || '') : ''}</textarea>
    </div>`;
  }
  function view() {
    if (S.failed) return '<div class="notes"><p class="empty">Notes did not load. Check the connection; POS tries again when you come back to it.</p></div>';
    if (!S.loaded) return '<div class="notes"><p class="empty">Loading…</p></div>';
    return `<div class="notes${UI.sel ? ' has-sel' : ''}">
      <div class="nt-side">
        <div class="nt-top" data-hold-render><label class="nt-search">${ICON.search}<input id="nt_q" type="search" placeholder="Search notes" autocomplete="off" value="${esc(UI.q)}"></label>
          ${ctx.canSave() ? `<button type="button" class="circle" data-act="nt-new" aria-label="New note" title="New note">${ICON.plus}</button>` : ''}</div>
        <div class="nt-list float" id="ntList" data-keep>${rows()}</div>
      </div>
      ${editor()}
    </div>`;
  }
  const paintList = () => { const l = $('#ntList'); if (l) l.innerHTML = rows(); };
  const paintState = t => { UI.state = t; const s = $('[data-nt-state]'); if (s) s.textContent = t; };

  /* ---------- saving as you type ---------- */
  let saveT = null, queue = Promise.resolve(), pending = null;
  function edit() {
    const ti = $('#nt_title'), bo = $('#nt_body');
    if (!ti || !bo || !ctx.canSave()) return;
    const title = ti.value, body = bo.value;
    let n = UI.sel && UI.sel !== 'new' ? noteById(UI.sel) : null;
    if (!n) {
      if (!title.trim() && !body.trim()) return;
      const now = Date.now();
      n = { id: R.newId('note'), title: '', body: '', pinned: false, createdAt: now, updatedAt: now };
      S.note.push(n);
      UI.sel = n.id;
      const ed = ti.closest('.nt-ed');
      ed.dataset.note = n.id;
      ed.querySelector('.nt-bar').innerHTML = bar(n); // now it can be pinned or deleted
    }
    Object.assign(n, { title, body, updatedAt: Date.now() });
    UI.local.set(n.id, { ...n });
    pending = n.id;
    paintList();
    paintState('Saving…');
    clearTimeout(saveT);
    saveT = setTimeout(flush, 700);
  }
  function flush() {
    clearTimeout(saveT);
    const id = pending;
    pending = null;
    if (!id) return queue;
    const n = noteById(id) || UI.local.get(id);
    if (!n) return queue;
    const data = { title: n.title || '', body: n.body || '', pinned: !!n.pinned, createdAt: n.createdAt || Date.now(), updatedAt: n.updatedAt || Date.now() };
    queue = queue.then(async () => {
      const isNew = !UI.saved.has(id);
      let res;
      try { res = isNew ? await sb.from('records').insert({ id, kind: 'note', data }) : await sb.from('records').update({ data }).eq('id', id); }
      catch (e) { res = { error: e }; }
      if (res.error) { pending = pending || id; paintState('Not saved yet'); toast('That note did not save. Check your connection; it tries again as you type.'); return; }
      UI.saved.add(id);
      if (UI.sel === id && !pending) paintState('Saved');
    });
    return queue;
  }
  document.addEventListener('input', e => {
    if (!e.target || !e.target.id) return;
    if (e.target.id === 'nt_q') { UI.q = e.target.value; paintList(); }
    else if (e.target.id === 'nt_title' || e.target.id === 'nt_body') edit();
  });
  // Enter in the title moves on to the note itself
  document.addEventListener('keydown', e => {
    if (e.target && e.target.id === 'nt_title' && e.key === 'Enter') { e.preventDefault(); const b = $('#nt_body'); if (b) { b.focus(); b.setSelectionRange(0, 0); } }
  });
  // leaving the note: save now, then let the page catch up
  // (a mouse still held down waits for its click to land first, or the redraw would swallow it)
  let held = false, late = false;
  document.addEventListener('pointerdown', () => { held = true; }, true);
  const release = () => { held = false; if (late) { late = false; setTimeout(() => ctx.rerender(), 0); } };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  document.addEventListener('focusout', e => {
    if (!(e.target.closest && e.target.closest('.nt-ed, .nt-top'))) return;
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a.closest && a.closest('.nt-ed[data-hold-render], .nt-top')) return;
      flush();
      if (UI.sel === 'new') UI.sel = null;
      if (held) late = true; else ctx.rerender();
    }, 0);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', () => flush());

  /* ---------- taps routed here by POS (data-act="nt-…") ---------- */
  const blurEditor = () => { const a = document.activeElement; if (a && a.closest && a.closest('.nt-ed, .nt-top')) a.blur(); };
  async function act(name, b) {
    if (name !== 'nt-del') UI.armed = false;
    if (name === 'nt-open') {
      blurEditor(); flush();
      UI.sel = b.dataset.id; UI.state = '';
      ctx.rerender();
    } else if (name === 'nt-back') {
      blurEditor(); flush();
      UI.sel = null; UI.state = '';
      ctx.rerender();
    } else if (name === 'nt-new') {
      if (!ctx.canSave()) return;
      blurEditor(); flush();
      UI.sel = 'new'; UI.state = '';
      ctx.rerender();
      requestAnimationFrame(() => { const t = $('#nt_title'); if (t) t.focus(); });
    } else if (name === 'nt-pin') {
      const n = noteById(UI.sel);
      if (!n || !ctx.canSave()) return;
      blurEditor();
      n.pinned = !n.pinned;
      UI.local.set(n.id, { ...n });
      pending = n.id;
      flush();
      toast(n.pinned ? 'Pinned to the top' : 'Unpinned');
      ctx.rerender();
    } else if (name === 'nt-del') {
      const n = noteById(UI.sel);
      if (!n || !ctx.canSave()) return;
      if (!UI.armed) { UI.armed = true; b.classList.add('armed'); b.setAttribute('aria-label', 'Tap again to delete'); b.title = 'Tap again to delete'; toast('Tap the trash again to delete this note'); return; }
      UI.armed = false;
      blurEditor();
      clearTimeout(saveT); if (pending === n.id) pending = null;
      await queue;
      UI.local.delete(n.id);
      UI.sel = null; UI.state = '';
      if (UI.saved.has(n.id)) { if (await R.save(R.db.remove('note', n.id))) toast('Note deleted'); }
      else { S.note = S.note.filter(x => x.id !== n.id); ctx.rerender(); }
    }
  }
  const add = () => act('nt-new', null);
  function stop() { flush(); R.stop(); UI.saved.clear(); UI.local.clear(); UI.sel = null; }
  return { view, act, add, start: R.start, stop };
};
