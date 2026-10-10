// POS Pets: one card per pet (Iso first): age from his birthday, vet visits and when the next checkup is due,
// food, notes, and what's being saved or bought for him (from Finance and Tasks).
// Records: kind "pet" { name, species, sex, breed, birthday 'YYYY-MM-DD', weight, chip, vet, food, feeding, lastVetApprox },
//          kind "petvet" { petId, at, reason, cost, note }, kind "petnote" { petId, at, text }.
window.POSPets = function (ctx) {
  const { esc, toast } = ctx;
  const R = window.POSRecords(ctx, ['pet', 'petvet', 'petnote'], 'pos-pets');
  const S = R.S;
  const DAY = 864e5;
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmt = c => usd.format((c || 0) / 100);
  const dFull = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const dLong = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const PAW = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="16" rx="4.6" ry="3.8"/><circle cx="6" cy="10.5" r="1.9"/><circle cx="9.5" cy="6.5" r="1.9"/><circle cx="14.5" cy="6.5" r="1.9"/><circle cx="18" cy="10.5" r="1.9"/></svg>';
  const ICON = {
    edit: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h3.6L19 8.6 15.4 5 4.5 15.9zM13.6 6.8l3.6 3.6"/></svg>',
    plus: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>',
    warn: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.2 20.8 19.3H3.2z"/><path d="M12 10v4.2M12 16.8v.2"/></svg>',
  };
  const pets = () => S.pet.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const he = p => (p.sex === 'female' ? 'she' : p.sex === 'male' ? 'he' : 'they');
  const his = p => (p.sex === 'female' ? 'her' : p.sex === 'male' ? 'his' : 'their');

  // "3 years, 4 months"
  function age(p) {
    if (!p.birthday) return null;
    const b = fromKey(p.birthday), n = new Date();
    let months = (n.getFullYear() - b.getFullYear()) * 12 + n.getMonth() - b.getMonth();
    if (n.getDate() < b.getDate()) months--;
    if (months < 0) return null;
    const y = Math.floor(months / 12), m = months % 12;
    return [y ? `${y} ${y === 1 ? 'year' : 'years'}` : null, m || !y ? `${m} ${m === 1 ? 'month' : 'months'}` : null].filter(Boolean).join(', ');
  }
  function nextBirthday(p) {
    if (!p.birthday) return null;
    const b = fromKey(p.birthday), n = new Date(), y = n.getFullYear();
    let d = new Date(y, b.getMonth(), b.getDate(), 12);
    if (keyOf(d) < keyOf(n)) d = new Date(y + 1, b.getMonth(), b.getDate(), 12);
    return { d, turning: d.getFullYear() - b.getFullYear(), days: Math.round((d - new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12)) / DAY) };
  }
  const visits = p => S.petvet.filter(v => v.petId === p.id).sort((a, b) => b.at - a.at);
  // a yearly checkup: due a year after the last visit (or now, if there's no record of one)
  function checkup(p) {
    const last = visits(p)[0];
    const at = last ? last.at : p.lastVetApprox ? fromKey(p.lastVetApprox).getTime() : null;
    if (!at) return { st: 'due', text: 'No vet visit on record. Time for a checkup.' };
    const due = at + 365 * DAY, days = Math.round((due - Date.now()) / DAY);
    const ago = Math.round((Date.now() - at) / (30.4 * DAY));
    const when = last ? dFull.format(at) : ago >= 11 && ago <= 13 ? 'about a year ago' : `about ${ago} ${ago === 1 ? 'month' : 'months'} ago`;
    if (days <= 0) return { st: 'due', text: `Last vet visit ${when}. A yearly checkup is due now.` };
    if (days <= 45) return { st: 'soon', text: `Last vet visit ${when}. Checkup due in ${days} days.` };
    return { st: 'ok', text: `Last vet visit ${when}. Next checkup around ${dFull.format(due)}.` };
  }

  function petCard(p) {
    const a = age(p), nb = nextBirthday(p), c = checkup(p);
    const facts = [['Species', [p.species, p.breed].filter(Boolean).join(' · ')], ['Birthday', p.birthday ? dLong.format(fromKey(p.birthday)) : null], ['Weight', p.weight],
      ['Microchip', p.chip], ['Vet', p.vet]].filter(x => x[1]);
    return `<article class="float pet">
      <div class="pet-head">
        <span class="pet-av">${PAW}</span>
        <div class="pet-id"><span class="lab">${esc(p.species || 'Pet')}</span><h2 class="pet-name">${esc(p.name)}</h2>
          <span class="meta">${a ? `${esc(a)} old` : `Add ${esc(his(p))} birthday to see ${esc(his(p))} age`}${nb && nb.days <= 31 ? ` · turns ${nb.turning} ${nb.days === 0 ? 'today' : `in ${nb.days} days`}` : ''}</span></div>
        ${ctx.canSave() ? `<button type="button" class="circle" data-act="pet-form" data-form="pet" data-id="${esc(p.id)}" aria-label="Edit ${esc(p.name)}">${ICON.edit}</button>` : ''}
      </div>
      <div class="pet-check ${c.st}">${c.st !== 'ok' ? ICON.warn : ''}<span>${esc(c.text)}</span>${ctx.canSave() ? `<button type="button" class="btn${c.st === 'ok' ? '' : ' solid'}" data-act="pet-form" data-form="visit" data-pet="${esc(p.id)}">Log a vet visit</button>` : ''}</div>
      ${facts.length ? `<div class="pet-facts">${facts.map(([k, v]) => `<div><span class="meta">${k}</span><span>${esc(v)}</span></div>`).join('')}</div>` : ''}
    </article>`;
  }
  function foodCard(p) {
    return `<section class="sec"><div class="sec-head"><span class="lab">Food</span>${ctx.canSave() ? `<button type="button" class="circle" data-act="pet-form" data-form="pet" data-id="${esc(p.id)}" aria-label="Edit food">${ICON.edit}</button>` : ''}</div>
      <div class="float pet-box">${p.food || p.feeding ? `<p class="name">${esc(p.food || '')}</p>${p.feeding ? `<p class="meta">${esc(p.feeding)}</p>` : ''}` : `<p class="empty">What ${esc(he(p))} eats and how much. Tap the pencil to add it.</p>`}</div></section>`;
  }
  function visitList(p) {
    const list = visits(p);
    return `<section class="sec"><div class="sec-head"><span class="lab">Vet visits</span>${ctx.canSave() ? `<button type="button" class="circle" data-act="pet-form" data-form="visit" data-pet="${esc(p.id)}" aria-label="Log a vet visit">${ICON.plus}</button>` : ''}</div>
      ${list.length ? `<div class="float list">${list.map(v => `<button type="button" class="pv-row" data-act="pet-form" data-form="visit" data-id="${esc(v.id)}"><span class="pv-l"><span class="name">${esc(v.reason || 'Vet visit')}</span><span class="meta">${esc(dFull.format(v.at))}${v.note ? ' · ' + esc(v.note) : ''}</span></span>${v.cost ? `<span class="fig md">${esc(fmt(v.cost))}</span>` : ''}</button>`).join('')}</div>`
        : `<p class="empty">No visits logged yet${p.lastVetApprox ? ` (the last one was about a year ago)` : ''}.</p>`}</section>`;
  }
  function forHim(p) {
    const goals = ctx.goals ? ctx.goals(/litter|\bcats?\b|kitty|\biso\b|\bpets?\b/i) : [];
    const buys = ctx.tasks ? ctx.tasks().filter(t => !t.done && /litter|\bcats?\b|kitty|\biso\b|\bpets?\b/i.test(t.title)) : [];
    if (!goals.length && !buys.length) return '';
    return `<section class="sec"><div class="sec-head"><span class="lab">For ${esc(p.name)}</span><button type="button" class="link" data-tab="finance">Finance</button></div>
      <div class="float list">
        ${goals.map(g => { const pct = g.target ? Math.min(100, Math.round(g.saved / g.target * 100)) : null; return `<div class="pf-row"><div class="pf-l"><span class="name">${esc(g.name)}</span><span class="meta">Saving · ${esc(fmt(g.saved))}${g.target ? ` of ${esc(fmt(g.target))}` : ''}</span>${pct != null ? `<span class="pf-track"><span style="width:${pct}%"></span></span>` : ''}</div>${pct != null ? `<span class="fig md">${pct}%</span>` : ''}</div>`; }).join('')}
        ${buys.map(t => `<button type="button" class="pf-row" data-act="edit" data-id="${esc(t.id)}"><div class="pf-l"><span class="name">${esc(t.title)}</span><span class="meta">To buy${t.list ? ' · ' + esc(t.list) : ''}${t.date ? ' · ' + esc(dFull.format(fromKey(t.date))) : ''}</span></div></button>`).join('')}
      </div></section>`;
  }
  function noteList(p) {
    const list = S.petnote.filter(n => n.petId === p.id).sort((a, b) => b.at - a.at);
    return `<section class="sec"><div class="sec-head"><span class="lab">Notes</span>${ctx.canSave() ? `<button type="button" class="circle" data-act="pet-form" data-form="note" data-pet="${esc(p.id)}" aria-label="Add a note">${ICON.plus}</button>` : ''}</div>
      ${list.length ? `<div class="float list">${list.map(n => `<button type="button" class="pn-row" data-act="pet-form" data-form="note" data-id="${esc(n.id)}"><span class="pn-t">${esc(n.text)}</span><span class="meta">${esc(dFull.format(n.at))}</span></button>`).join('')}</div>`
        : `<p class="empty">Habits, meds, what ${esc(he(p))} likes and doesn't.</p>`}</section>`;
  }
  function view() {
    let body;
    if (S.failed) body = '<p class="empty">Pets did not load. Check the connection; POS tries again when you come back to it.</p>';
    else if (!S.loaded) body = '<p class="empty">Loading…</p>';
    else if (!S.pet.length) body = `<p class="empty">No pets yet.</p>${ctx.canSave() ? '<div><button type="button" class="btn solid" data-act="pet-form" data-form="pet">Add a pet</button></div>' : ''}`;
    else body = pets().map(p => `<div class="pet-grid"><div class="pet-col">${petCard(p)}${foodCard(p)}${forHim(p)}</div><div class="pet-col">${visitList(p)}${noteList(p)}</div></div>`).join('');
    return `<div class="pets"><div class="pets-scroll" id="petsScroll" data-keep>${body}</div></div>`;
  }

  /* ---------- forms ---------- */
  const f = (label, inner, hint) => `<label class="f"><span class="lab">${label}</span>${inner}${hint ? `<span class="f-h">${hint}</span>` : ''}</label>`;
  const v = id => (document.getElementById(id) || {}).value?.trim() || '';
  function money(t) { const s = t.replace(/[$,\s]/g, ''); if (!s) return null; return /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(parseFloat(s) * 100) : NaN; }
  function openPet(id) {
    const p = id ? S.pet.find(x => x.id === id) : null;
    window.POSSheet.open({
      title: p ? p.name : 'Add a pet',
      body: `<div class="two">${f('Name', `<input id="pt_name" maxlength="30" value="${esc(p ? p.name : '')}">`)}${f('Species', `<input id="pt_species" maxlength="30" placeholder="Cat" value="${esc(p ? p.species || '' : 'Cat')}">`)}</div>`
        + `<div class="two">${f('Breed', `<input id="pt_breed" maxlength="40" placeholder="Optional" value="${esc(p ? p.breed || '' : '')}">`)}${f('He or she', `<select id="pt_sex"><option value="">—</option><option value="male"${p && p.sex === 'male' ? ' selected' : ''}>He</option><option value="female"${p && p.sex === 'female' ? ' selected' : ''}>She</option></select>`)}</div>`
        + `<div class="two">${f('Birthday', `<input id="pt_bday" type="date" value="${esc(p && p.birthday || '')}">`)}${f('Weight', `<input id="pt_weight" maxlength="20" placeholder="11 lb" value="${esc(p ? p.weight || '' : '')}">`)}</div>`
        + f('Food', `<input id="pt_food" maxlength="80" placeholder="Brand and kind" value="${esc(p ? p.food || '' : '')}">`)
        + f('How much, how often', `<input id="pt_feeding" maxlength="120" placeholder="½ cup dry twice a day, a wet can at night" value="${esc(p ? p.feeding || '' : '')}">`)
        + `<div class="two">${f('Vet', `<input id="pt_vet" maxlength="60" placeholder="Clinic" value="${esc(p ? p.vet || '' : '')}">`)}${f('Microchip', `<input id="pt_chip" maxlength="30" placeholder="Optional" value="${esc(p ? p.chip || '' : '')}">`)}</div>`,
      remove: p ? async () => R.save(R.db.remove('pet', p.id)) : null,
      submit: async () => {
        const name = v('pt_name');
        if (!name) return 'Give your pet a name.';
        const birthday = v('pt_bday') || null;
        if (birthday && birthday > keyOf(new Date())) return 'The birthday can’t be in the future.';
        const d = { name, species: v('pt_species'), breed: v('pt_breed'), sex: v('pt_sex'), birthday, weight: v('pt_weight'), food: v('pt_food'), feeding: v('pt_feeding'), vet: v('pt_vet'), chip: v('pt_chip') };
        return R.save(p ? R.db.update('pet', p.id, d) : R.db.set('pet', R.newId('pet'), { ...d, createdAt: Date.now() }));
      },
    });
  }
  function openVisit(id, petId) {
    const x = id ? S.petvet.find(z => z.id === id) : null;
    const pid = x ? x.petId : petId, p = S.pet.find(z => z.id === pid);
    window.POSSheet.open({
      title: x ? 'Vet visit' : `${p ? p.name + ': ' : ''}vet visit`,
      body: `<div class="two">${f('Date', `<input id="pv_date" type="date" value="${keyOf(new Date(x ? x.at : Date.now()))}">`)}${f('Cost', `<input id="pv_cost" inputmode="decimal" placeholder="0.00" value="${x && x.cost ? (x.cost / 100).toFixed(2) : ''}">`)}</div>`
        + f('Why', `<input id="pv_reason" maxlength="80" placeholder="Yearly checkup, shots" value="${esc(x ? x.reason || '' : '')}">`)
        + f('Notes', `<textarea id="pv_note" rows="3" maxlength="600" placeholder="Weight, shots given, what the vet said">${esc(x ? x.note || '' : '')}</textarea>`),
      remove: x ? async () => R.save(R.db.remove('petvet', x.id)) : null,
      submit: async () => {
        const at = v('pv_date') ? fromKey(v('pv_date')).getTime() : null, cost = money(v('pv_cost'));
        if (!at) return 'Pick the date.';
        if (Number.isNaN(cost)) return 'Cost should be an amount, like 85.00.';
        const d = { petId: pid, at, cost, reason: v('pv_reason'), note: v('pv_note') };
        const ok = await R.save(x ? R.db.update('petvet', x.id, d) : R.db.set('petvet', R.newId('vet'), { ...d, createdAt: Date.now() }));
        if (ok && !x) toast('Vet visit logged');
        return ok;
      },
    });
  }
  function openNote(id, petId) {
    const n = id ? S.petnote.find(z => z.id === id) : null;
    window.POSSheet.open({
      title: n ? 'Note' : 'Add a note',
      body: f('Note', `<textarea id="pn_text" rows="5" maxlength="2000">${esc(n ? n.text : '')}</textarea>`),
      remove: n ? async () => R.save(R.db.remove('petnote', n.id)) : null,
      submit: async () => {
        const text = v('pn_text');
        if (!text) return 'Write the note first.';
        return R.save(n ? R.db.update('petnote', n.id, { text }) : R.db.set('petnote', R.newId('pnote'), { petId, text, at: Date.now() }));
      },
    });
  }
  function act(name, b) {
    if (name !== 'pet-form' || !ctx.canSave()) return;
    const form = b.dataset.form;
    if (form === 'pet') openPet(b.dataset.id);
    else if (form === 'visit') openVisit(b.dataset.id, b.dataset.pet);
    else if (form === 'note') openNote(b.dataset.id, b.dataset.pet);
  }
  const add = () => { const p = pets()[0]; if (p) openVisit(null, p.id); else openPet(null); };
  // the menu badge: a checkup that's due
  const badge = () => (S.loaded ? pets().filter(p => checkup(p).st === 'due').length : 0);
  return { view, act, add, badge, start: R.start, stop: R.stop };
};
