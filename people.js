// POS Birthdays: people and the day they were born. Each year the calendar shows "Luken's 23rd birthday" on the day.
// A person: { first, last, month (1-12), day, year (optional), me (your own) }. Stored in records, kind "person".
window.POSPeople = function (ctx) {
  const { esc, toast } = ctx;
  const R = window.POSRecords(ctx, ['person'], 'pos-people');
  const S = R.S;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const pad = n => String(n).padStart(2, '0');
  const ordinal = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  const leap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const CAKE = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 20.5h15M5.5 20.5v-6.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6.5M5.5 15.5c1.2 1 2.4 1 3.6 0s2.4-1 3.6 0 2.4 1 3.6 0 1.6-.8 2.2-.6M12 12V9M12 6.8c-.9-.8-.9-1.9 0-3 .9 1.1.9 2.2 0 3z"/></svg>';

  const name = p => [p.first, p.last].filter(Boolean).join(' ');
  const people = () => S.person.slice().sort((a, b) => (a.first || '').localeCompare(b.first || '', undefined, { sensitivity: 'base' }) || (a.last || '').localeCompare(b.last || '', undefined, { sensitivity: 'base' }));
  // the birthday in a given year (a February 29 birthday falls on the 28th in other years)
  const dayIn = (p, y) => `${y}-${pad(p.month)}-${pad(p.month === 2 && p.day === 29 && !leap(y) ? 28 : p.day)}`;
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  function nextFrom(p, k) {
    const y = +k.slice(0, 4);
    const here = dayIn(p, y);
    return here >= k ? { key: here, year: y } : { key: dayIn(p, y + 1), year: y + 1 };
  }
  const turning = (p, y) => (p.year ? y - p.year : null);
  const label = (p, y) => { const n = turning(p, y); return `${p.first || name(p)}'s ${n > 0 ? ordinal(n) + ' ' : ''}birthday`; };
  function ageNow(p) {
    if (!p.year) return null;
    const t = todayKey(), y = +t.slice(0, 4);
    return y - p.year - (dayIn(p, y) > t ? 1 : 0);
  }
  const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const daysUntil = k => Math.round((fromKey(k) - fromKey(todayKey())) / 864e5);
  const when = n => (n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`);

  // birthdays on a calendar day
  function on(k) {
    if (!S.loaded) return [];
    const y = +k.slice(0, 4);
    return people().filter(p => p.month && p.day && dayIn(p, y) === k).map(p => ({ id: p.id, me: !!p.me, label: label(p, y) }));
  }
  const chip = (x, cls) => `<button type="button" class="${cls} bday" data-act="bday-open" data-id="${esc(x.id)}">${CAKE}${esc(x.label)}</button>`;

  /* ---------- the list and one person ---------- */
  function row(p) {
    const nx = nextFrom(p, todayKey()), n = daysUntil(nx.key), age = ageNow(p), t = turning(p, nx.year);
    const sub = [`${MONTHS[p.month - 1].slice(0, 3)} ${p.day}${p.year ? ', ' + p.year : ''}`, age != null ? `${age} now` : null,
      n <= 30 ? `${t ? 'turns ' + t + ' ' : ''}${when(n)}` : null].filter(Boolean).join(' · ');
    return `<button type="button" class="bd-row${n === 0 ? ' today' : ''}" data-act="bday-open" data-id="${esc(p.id)}"><span class="bd-ic">${CAKE}</span><span class="bd-t"><span class="name">${esc(name(p))}${p.me ? ' <span class="pill">You</span>' : ''}</span><span class="meta">${esc(sub)}</span></span></button>`;
  }
  function listSpec() {
    const all = people(), me = all.filter(p => p.me), rest = all.filter(p => !p.me);
    const soon = all.map(p => ({ p, nx: nextFrom(p, todayKey()) })).sort((a, b) => a.nx.key.localeCompare(b.nx.key))[0];
    return {
      title: 'Birthdays', saveLabel: 'Add someone', submit: () => { openPerson(null); return false; },
      body: `${soon ? `<p class="where">Next up: <b>${esc(label(soon.p, soon.nx.year))}</b>, ${esc(dayFmt.format(fromKey(soon.nx.key)))} (${esc(when(daysUntil(soon.nx.key)))})</p>` : ''}
        <div class="bd-list">${me.map(row).join('')}${rest.length ? rest.map(row).join('') : '<p class="empty">No one else yet. Add people and their birthdays show on the calendar every year.</p>'}</div>`,
    };
  }
  const openList = () => window.POSSheet.open(listSpec());
  function openPerson(id) {
    const p = id ? S.person.find(x => x.id === id) : null;
    const opt = (v, l, sel) => `<option value="${v}"${sel ? ' selected' : ''}>${l}</option>`;
    let info = '';
    if (p && p.month) {
      const nx = nextFrom(p, todayKey()), n = daysUntil(nx.key), age = ageNow(p);
      info = `<p class="where">${p.year ? `Born ${esc(MONTHS[p.month - 1])} ${p.day}, ${p.year}${age != null ? ` · <b>${age}</b> years old` : ''}<br>` : ''}${n === 0 ? `<b>Today is ${esc(label(p, nx.year))}</b>` : `${esc(label(p, nx.year))}: <b>${esc(dayFmt.format(fromKey(nx.key)))}</b>, ${esc(when(n))}`}</p>`;
    }
    window.POSSheet.open({
      title: p ? name(p) : 'Add a birthday',
      body: info
        + `<div class="two"><label class="f"><span class="lab">First name</span><input id="pp_first" autocomplete="off" maxlength="40" value="${p ? esc(p.first || '') : ''}"></label>`
        + `<label class="f"><span class="lab">Last name</span><input id="pp_last" autocomplete="off" maxlength="40" value="${p ? esc(p.last || '') : ''}"></label></div>`
        + `<div class="three"><label class="f"><span class="lab">Month</span><select id="pp_month">${opt('', '—', !p)}${MONTHS.map((m, i) => opt(i + 1, m, p && p.month === i + 1)).join('')}</select></label>`
        + `<label class="f"><span class="lab">Day</span><select id="pp_day">${opt('', '—', !p)}${Array.from({ length: 31 }, (_, i) => opt(i + 1, i + 1, p && p.day === i + 1)).join('')}</select></label>`
        + `<label class="f"><span class="lab">Year born</span><input id="pp_year" inputmode="numeric" maxlength="4" placeholder="Optional" value="${p && p.year ? p.year : ''}"></label></div>`
        + `<label class="f-check"><input type="checkbox" id="pp_me"${p && p.me ? ' checked' : ''}><span>This is me</span></label>`,
      remove: p ? async () => { const ok = await R.save(R.db.remove('person', p.id)); if (ok) { toast(`${name(p)} removed`); openList(); } return false; } : null,
      submit: async () => {
        const v = id => document.getElementById(id).value.trim();
        const first = v('pp_first'), last = v('pp_last'), month = +v('pp_month'), day = +v('pp_day'), yearText = v('pp_year');
        if (!first) return 'Add a first name.';
        if (!month || !day) return 'Pick the month and day.';
        const year = yearText ? +yearText : null;
        if (yearText && !(year > 1900 && year <= new Date().getFullYear())) return 'The year should look like 2003, or leave it blank.';
        const maxDay = new Date(year || 2024, month, 0).getDate();
        if (day > maxDay) return `${MONTHS[month - 1]} only has ${maxDay} days.`;
        const me = document.getElementById('pp_me').checked;
        const d = { first, last, month, day, year, me };
        if (me) for (const o of S.person.filter(x => x.me && (!p || x.id !== p.id))) await R.save(R.db.update('person', o.id, { me: false }));
        const ok = await R.save(p ? R.db.update('person', p.id, d) : R.db.set('person', R.newId('person'), { ...d, createdAt: Date.now() }));
        if (!ok) return false;
        toast(p ? 'Saved' : `${first}'s birthday added`);
        openList();
        return false;
      },
    });
  }
  function act(name, b) {
    if (name === 'bday-list') openList();
    else if (name === 'bday-open') openPerson(b.dataset.id);
  }
  return { start: R.start, stop: R.stop, on, chip, act, openList };
};
