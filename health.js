// POS Health: sleep, the gym, runs and daily habits, logged by hand for now (a Garmin can fill in sleep later).
// Nothing is guessed: until something is logged its chart shows empty outlines.
// Records: kind "sleep" { bed, wake } (ms; wake is null while you're asleep), kind "workout" { type: 'gym'|'run', at, mins, miles, note },
//          kind "habit" { name, createdAt }, kind "habitlog" { habitId, day: 'YYYY-MM-DD' }.
window.POSHealth = function (ctx) {
  const { esc, toast } = ctx;
  const R = window.POSRecords(ctx, ['sleep', 'workout', 'habit', 'habitlog'], 'pos-health');
  const S = R.S;
  const HOUR = 36e5, DAY = 864e5, GOAL = 7.5; // hours of sleep the chart measures against
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const todayKey = () => keyOf(new Date());
  // a night belongs to the evening it started: going to bed at 1 AM on the 10th is the night of the 9th
  const nightOf = ms => keyOf(new Date(ms - 12 * HOUR));
  const tFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const dFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: 'narrow' });
  const mdFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const hm = ms => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? `${h} h ${pad(m % 60)} m` : `${m} m`; };
  const bigHM = ms => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return `${h}<small> h </small>${pad(m % 60)}<small> m</small>`; };
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    moon: svg('<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>'),
    gym: svg('<path d="M6.5 8v8M17.5 8v8M3.5 10v4M20.5 10v4M6.5 12h11"/>'),
    run: svg('<circle cx="14.5" cy="5" r="1.8"/><path d="M8 20.5l2.5-5 3 2V21M10.5 15.5 12 10l3 2.5 3 .5M12 10 8.5 9.5 6.5 12"/>'),
    check: svg('<path d="M5.5 12.5 10 17l8.5-9.5"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    edit: svg('<path d="M4.5 19.5h3.6L19 8.6 15.4 5 4.5 15.9zM13.6 6.8l3.6 3.6"/>'),
  };
  const byAt = (a, b) => (b.at || b.bed || 0) - (a.at || a.bed || 0);
  const asleep = () => S.sleep.filter(x => !x.wake && Date.now() - x.bed < 20 * HOUR).sort(byAt)[0] || null;
  const nights = () => S.sleep.filter(x => x.wake && x.wake > x.bed).sort(byAt);
  const sessions = type => S.workout.filter(w => w.type === type).sort(byAt);
  const habits = () => S.habit.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const logged = (h, k) => S.habitlog.find(x => x.habitId === h.id && x.day === k);
  // Monday that starts the week holding day k
  const weekStart = k => { const d = fromKey(k), w = (d.getDay() + 6) % 7; d.setDate(d.getDate() - w); return keyOf(d); };

  /* ---------- the cards ---------- */
  function logBar() {
    const a = asleep();
    const can = ctx.canSave();
    return `<div class="hl-log" role="group" aria-label="Log">
      ${a ? `<button type="button" class="hl-btn solid" data-act="hl-wake"${can ? '' : ' disabled'}>${ICON.sun}<span>I'm up<small>asleep since ${esc(tFmt.format(a.bed))}</small></span></button>`
        : `<button type="button" class="hl-btn solid" data-act="hl-bed"${can ? '' : ' disabled'}>${ICON.moon}<span>Going to bed</span></button>`}
      <button type="button" class="hl-btn" data-act="hl-form" data-form="gym"${can ? '' : ' disabled'}>${ICON.gym}<span>Gym</span></button>
      <button type="button" class="hl-btn" data-act="hl-form" data-form="run"${can ? '' : ' disabled'}>${ICON.run}<span>Run</span></button>
    </div>`;
  }
  function sleepCard() {
    const list = nights(), last = list[0], a = asleep();
    const end = nightOf(Date.now()), keys = Array.from({ length: 14 }, (_, i) => addDays(end, i - 13));
    const byNight = new Map();
    for (const n of list) { const k = nightOf(n.bed); if (!byNight.has(k)) byNight.set(k, n); }
    const top = 12;
    const bars = keys.map(k => {
      const n = byNight.get(k), now = a && nightOf(a.bed) === k;
      const h = n ? (n.wake - n.bed) / HOUR : now ? (Date.now() - a.bed) / HOUR : 0;
      const label = `${dFmt.format(fromKey(k))} night: ${n ? hm(n.wake - n.bed) + `, ${tFmt.format(n.bed)} to ${tFmt.format(n.wake)}` : now ? 'asleep now' : 'not logged'}`;
      const cls = n ? (h < GOAL - 1 ? 'short' : '') : now ? 'now' : 'none';
      return `<button type="button" class="hs-bar ${cls}" data-act="hl-night" data-night="${k}" style="--h:${n || now ? Math.max(4, Math.min(100, h / top * 100)).toFixed(1) : 100}" title="${esc(label)}" aria-label="${esc(label)}"><i></i><span>${esc(wdFmt.format(fromKey(k)))}</span></button>`;
    }).join('');
    const avg = (() => { const recent = keys.map(k => byNight.get(k)).filter(Boolean); return recent.length ? recent.reduce((t, n) => t + (n.wake - n.bed), 0) / recent.length : null; })();
    const head = last ? `<span class="fig xl">${bigHM(last.wake - last.bed)}</span><span class="meta">Last night · ${esc(tFmt.format(last.bed))} to ${esc(tFmt.format(last.wake))}${avg != null ? ` · ${esc(hm(avg))} on average` : ''}</span>`
      : `<span class="fig xl hl-none">—</span><span class="meta">${a ? `Asleep since ${esc(tFmt.format(a.bed))}. Tap I'm up when you wake.` : 'Tap Going to bed tonight and I\'m up in the morning, and each night fills in.'}</span>`;
    return `<section class="float hl-card hl-sleep">
      <div class="hl-head"><span class="lab">Sleep · last 14 nights</span>${ctx.canSave() ? `<button type="button" class="link" data-act="hl-night" data-night="${esc(nightOf(Date.now() - DAY))}">Add a night</button>` : ''}</div>
      <div class="hl-big">${head}</div>
      <div class="hs-chart" role="group" aria-label="Hours slept each night"><i class="hs-goal" style="bottom:calc(${(GOAL / top * 100).toFixed(1)}% * (1 - 22 / 160) + 22px)"><span>${GOAL} h</span></i>${bars}</div>
    </section>`;
  }
  function gymCard() {
    const list = sessions('gym'), tk = todayKey(), first = addDays(weekStart(tk), -77), days = new Set(list.map(w => keyOf(new Date(w.at))));
    const cells = [];
    for (let i = 0; i < 84; i++) {
      const k = addDays(first, i), future = k > tk, on = days.has(k);
      cells.push(`<span class="hg-cell${on ? ' on' : ''}${k === tk ? ' today' : ''}${future ? ' later' : ''}" title="${esc(dFmt.format(fromKey(k)))}${on ? ': gym' : ''}"></span>`);
    }
    const thisWeek = list.filter(w => keyOf(new Date(w.at)) >= weekStart(tk)).length;
    // the run of weeks in a row with at least one session, counting this week only once it has one
    let streak = 0;
    for (let w = thisWeek ? 0 : 1; w < 52; w++) { const a = addDays(weekStart(tk), -7 * w), b = addDays(a, 7); if (list.some(x => { const k = keyOf(new Date(x.at)); return k >= a && k < b; })) streak++; else break; }
    const last = list[0];
    return `<section class="float hl-card">
      <div class="hl-head"><span class="lab">Gym · 12 weeks</span></div>
      <div class="hl-big">${list.length ? `<span class="fig xl">${thisWeek}<small> this week</small></span><span class="meta">${streak > 1 ? `${streak} weeks in a row · ` : ''}Last: ${esc(dFmt.format(last.at))}${last.mins ? ` · ${last.mins} min` : ''}</span>`
        : '<span class="fig xl hl-none">—</span><span class="meta">Each session you log lights up its day. Today is outlined.</span>'}</div>
      <div class="hg"><div class="hg-days" aria-hidden="true"><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span><span>S</span></div><div class="hg-grid" role="img" aria-label="${list.length} gym sessions logged in the last 12 weeks">${cells.join('')}</div></div>
      ${list.length ? `<div class="hl-recent">${list.slice(0, 3).map(w => `<button type="button" class="hl-row" data-act="hl-form" data-form="gym" data-id="${esc(w.id)}"><span>${esc(dFmt.format(w.at))}</span><span class="meta">${w.mins ? `${w.mins} min` : ''}${w.note ? ` · ${esc(w.note)}` : ''}</span></button>`).join('')}</div>` : ''}
    </section>`;
  }
  function runCard() {
    const list = sessions('run'), tk = todayKey(), ws = weekStart(tk);
    const weeks = Array.from({ length: 8 }, (_, i) => addDays(ws, -7 * (7 - i)));
    const miles = weeks.map(a => list.filter(r => { const k = keyOf(new Date(r.at)); return k >= a && k < addDays(a, 7); }).reduce((t, r) => t + (r.miles || 0), 0));
    const most = Math.max(...miles, 1), any = list.length > 0;
    const bars = weeks.map((a, i) => `<span class="hr-bar${!any ? ' none' : miles[i] ? '' : ' zero'}${i === 7 ? ' cur' : ''}" style="--h:${any ? Math.max(3, miles[i] / most * 100).toFixed(1) : 100}" title="${esc(`Week of ${mdFmt.format(fromKey(a))}: ${any ? miles[i].toFixed(1) + ' mi' : 'nothing logged'}`)}"><i></i><span>${i === 7 ? 'This week' : i % 2 ? '' : esc(mdFmt.format(fromKey(a)))}</span></span>`).join('');
    const goal = ctx.goals ? ctx.goals(/run|shoe/i)[0] : null;
    const last = list[0];
    return `<section class="float hl-card">
      <div class="hl-head"><span class="lab">Running · miles a week</span></div>
      <div class="hl-big">${any ? `<span class="fig xl">${miles[7].toFixed(1).replace(/\.0$/, '')}<small> mi this week</small></span><span class="meta">Last: ${esc(dFmt.format(last.at))}${last.miles ? ` · ${last.miles} mi` : ''}${last.mins ? ` in ${last.mins} min` : ''}${last.miles && last.mins ? ` · ${Math.floor(last.mins / last.miles)}:${pad(Math.round(last.mins / last.miles % 1 * 60))} a mile` : ''}</span>`
        : '<span class="fig xl hl-none">—</span><span class="meta">Log a run and its week fills in.</span>'}</div>
      <div class="hr-chart" role="img" aria-label="Miles run each of the last 8 weeks">${bars}</div>
      ${goal ? `<button type="button" class="hl-goal" data-tab="finance"><span class="hl-gt"><span>${esc(goal.name)}</span><span class="num">${esc(usd(goal.saved))} of ${esc(usd(goal.target))} saved</span></span><span class="meter"><span style="width:${goal.target ? Math.min(100, goal.saved / goal.target * 100).toFixed(1) : 0}%"></span></span></button>` : ''}
    </section>`;
  }
  const usd = c => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: (c || 0) % 100 ? 2 : 0 }).format((c || 0) / 100);
  function habitsCard() {
    const tk = todayKey(), days = Array.from({ length: 7 }, (_, i) => addDays(tk, i - 6)), list = habits(), can = ctx.canSave();
    const streak = h => { let n = 0; for (let k = logged(h, tk) ? tk : addDays(tk, -1); logged(h, k); k = addDays(k, -1)) n++; return n; };
    const rows = list.map(h => `<div class="hb-row">
      <button type="button" class="hb-name" data-act="hl-habit-edit" data-id="${esc(h.id)}"><span>${esc(h.name)}</span><small>${streak(h) > 1 ? `${streak(h)} days in a row` : ''}</small></button>
      <div class="hb-days">${days.map(k => { const on = !!logged(h, k); return `<button type="button" class="hb-dot${on ? ' on' : ''}${k === tk ? ' today' : ''}" data-act="hl-habit" data-id="${esc(h.id)}" data-day="${k}" aria-pressed="${on}" aria-label="${esc(h.name)}, ${esc(dFmt.format(fromKey(k)))}"${can ? '' : ' disabled'}>${on ? ICON.check : `<span>${esc(wdFmt.format(fromKey(k)))}</span>`}</button>`; }).join('')}</div>
    </div>`).join('');
    // things you checked off today that could become habits
    const have = new Set(list.map(h => h.name.toLowerCase()));
    const ideas = (ctx.doneToday ? ctx.doneToday() : []).filter(n => !have.has(n.toLowerCase())).slice(0, 5);
    return `<section class="float hl-card hl-habits">
      <div class="hl-head"><span class="lab">Habits · this week</span>${can ? `<button type="button" class="circle" data-act="hl-habit-edit" aria-label="New habit">${ICON.plus}</button>` : ''}</div>
      ${rows || '<p class="empty">No habits yet. Add one, and tap its dot each day you do it.</p>'}
      ${ideas.length && can ? `<div class="hb-ideas"><span class="meta">You checked these off today. Make one a habit:</span><div class="chips">${ideas.map(n => `<button type="button" class="chip" data-act="hl-habit-add" data-name="${esc(n)}">${ICON.plus}${esc(n)}</button>`).join('')}</div></div>` : ''}
    </section>`;
  }
  function view() {
    let body;
    if (S.failed) body = '<p class="empty">Health did not load. Check the connection; POS tries again when you come back to it.</p>';
    else if (!S.loaded) body = '<p class="empty">Loading…</p>';
    else body = `${logBar()}<div class="hl-grid">${sleepCard()}${gymCard()}${runCard()}${habitsCard()}</div>`;
    return `<div class="health"><div class="health-scroll" id="healthScroll" data-keep>${body}</div></div>`;
  }

  /* ---------- logging ---------- */
  const f = (label, inner) => `<label class="f"><span class="lab">${label}</span>${inner}</label>`;
  const val = id => (document.getElementById(id) || {}).value?.trim() || '';
  const dtLocal = ms => { const d = new Date(ms); return `${keyOf(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const parseLocal = v => { if (!v) return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
  async function bed() {
    const id = R.newId('sleep'), at = Date.now();
    if (await R.save(R.db.set('sleep', id, { bed: at, wake: null, createdAt: at }))) toast(`Good night. Asleep from ${tFmt.format(at)}`, () => R.save(R.db.remove('sleep', id)));
  }
  async function wake() {
    const a = asleep();
    if (!a) return;
    const at = Date.now();
    if (at - a.bed < 10 * 60000) { if (await R.save(R.db.remove('sleep', a.id))) toast('That was less than 10 minutes, so it’s not counted as a night'); return; }
    if (await R.save(R.db.update('sleep', a.id, { wake: at }))) toast(`Morning. You slept ${hm(at - a.bed)}`, () => R.save(R.db.update('sleep', a.id, { wake: null })));
  }
  function openNight(nk) {
    const n = S.sleep.find(x => nightOf(x.bed) === nk) || null;
    const bed0 = n ? n.bed : fromKey(nk).getTime() + 23.5 * HOUR, wake0 = n && n.wake ? n.wake : fromKey(nk).getTime() + 31 * HOUR;
    window.POSSheet.open({
      title: `${dFmt.format(fromKey(nk))} night`,
      body: `<div class="two">${f('Went to bed', `<input id="hn_bed" type="datetime-local" value="${dtLocal(bed0)}">`)}${f('Woke up', `<input id="hn_wake" type="datetime-local" value="${n && !n.wake ? '' : dtLocal(wake0)}">`)}</div>`,
      remove: n ? async () => R.save(R.db.remove('sleep', n.id)) : null,
      submit: async () => {
        const b = parseLocal(val('hn_bed')), w = parseLocal(val('hn_wake'));
        if (!b) return 'Pick when you went to bed.';
        if (w && w <= b) return 'Waking up has to come after going to bed.';
        if (w && w - b > 20 * HOUR) return 'That’s more than 20 hours. Check the times.';
        const d = { bed: b, wake: w || null };
        return R.save(n ? R.db.update('sleep', n.id, d) : R.db.set('sleep', R.newId('sleep'), { ...d, createdAt: Date.now() }));
      },
    });
  }
  function openWorkout(type, id) {
    const w = id ? S.workout.find(x => x.id === id) : null, t = w ? w.type : type, run = t === 'run';
    window.POSSheet.open({
      title: w ? (run ? 'Run' : 'Gym session') : run ? 'Log a run' : 'Log a gym session',
      body: f('When', `<input id="hw_at" type="datetime-local" value="${dtLocal(w ? w.at : Date.now())}">`)
        + (run ? `<div class="two">${f('Miles', `<input id="hw_miles" inputmode="decimal" placeholder="3.1" value="${w && w.miles ? w.miles : ''}">`)}${f('Minutes', `<input id="hw_mins" inputmode="numeric" placeholder="30" value="${w && w.mins ? w.mins : ''}">`)}</div>`
          : f('Minutes', `<input id="hw_mins" inputmode="numeric" placeholder="60" value="${w && w.mins ? w.mins : ''}">`))
        + f('Note', `<input id="hw_note" maxlength="120" autocomplete="off" placeholder="${run ? 'Route, how it felt' : 'Push day, legs, what you lifted'}" value="${esc(w ? w.note || '' : '')}">`),
      remove: w ? async () => R.save(R.db.remove('workout', w.id)) : null,
      submit: async () => {
        const at = parseLocal(val('hw_at')), mins = val('hw_mins') ? Number(val('hw_mins')) : null, miles = run && val('hw_miles') ? Number(val('hw_miles')) : null;
        if (!at) return 'Pick when it was.';
        if (at > Date.now() + 60 * 60000) return 'That’s in the future.';
        if (mins != null && !(Number.isInteger(mins) && mins > 0 && mins < 1000)) return 'Minutes should be a whole number, like 45.';
        if (run && miles != null && !(miles > 0 && miles < 200)) return 'Miles should look like 3.1.';
        if (run && !miles && !mins) return 'Add the miles, the minutes, or both.';
        const d = { type: t, at, mins, miles, note: val('hw_note') };
        const ok = await R.save(w ? R.db.update('workout', w.id, d) : R.db.set('workout', R.newId('wo'), { ...d, createdAt: Date.now() }));
        if (ok && !w) toast(run ? `Run logged${miles ? ` · ${miles} mi` : ''}` : 'Gym session logged');
        return ok;
      },
    });
  }
  function openHabit(id) {
    const h = id ? S.habit.find(x => x.id === id) : null;
    window.POSSheet.open({
      title: h ? h.name : 'New habit',
      body: f('Habit', `<input id="hh_name" maxlength="60" autocomplete="off" placeholder="Read 10 pages" value="${esc(h ? h.name : '')}">`)
        + '<p class="where">Tap its dot each day you do it. A streak counts the days in a row.</p>',
      delLabel: 'Delete habit',
      remove: h ? async () => { const ok = await R.save(R.db.remove('habit', h.id)); if (ok) for (const l of S.habitlog.filter(x => x.habitId === h.id)) R.save(R.db.remove('habitlog', l.id)); return ok; } : null,
      submit: async () => {
        const name = val('hh_name');
        if (!name) return 'Name the habit.';
        return R.save(h ? R.db.update('habit', h.id, { name }) : R.db.set('habit', R.newId('habit'), { name, createdAt: Date.now() }));
      },
    });
  }
  async function toggleHabit(id, day) {
    const h = S.habit.find(x => x.id === id);
    if (!h || day > todayKey()) return;
    const l = logged(h, day);
    await R.save(l ? R.db.remove('habitlog', l.id) : R.db.set('habitlog', R.newId('hl'), { habitId: id, day, createdAt: Date.now() }));
  }

  /* ---------- taps routed here by POS (data-act="hl-…") ---------- */
  function act(name, b) {
    if (!ctx.canSave()) return;
    if (name === 'hl-bed') bed();
    else if (name === 'hl-wake') wake();
    else if (name === 'hl-night') openNight(b.dataset.night);
    else if (name === 'hl-form') openWorkout(b.dataset.form, b.dataset.id);
    else if (name === 'hl-habit') toggleHabit(b.dataset.id, b.dataset.day);
    else if (name === 'hl-habit-edit') openHabit(b.dataset.id);
    else if (name === 'hl-habit-add') R.save(R.db.set('habit', R.newId('habit'), { name: b.dataset.name, createdAt: Date.now() })).then(ok => ok && toast(`${b.dataset.name} is a habit now`));
  }
  const add = () => openWorkout('gym');
  return { view, act, add, start: R.start, stop: R.stop };
};
