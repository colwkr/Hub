// POS records: storage and a form sheet shared by the smaller sections (birthdays, pets, lights, notes).
// Everything lives in the Supabase table records (one row per thing, owner-only); each section asks for its own kinds.
window.POSRecords = function (ctx, kinds, channelName) {
  const { sb, rerender } = ctx;
  const S = { loaded: false, failed: false };
  for (const k of kinds) S[k] = [];
  const must = ({ error }) => { if (error) throw error; };
  const strip = d => { const { id, ...rest } = d || {}; return rest; };
  const newId = p => p + '-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  let loadT = null, channel = null;
  const scheduleLoad = () => { clearTimeout(loadT); loadT = setTimeout(load, 300); };
  const db = {
    async set(k, id, d) {
      S[k] = S[k].filter(x => x.id !== id).concat([{ ...d, id }]); rerender();
      try { must(await sb.from('records').insert({ id, kind: k, data: d })); } catch (e) { scheduleLoad(); throw e; }
    },
    async update(k, id, patch) {
      const cur = S[k].find(x => x.id === id);
      if (!cur) throw new Error('missing');
      const merged = { ...strip(cur), ...patch };
      Object.assign(cur, patch); rerender();
      try { must(await sb.from('records').update({ data: merged }).eq('id', id)); } catch (e) { scheduleLoad(); throw e; }
    },
    async remove(k, id) {
      S[k] = S[k].filter(x => x.id !== id); rerender();
      try { must(await sb.from('records').delete().eq('id', id)); } catch (e) { scheduleLoad(); throw e; }
    },
  };
  async function save(p) {
    try { await p; return true; } catch (e) { ctx.toast('That did not save. Check your connection and try again.'); return false; }
  }
  async function load() {
    const { data, error } = await sb.from('records').select('id,kind,data').in('kind', kinds).limit(5000);
    if (error) { S.failed = true; rerender(); return; }
    S.failed = false; S.loaded = true;
    for (const k of kinds) S[k] = [];
    for (const r of data) S[r.kind].push({ ...r.data, id: r.id });
    if (ctx.onLoad) await ctx.onLoad();
    rerender();
  }
  function start() {
    load();
    if (channel) sb.removeChannel(channel);
    channel = sb.channel(channelName).on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, scheduleLoad).subscribe();
  }
  function stop() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    S.loaded = false; S.failed = false; for (const k of kinds) S[k] = [];
  }
  return { S, db, save, newId, start, stop, load };
};

// One form sheet for those sections. open({ title, body, del, submit, remove, ready }):
// submit() returns true to close, or a message to show; remove() deletes after a second tap.
window.POSSheet = (function () {
  let spec = null, armed = false;
  const $ = s => document.querySelector(s);
  function build() {
    if ($('#recSheet')) return;
    document.body.insertAdjacentHTML('beforeend', `<dialog id="recSheet" aria-labelledby="recTitle">
      <form id="recForm" novalidate>
        <div class="sheet-head" id="recHead"><div class="grab"></div><div class="bar"><h2 id="recTitle"></h2><button type="button" class="circle" id="recClose" aria-label="Close"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></div></div>
        <div id="recBody" class="sheet-body"></div>
        <p id="recErr" class="err" hidden></p>
        <div class="sheet-foot" id="recFoot"><button type="button" id="recDel" class="btn danger" hidden>Delete</button><button type="submit" id="recSave" class="btn solid">Save</button></div>
      </form>
    </dialog>`);
    const sheet = $('#recSheet');
    $('#recClose').addEventListener('click', close);
    sheet.addEventListener('close', () => { spec = null; });
    $('#recDel').addEventListener('click', async e => {
      if (!spec || !spec.remove) return;
      const b = e.currentTarget;
      if (!armed) { armed = true; b.classList.add('armed'); b.textContent = 'Tap again to delete'; return; }
      b.disabled = true;
      const ok = await spec.remove();
      b.disabled = false;
      if (ok) close();
    });
    $('#recForm').addEventListener('submit', async e => {
      e.preventDefault();
      if (!spec || !spec.submit) { close(); return; }
      $('#recErr').hidden = true;
      const btn = $('#recSave');
      btn.disabled = true;
      const r = await spec.submit();
      btn.disabled = false;
      if (r === true) close();
      else if (typeof r === 'string') { const er = $('#recErr'); er.textContent = r; er.hidden = false; }
    });
    // pull the sheet down by its top edge to dismiss
    let pull = null;
    sheet.addEventListener('touchstart', e => {
      pull = null;
      if (e.touches.length !== 1 || !e.target.closest('#recHead') || e.target.closest('button')) return;
      pull = { y0: e.touches[0].clientY, dy: 0, on: false };
    }, { passive: true });
    sheet.addEventListener('touchmove', e => {
      if (!pull) return;
      const dy = e.touches[0].clientY - pull.y0;
      if (!pull.on) { if (Math.abs(dy) < 6) return; if (dy < 0) { pull = null; return; } pull.on = true; sheet.style.transition = 'none'; }
      e.preventDefault();
      pull.dy = Math.max(0, dy);
      sheet.style.transform = `translateY(${pull.dy}px)`;
    }, { passive: false });
    const endPull = () => {
      if (!pull) return;
      const p = pull; pull = null;
      sheet.style.transition = '';
      if (p.on && p.dy > 90) close();
      sheet.style.transform = '';
    };
    sheet.addEventListener('touchend', endPull);
    sheet.addEventListener('touchcancel', endPull);
  }
  function open(s) {
    build();
    spec = s; armed = false;
    const sheet = $('#recSheet');
    $('#recTitle').textContent = s.title || '';
    $('#recBody').innerHTML = s.body || '';
    $('#recErr').hidden = true;
    const del = $('#recDel');
    del.hidden = !s.remove; del.textContent = s.delLabel || 'Delete'; del.classList.remove('armed'); del.disabled = false;
    const save = $('#recSave');
    save.hidden = s.submit === null; save.textContent = s.saveLabel || 'Save'; save.disabled = false;
    $('#recFoot').hidden = save.hidden && del.hidden;
    sheet.style.transform = '';
    if (!sheet.open) sheet.showModal();
    if (s.ready) s.ready($('#recBody'));
  }
  // refresh what's showing without closing (a list that changed underneath)
  function refresh(s) { if (isOpen()) open(s); }
  function close() { const sheet = $('#recSheet'); if (sheet && sheet.open) sheet.close(); spec = null; }
  const isOpen = () => !!($('#recSheet') && $('#recSheet').open);
  return { open, close, isOpen, refresh, current: () => spec };
})();
