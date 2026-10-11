// POS Places: where you are (from your phone), where the car is parked, and the places you go (the campuses, home,
// anything you add). Each place answers to its name and nicknames on the calendar, and opens in Apple Maps or Waze.
window.POSPlacesTab = function (ctx) {
  const { esc, toast } = ctx;
  const P = () => ctx.places();
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = {
    pin: svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
    car: svg('<path d="M5.6 11.5 7.3 7.1a1.8 1.8 0 0 1 1.7-1.1h6a1.8 1.8 0 0 1 1.7 1.1l1.7 4.4"/><rect x="4" y="11.5" width="16" height="5.5" rx="2"/><path d="M6.5 17v2M17.5 17v2M7.6 14.3h.8M15.6 14.3h.8"/>'),
    me: svg('<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2"/>'),
    walk: svg('<circle cx="13" cy="4.5" r="1.8"/><path d="m9 21 2.5-6.5L14 17v4M8.5 11.5l2.5-3.5 3 1.5 2 3M11 8l-1.5 5.5"/>'),
    chev: svg('<path d="M9.5 6.5 15 12l-5.5 5.5"/>'),
    plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
    home: svg('<path d="M4.5 11 12 4.5l7.5 6.5v7.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M10 20v-5h4v5"/>'),
    church: svg('<path d="M12 3v4M10 5h4M7 21v-8l5-4 5 4v8M4 21h16M10.5 21v-3.5h3V21"/>'),
  };
  const ago = at => {
    const m = Math.round((Date.now() - (at || 0)) / 60e3);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr ago`;
    return new Date(at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const appleWalk = p => `https://maps.apple.com/?daddr=${p.lat},${p.lon}&dirflg=w`;
  const appleDrive = p => `https://maps.apple.com/?daddr=${p.lat},${p.lon}&dirflg=d`;
  const waze = p => `https://waze.com/ul?ll=${p.lat},${p.lon}&navigate=yes`;
  // where you are for distances: the phone's fix if it's from today, else what the calendar says, else home
  function origin() {
    const pl = P(), m = pl.me();
    if (m && Date.now() - (m.at || 0) < 12 * 3600e3) return { lat: m.lat, lon: m.lon };
    const w = ctx.whereNow && ctx.whereNow();
    return w || pl.home() || null;
  }
  // walking: about 3 mph along streets that wind a little
  const walkMins = mi => Math.max(1, Math.round(mi * 1.25 / 3 * 60));
  const miTxt = mi => (mi < 0.1 ? `${Math.round(mi * 5280 / 10) * 10} ft` : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`);

  /* ---------- markup ---------- */
  function meCard() {
    const pl = P(), m = pl.me();
    if (!m) return `<div class="float plc-card"><span class="plc-ic">${ICON.me}</span><span class="lab">Where you are</span><span class="plc-big">Not shared yet</span><span class="meta">Open POS on your phone and it shares where you are.</span></div>`;
    const k = pl.nearKnown(m);
    return `<div class="float plc-card"><span class="plc-ic">${ICON.me}</span><span class="lab">Where you are</span><span class="plc-big">${k ? esc(k.name) : 'Away'}</span><span class="meta">From your phone, ${esc(ago(m.at))}</span>
      <div class="plc-acts"><a class="btn" href="https://maps.apple.com/?ll=${m.lat},${m.lon}&q=You" target="_blank" rel="noopener">Show on a map</a></div></div>`;
  }
  function carCard() {
    const pl = P(), c = pl.car(), o = origin();
    if (!c) return `<div class="float plc-card"><span class="plc-ic">${ICON.car}</span><span class="lab">Your car</span><span class="plc-big">Not saved</span><span class="meta">When you park, tap Parked here on your phone.</span>
      ${ctx.canSave() ? `<div class="plc-acts"><button type="button" class="btn solid" data-act="pl-park">${ICON.car}Parked here</button></div>` : ''}</div>`;
    const mi = o ? pl.miles(o, c) : null, near = mi != null && mi < 0.05, k = pl.nearKnown(c);
    return `<div class="float plc-card car"><span class="plc-ic">${ICON.car}</span><span class="lab">Your car${k ? ' · at ' + esc(k.name) : ''}</span>
      <span class="plc-big">${mi == null ? 'Saved' : near ? 'Right here' : `${walkMins(mi)} min walk`}</span>
      <span class="meta">${mi != null && !near ? esc(miTxt(mi)) + ' away · ' : ''}Parked ${esc(ago(c.at))}</span>
      <div class="plc-acts"><a class="btn solid" href="${appleWalk(c)}" target="_blank" rel="noopener">${ICON.walk}Walk there</a>
        ${ctx.canSave() ? `<button type="button" class="btn" data-act="pl-park">Parked here</button><button type="button" class="link" data-act="pl-unpark">Clear</button>` : ''}</div></div>`;
  }
  function row(p, o) {
    const pl = P(), d = o ? pl.legMins(o, p) : null;
    return `<button type="button" class="plc-row" data-act="pl-open" data-id="${esc(p.id)}"><span class="plc-ric">${p.id === 'place-home' ? ICON.home : p.group ? ICON.church : ICON.pin}</span>
      <span class="plc-tx"><span class="name">${esc(p.short || p.name)}</span><span class="meta">${esc(p.addr || '')}</span></span>
      <span class="plc-d">${d == null ? '' : d === 0 ? 'Here' : `${d} min`}</span>${ICON.chev}</button>`;
  }
  function view() {
    const pl = P();
    if (!pl) return '<div class="plc"><p class="empty">Loading…</p></div>';
    const o = origin(), list = pl.knownList();
    const group = list.filter(p => p.group).map(p => ({ ...p, short: p.name.replace(/^Upstate Church\s+/, '') })).sort((a, b) => a.short.localeCompare(b.short));
    const mine = list.filter(p => !p.group).sort((a, b) => a.name.localeCompare(b.name));
    const h = pl.home();
    const homeRow = h ? [{ ...h, id: 'place-home', name: 'Home', addr: 'Set in Settings' }] : [];
    return `<div class="plc"><div class="plc-scroll" id="plcScroll" data-keep>
      <div class="plc-top">${carCard()}${meCard()}</div>
      ${group.length ? `<section class="sec"><div class="sec-head"><span class="lab">Upstate Church</span><span class="meta">Drive from ${o ? 'where you are' : 'home'}</span></div><div class="float list plc-list">${group.map(p => row(p, o)).join('')}</div></section>` : ''}
      <section class="sec"><div class="sec-head"><span class="lab">Your places</span></div><div class="float list plc-list">${homeRow.concat(mine).map(p => row(p, o)).join('')}
        ${ctx.canSave() ? `<button type="button" class="add-row" data-act="pl-add"><span>Add a place</span>${ICON.plus}</button>` : ''}</div></section>
    </div></div>`;
  }

  /* ---------- sheets ---------- */
  const f = (label, inner, hint) => `<label class="f"><span class="lab">${label}</span>${inner}${hint ? `<span class="meta">${hint}</span>` : ''}</label>`;
  const val = id => ((document.getElementById(id) || {}).value || '').trim();
  function openPlace(id) {
    const pl = P();
    if (id === 'place-home') { const h = pl.home(); if (h) window.open(appleDrive(h), '_blank', 'noopener'); return; }
    const p = id ? pl.knownList().find(x => x.id === id) : null;
    if (id && !p) return;
    const links = p ? `<div class="plc-links"><a class="btn" href="${appleDrive(p)}" target="_blank" rel="noopener">Apple Maps</a><a class="btn" href="${waze(p)}" target="_blank" rel="noopener">Waze</a></div>` : '';
    window.POSSheet.open({
      title: p ? p.name : 'Add a place',
      body: links
        + f('Name', `<input id="pl_name" maxlength="60" autocomplete="off" placeholder="Small group" value="${esc(p ? p.name : '')}">`)
        + f('Address', `<input id="pl_addr" maxlength="160" autocomplete="off" placeholder="123 Main St, Simpsonville" value="${esc(p ? p.addr || '' : '')}">`, p ? 'Change it and POS finds the new spot.' : 'A street address, or the name of a business.')
        + f('Also goes by', `<input id="pl_alias" maxlength="200" autocomplete="off" placeholder="Optional, like Josh's house" value="${esc(p && p.aliases ? p.aliases.join(', ') : '')}">`, 'Type any of these as a place on the calendar and it lands here.'),
      delLabel: 'Delete place',
      remove: p && ctx.canSave() ? async () => { try { await pl.removeKnown(p.id); toast(`${p.name} deleted`); ctx.rerender(); return true; } catch (e) { toast('That did not delete. Check your connection.'); return false; } } : null,
      submit: ctx.canSave() ? async () => {
        const name = val('pl_name'), addr = val('pl_addr');
        const aliases = val('pl_alias').split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
        if (!name) return 'Give the place a name.';
        if (!addr && !p) return 'Add the address so POS can find it.';
        let spot = p ? { lat: p.lat, lon: p.lon, addr: p.addr } : null;
        if (!p || addr !== (p.addr || '')) {
          const g = await pl.geocode(addr || name);
          if (!g) return 'Couldn’t find that address. Try the street and city.';
          spot = { lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6), addr: addr || g.addr };
        }
        try {
          await pl.saveKnown(p ? p.id : null, { ...(p || {}), id: undefined, name, aliases, ...spot });
          toast(p ? 'Saved' : `${name} added`);
          ctx.rerender();
          return true;
        } catch (e) { return 'That did not save. Check your connection and try again.'; }
      } : null,
      saveLabel: p ? 'Save' : 'Add place',
    });
  }

  /* ---------- taps ---------- */
  async function act(name, b) {
    const pl = P();
    if (!pl) return;
    if (name === 'pl-open') openPlace(b.dataset.id);
    else if (name === 'pl-add') { if (ctx.canSave()) openPlace(null); }
    else if (name === 'pl-park') {
      if (!ctx.canSave()) return;
      b.disabled = true;
      try { await pl.parkHere(); toast('Car saved right here'); }
      catch (e) { toast(e && e.code === 1 ? 'POS needs your location for that. Allow it in Settings.' : 'Couldn’t get your location. Try again.'); }
      b.disabled = false;
      ctx.rerender();
    } else if (name === 'pl-unpark') {
      if (!ctx.canSave()) return;
      try { await pl.clearCar(); toast('Car spot cleared'); } catch (e) { toast('That did not clear. Check your connection.'); }
      ctx.rerender();
    }
  }
  const add = () => openPlace(null);
  return { view, act, add };
};
