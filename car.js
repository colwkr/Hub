// POS Car: the CR-V's record. Services (oil changes from Express Oil receipts and anything else), mileage readings and notes.
// The odometer is estimated from how fast the miles have been going up, so "next oil change" works without the windshield sticker.
// Records live in Supabase table records (kinds: vehicle, service, odometer, carnote), owner-only. Times are epoch ms, money whole cents.
window.POSCar = function (ctx) {
  const { sb, toast, rerender, esc } = ctx;
  const $ = (s, r = document) => r.querySelector(s);
  const DAY = 86400000;
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmt = c => usd.format((c || 0) / 100);
  const num = new Intl.NumberFormat('en-US');
  const mi = n => num.format(Math.round(n));
  const dFull = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const dShort = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const dWeek = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const canSave = () => ctx.canSave();
  const ICON = {
    edit: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h3.6L19 8.6 15.4 5 4.5 15.9zM13.6 6.8l3.6 3.6"/></svg>',
    plus: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>',
    warn: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.2 20.8 19.3H3.2z"/><path d="M12 10v4.2M12 16.8v.2"/></svg>',
    check: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 12.5l3.6 3.6 7.4-8"/></svg>',
    chev: '<svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6.5 15 12l-5.5 5.5"/></svg>',
  };

  const KINDS = ['vehicle', 'service', 'odometer', 'carnote'];
  const S = { loaded: false, failed: false, vehicle: [], service: [], odometer: [], carnote: [], open: new Set() };
  let F = null;

  /* ---------- storage ---------- */
  const must = ({ error }) => { if (error) throw error; };
  const strip = d => { const { id, ...rest } = d || {}; return rest; };
  const newId = p => p + '-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
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
    try { await p; return true; } catch (e) { toast('That did not save. Check your connection and try again.'); return false; }
  }
  let loadT = null, channel = null;
  const scheduleLoad = () => { clearTimeout(loadT); loadT = setTimeout(load, 300); };
  async function load() {
    const { data, error } = await sb.from('records').select('id,kind,data').in('kind', KINDS).limit(5000);
    if (error) { S.failed = true; rerender(); return; }
    S.failed = false; S.loaded = true;
    for (const k of KINDS) S[k] = [];
    for (const r of data) S[r.kind].push({ ...r.data, id: r.id });
    rerender();
  }
  function start() {
    load();
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('pos-car').on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, scheduleLoad).subscribe();
  }
  function stop() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    S.loaded = false; S.failed = false; for (const k of KINDS) S[k] = [];
  }

  /* ---------- the numbers ---------- */
  const car = () => S.vehicle.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0] || null;
  const services = () => S.service.slice().sort((a, b) => b.at - a.at || (b.miles || 0) - (a.miles || 0));
  const isOil = s => s.type === 'oil';
  const lastOil = () => services().find(isOil) || null;
  // every time the odometer was seen: at a service, or read off the dash
  function readings() {
    return S.service.filter(s => s.miles > 0).map(s => ({ id: s.id, at: s.at, miles: s.miles }))
      .concat(S.odometer.filter(o => o.miles > 0).map(o => ({ id: o.id, at: o.at, miles: o.miles })))
      .sort((a, b) => a.at - b.at || a.miles - b.miles);
  }
  // miles a day over the last year of readings
  function rate() {
    const p = readings();
    if (p.length < 2) return null;
    const last = p[p.length - 1];
    const first = p.find(x => x.at >= last.at - 365 * DAY && last.at - x.at >= 14 * DAY) || p[0];
    const days = (last.at - first.at) / DAY;
    if (days < 7) return null;
    const r = (last.miles - first.miles) / days;
    return r > 0 && r < 1500 ? r : null;
  }
  function odometer(now = Date.now()) {
    const p = readings();
    if (!p.length) return null;
    const last = p.reduce((a, b) => (b.miles > a.miles ? b : a));
    const r = rate();
    const est = r ? last.miles + r * Math.max(0, now - last.at) / DAY : last.miles;
    return { est: Math.round(est), last, rate: r, estimated: !!r && now - last.at > DAY / 2 };
  }
  const interval = () => ({ miles: 3000, days: 90, ...((car() || {}).interval || {}) });
  function oilDue(now = Date.now()) {
    const o = lastOil();
    if (!o) return null;
    const iv = interval(), odo = odometer(now);
    const dueMiles = o.nextMiles || (o.miles ? o.miles + iv.miles : null);
    const dueAt = o.nextAt || o.at + iv.days * DAY;
    const left = dueMiles && odo ? dueMiles - odo.est : null;
    const byMiles = left != null && odo.rate ? now + (left / odo.rate) * DAY : null;
    const when = byMiles != null ? Math.min(byMiles, dueAt) : dueAt;
    const which = byMiles != null && byMiles < dueAt ? 'miles' : 'date';
    const daysLeft = (when - now) / DAY;
    const spanMiles = dueMiles && o.miles ? dueMiles - o.miles : null;
    const pMiles = spanMiles && odo ? (odo.est - o.miles) / spanMiles : 0;
    const pTime = (now - o.at) / Math.max(DAY, dueAt - o.at);
    const progress = Math.max(0, Math.min(1, Math.max(pMiles, pTime)));
    const st = (left != null && left <= 0) || now >= dueAt ? 'due' : (left != null && left <= 300) || daysLeft <= 7 ? 'soon' : 'ok';
    return { o, dueMiles, dueAt, left, when, which, daysLeft, progress, st, odo };
  }
  // recommendations from a service stay open until a later service says it took care of them
  function recs() {
    const done = new Set();
    for (const s of S.service) for (const f of s.fixes || []) done.add(f);
    const out = [];
    for (const s of services()) (s.recs || []).forEach((text, i) => {
      const key = `${s.id}#${i}`;
      if (!done.has(key)) out.push({ key, text, s });
    });
    return out;
  }
  const tireRec = () => recs().some(r => /tire|rotat/i.test(r.text));
  // the menu badge: an oil change due within a week, or past due
  const badge = () => { if (!S.loaded) return 0; const d = oilDue(); return d && d.st !== 'ok' ? 1 : 0; };

  /* ---------- the page ---------- */
  // a plain side view of a compact SUV, facing left; the wheels light up when the shop flagged the tires
  function drawing(flagTires) {
    const wheel = cx => `<g class="wh${flagTires ? ' flag' : ''}"><circle cx="${cx}" cy="115" r="23"/><circle cx="${cx}" cy="115" r="14"/><circle cx="${cx}" cy="115" r="3.2"/></g>`;
    return `<svg class="car-art" viewBox="0 0 360 146" role="img" aria-label="Side view of the CR-V${flagTires ? ', tires flagged' : ''}">
      <path class="ground" d="M10 139h340"/>
      <path class="body" d="M26 117 24 94q0-14 12-17l74-11 36-30q5-4 12-4h124q14 0 21 11l18 30 5 34q0 10-8 10h-10a28 28 0 0 0-56 0H108a28 28 0 0 0-56 0H34q-8 0-8-6z"/>
      <path class="win" d="M120 66 150 41q3-3 8-3h52v28zM216 38h66q10 0 15 8l12 20h-93z"/>
      <path class="trim" d="M213 36v80M30 94l298-7M195 77h11M282 75h11"/>
      <path class="trim" d="M25 84l20-3 3-6-17 2zM309 57h4l10 19-5 2zM121 65h-9l-3-7 9-2z"/>
      ${wheel(80)}${wheel(280)}
    </svg>`;
  }
  function oilCard() {
    const d = oilDue();
    if (!d) return `<article class="float car-oil"><span class="lab">Next oil change</span><p class="empty">Log your last oil change and POS works out when the next one is due.</p>${canSave() ? `<div><button type="button" class="btn solid" data-act="car-form" data-form="service" data-type="oil">Log an oil change</button></div>` : ''}</article>`;
    const pill = d.st === 'due' ? `<span class="pill late">${ICON.warn}Due now</span>` : d.st === 'soon' ? `<span class="pill soonp">${ICON.warn}Soon</span>` : '<span class="pill okp">On track</span>';
    const big = d.left == null ? `<span class="fig xl">${Math.max(0, Math.ceil(d.daysLeft))}</span><span class="unit">days left</span>`
      : d.left > 0 ? `<span class="fig xl">${mi(d.left)}</span><span class="unit">miles left</span>`
      : `<span class="fig xl">${mi(-d.left)}</span><span class="unit">miles over</span>`;
    const both = `Due at <b>${d.dueMiles ? mi(d.dueMiles) + ' mi' : '—'}</b> or <b>${esc(dFull.format(d.dueAt))}</b>, whichever comes first.`;
    const est = d.st === 'due' ? 'Get it changed as soon as you can.'
      : d.which === 'miles' ? `At about ${mi(d.odo.rate)} miles a day you’ll reach that around <b>${esc(dWeek.format(d.when))}</b>, before the date.`
      : `The date comes first: <b>${esc(dWeek.format(d.dueAt))}</b>.`;
    return `<article class="float car-oil st-${d.st}">
      <div class="a-head"><span class="lab">Next oil change</span>${pill}</div>
      <div class="oil-big">${big}</div>
      <div class="track"><span style="width:${(d.progress * 100).toFixed(1)}%"></span></div>
      <div class="axis"><span>${d.o.miles ? mi(d.o.miles) : ''} · ${esc(dShort.format(d.o.at))}</span><span>${d.dueMiles ? mi(d.dueMiles) : esc(dShort.format(d.dueAt))}</span></div>
      <p class="meta">${both} ${est}</p>
      ${canSave() ? `<div class="car-acts"><button type="button" class="btn solid" data-act="car-form" data-form="service" data-type="oil">Log oil change</button></div>` : ''}
    </article>`;
  }
  function hero(v) {
    const odo = odometer();
    const flag = tireRec();
    const title = v ? `${esc(v.make || '')} ${esc(v.model || '')}${v.trim ? ' ' + esc(v.trim) : ''}` : 'Your car';
    let odoLine = '<p class="empty">No mileage yet. Log a service or read it off the dash.</p>';
    if (odo) {
      const how = odo.estimated
        ? `Estimated from ${mi(odo.last.miles)} on ${esc(dShort.format(odo.last.at))}, about ${mi(odo.rate)} miles a day. Update it when you’re in the car.`
        : `Read on ${esc(dShort.format(odo.last.at))}.`;
      odoLine = `<div class="odo"><div><span class="lab">Odometer${odo.estimated ? ', estimated' : ''}</span><span class="fig lg">${odo.estimated ? '≈ ' : ''}${mi(odo.est)} <small>mi</small></span><span class="meta">${how}</span></div>
        ${canSave() ? `<button type="button" class="btn" data-act="car-form" data-form="odometer">Update mileage</button>` : ''}</div>`;
    }
    return `<article class="float car-hero">
      <div class="a-head"><div><span class="lab">${v && v.year ? esc(String(v.year)) : 'Car'}</span><h2 class="car-name">${title}</h2></div>
        ${canSave() ? `<button type="button" class="circle" data-act="car-form" data-form="vehicle" aria-label="Edit car details">${ICON.edit}</button>` : ''}</div>
      ${drawing(flag)}
      ${flag ? `<p class="car-flag">${ICON.warn}Tires: rotate and balance recommended</p>` : ''}
      ${odoLine}
    </article>`;
  }
  function recList() {
    const r = recs();
    if (!r.length) return '';
    return `<section class="sec"><div class="sec-head"><span class="lab">Recommended</span></div>
      <div class="float list">${r.map(x => `<div class="rec-row"><span class="rec-ic">${ICON.warn}</span><div class="rec-t"><span class="name">${esc(x.text)}</span><span class="meta">${esc(x.s.shop || 'Shop')} · ${esc(dShort.format(x.s.at))}${x.s.miles ? ` at ${mi(x.s.miles)} mi` : ''}</span></div>
        ${canSave() ? `<button type="button" class="btn" data-act="car-form" data-form="service" data-fix="${esc(x.key)}">Done</button>` : ''}</div>`).join('')}</div>
    </section>`;
  }
  function serviceRow(s) {
    const open = S.open.has(s.id);
    const sub = [esc(dFull.format(s.at)), s.miles ? mi(s.miles) + ' mi' : null, s.shop ? esc(s.shop) : null].filter(Boolean).join(' · ');
    const fixed = (s.fixes || []).map(k => { const [sid, i] = k.split('#'); const src = S.service.find(x => x.id === sid); return src && src.recs ? src.recs[+i] : null; }).filter(Boolean);
    const detail = !open ? '' : `<div class="svc-more">
        ${s.items && s.items.length ? `<ul>${s.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
        ${fixed.length ? `<p class="meta">Took care of: ${fixed.map(esc).join(', ')}</p>` : ''}
        ${s.recs && s.recs.length ? `<p class="meta">Recommended: ${s.recs.map(esc).join(', ')}</p>` : ''}
        ${s.nextMiles || s.nextAt ? `<p class="meta">Next service: ${[s.nextMiles ? mi(s.nextMiles) + ' mi' : null, s.nextAt ? esc(dFull.format(s.nextAt)) : null].filter(Boolean).join(' or ')}</p>` : ''}
        ${s.codes ? `<p class="meta">Shop codes: ${esc(s.codes)}</p>` : ''}
        ${s.invoice ? `<p class="meta">Invoice ${esc(s.invoice)}${s.card ? ` · paid with card ending ${esc(s.card)}` : ''}</p>` : ''}
        ${s.note ? `<p class="meta">${esc(s.note)}</p>` : ''}
        ${canSave() ? `<div><button type="button" class="btn" data-act="car-form" data-form="service" data-id="${esc(s.id)}">Edit</button></div>` : ''}
      </div>`;
    return `<div class="svc${open ? ' open' : ''}"><button type="button" class="svc-main" data-act="car-toggle" data-id="${esc(s.id)}" aria-expanded="${open}">
        <span class="svc-l"><span class="name">${esc(s.title || (isOil(s) ? 'Oil change' : 'Service'))}</span><span class="meta">${sub}</span></span>
        <span class="svc-r">${s.cost ? `<span class="fig md">${esc(fmt(s.cost))}</span>` : ''}${ICON.chev}</span>
      </button>${detail}</div>`;
  }
  function odoRow(o) {
    return `<div class="svc odo-row"><button type="button" class="svc-main" data-act="car-form" data-form="odometer" data-id="${esc(o.id)}">
      <span class="svc-l"><span class="name">Mileage check</span><span class="meta">${esc(dFull.format(o.at))} · ${mi(o.miles)} mi${o.note ? ' · ' + esc(o.note) : ''}</span></span><span class="svc-r">${ICON.chev}</span></button></div>`;
  }
  function history() {
    const rows = S.service.map(s => ({ at: s.at, html: serviceRow(s) })).concat(S.odometer.map(o => ({ at: o.at, html: odoRow(o) })))
      .sort((a, b) => b.at - a.at);
    const spent = S.service.filter(s => s.at > Date.now() - 365 * DAY).reduce((t, s) => t + (s.cost || 0), 0);
    return `<section class="sec"><div class="sec-head"><span class="lab">Service history${spent ? ` · ${esc(fmt(spent))} this year` : ''}</span>${canSave() ? `<button type="button" class="circle" data-act="car-form" data-form="service" aria-label="Log a service">${ICON.plus}</button>` : ''}</div>
      ${rows.length ? `<div class="float list">${rows.map(r => r.html).join('')}</div>` : '<p class="empty">Nothing logged yet.</p>'}
    </section>`;
  }
  function notes() {
    const list = S.carnote.slice().sort((a, b) => b.at - a.at);
    return `<section class="sec"><div class="sec-head"><span class="lab">Notes</span>${canSave() ? `<button type="button" class="circle" data-act="car-form" data-form="note" aria-label="Add a note">${ICON.plus}</button>` : ''}</div>
      ${list.length ? `<div class="float list">${list.map(n => `<button type="button" class="note-row" data-act="car-form" data-form="note" data-id="${esc(n.id)}"><span class="note-t">${esc(n.text)}</span><span class="meta">${esc(dShort.format(n.at))}</span></button>`).join('')}</div>`
        : `<p class="empty">Anything worth remembering: a noise, a part number, what the shop said.</p>`}
    </section>`;
  }
  function details(v) {
    if (!v) return '';
    const rows = [['VIN', v.vin, true], ['Plate', v.plate], ['Engine', v.engine], ['Oil', [v.oil, v.oilQts ? v.oilQts + ' qt with filter' : null].filter(Boolean).join(', ')], ['Oil filter', v.filter],
      ['Oil change every', `${mi(interval().miles)} mi or ${Math.round(interval().days / 30)} months`]].filter(r => r[1]);
    return `<section class="sec"><div class="sec-head"><span class="lab">Details</span></div>
      <div class="float list">${rows.map(([k, val, copy]) => `<div class="kv"><span class="meta">${k}</span>${copy ? `<button type="button" class="kv-v mono" data-act="car-copy" data-v="${esc(val)}" title="Copy">${esc(val)}</button>` : `<span class="kv-v">${esc(val)}</span>`}</div>`).join('')}</div>
    </section>`;
  }
  function view() {
    let body;
    if (S.failed) body = '<p class="empty">Your car records did not load. Check the connection; POS tries again when you come back to it.</p>';
    else if (!S.loaded) body = '<p class="empty">Loading your car…</p>';
    else {
      const v = car();
      body = `<div class="car-grid"><div class="car-col">${hero(v)}${oilCard()}</div><div class="car-col">${recList()}${history()}${notes()}${details(v)}</div></div>`;
    }
    return `<div class="car"><div class="car-scroll" id="carScroll" data-keep>${body}</div></div>`;
  }

  /* ---------- forms ---------- */
  const field = (label, inner, hint) => `<label class="f"><span class="lab">${label}</span>${inner}${hint ? `<span class="f-h">${hint}</span>` : ''}</label>`;
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const pad = n => String(n).padStart(2, '0');
  const dateInput = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const readDate = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : null; };
  const readMiles = s => { const t = String(s || '').replace(/[,\s]|mi(les)?/gi, ''); if (!t) return null; return /^\d{1,7}$/.test(t) ? +t : NaN; };
  function readMoney(s) {
    const t = String(s || '').replace(/[$,\s]/g, '');
    if (!t) return null;
    const m = /^(\d*)(?:\.(\d{1,2}))?$/.exec(t);
    return m && (m[1] || m[2]) ? parseInt(m[1] || '0', 10) * 100 + parseInt((m[2] || '0').padEnd(2, '0'), 10) : NaN;
  }
  const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 30);

  const forms = {
    service(id, x) {
      const s = id ? S.service.find(z => z.id === id) : null;
      const fix = x.fix ? recs().find(r => r.key === x.fix) : null;
      const type = s ? (s.type || 'other') : fix ? 'other' : (x.type || 'oil');
      const odo = odometer();
      const open = recs().filter(r => !s || r.s.id !== s.id);
      const fixes = new Set(s ? s.fixes || [] : fix ? [fix.key] : []);
      for (const k of fixes) if (!open.some(r => r.key === k)) { const [sid, i] = k.split('#'); const src = S.service.find(z => z.id === sid); if (src && src.recs && src.recs[+i]) open.push({ key: k, text: src.recs[+i], s: src }); }
      return {
        title: s ? 'Edit service' : fix ? fix.text : type === 'oil' ? 'Log an oil change' : 'Log a service', del: !!s,
        body: `<div class="seg-ctl" role="radiogroup" aria-label="Kind">
            <label><input type="radio" name="cf_type" id="cf_type_oil" value="oil"${type === 'oil' ? ' checked' : ''}><span>Oil change</span></label>
            <label><input type="radio" name="cf_type" value="other"${type !== 'oil' ? ' checked' : ''}><span>Other service</span></label>
          </div>`
          + `<div id="cf_title_wrap"${type === 'oil' ? ' hidden' : ''}>${field('What was done', `<input id="cf_title" autocomplete="off" maxlength="80" placeholder="Tire rotation, brakes, new wipers" value="${esc(s ? s.title || '' : fix ? fix.text : '')}">`)}</div>`
          + `<div class="two">${field('Date', `<input id="cf_date" type="date" value="${dateInput(s ? s.at : Date.now())}">`)}`
          + field('Mileage', `<input id="cf_miles" inputmode="numeric" autocomplete="off" placeholder="${odo ? mi(odo.est) : '128,812'}" value="${s && s.miles ? mi(s.miles) : ''}">`) + '</div>'
          + `<div class="two">${field('Where', `<input id="cf_shop" autocomplete="off" maxlength="60" placeholder="Express Oil Change" value="${esc(s ? s.shop || '' : 'Express Oil Change')}">`)}`
          + field('Cost', `<input id="cf_cost" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${s && s.cost ? (s.cost / 100).toFixed(2) : ''}">`) + '</div>'
          + `<div id="cf_next_wrap"${type === 'oil' ? '' : ' hidden'}><div class="two">${field('Next due at', `<input id="cf_next_miles" inputmode="numeric" autocomplete="off" placeholder="+${mi(interval().miles)}" value="${s && s.nextMiles ? mi(s.nextMiles) : ''}">`)}`
          + field('or by', `<input id="cf_next_at" type="date" value="${s && s.nextAt ? dateInput(s.nextAt) : ''}">`) + `</div><span class="f-h">From the receipt (“Recommend next service on…”). Leave blank for ${mi(interval().miles)} miles or ${Math.round(interval().days / 30)} months.</span></div>`
          + (open.length ? `<div class="f"><span class="lab">Also took care of</span>${open.map(r => `<label class="f-check"><input type="checkbox" data-fix="${esc(r.key)}"${fixes.has(r.key) ? ' checked' : ''}><span>${esc(r.text)} <small class="meta">· ${esc(dShort.format(r.s.at))}</small></span></label>`).join('')}</div>` : '')
          + field('Work done', `<textarea id="cf_items" rows="3" placeholder="One per line">${esc(s && s.items ? s.items.join('\n') : '')}</textarea>`)
          + field('Shop recommended', `<textarea id="cf_recs" rows="2" placeholder="One per line, e.g. Cabin air filter">${esc(s && s.recs ? s.recs.join('\n') : '')}</textarea>`, 'Each one stays under Recommended until a later service takes care of it.')
          + field('Note', `<input id="cf_note" autocomplete="off" maxlength="300" value="${esc(s ? s.note || '' : '')}">`),
      };
    },
    odometer(id) {
      const o = id ? S.odometer.find(z => z.id === id) : null;
      const odo = odometer();
      return {
        title: o ? 'Mileage check' : 'Update mileage', del: !!o,
        body: field('Odometer', `<input id="cf_miles" class="big" inputmode="numeric" autocomplete="off" placeholder="${odo ? mi(odo.est) : ''}" value="${o ? mi(o.miles) : ''}">`, odo && !o ? `POS estimates about ${mi(odo.est)}. Type what the dash says.` : '')
          + field('Date', `<input id="cf_date" type="date" value="${dateInput(o ? o.at : Date.now())}">`)
          + field('Note', `<input id="cf_note" autocomplete="off" maxlength="200" placeholder="Optional" value="${esc(o ? o.note || '' : '')}">`),
      };
    },
    note(id) {
      const n = id ? S.carnote.find(z => z.id === id) : null;
      return { title: n ? 'Note' : 'Add a note', del: !!n, body: field('Note', `<textarea id="cf_text" rows="5" maxlength="2000" placeholder="A noise, a part number, what the shop said">${esc(n ? n.text : '')}</textarea>`) };
    },
    vehicle() {
      const v = car() || {}, iv = interval();
      return {
        title: 'Car details', del: false,
        body: `<div class="two">${field('Year', `<input id="cf_year" inputmode="numeric" maxlength="4" value="${esc(String(v.year || ''))}">`)}${field('Trim', `<input id="cf_trim" maxlength="20" value="${esc(v.trim || '')}">`)}</div>`
          + `<div class="two">${field('Make', `<input id="cf_make" maxlength="30" value="${esc(v.make || '')}">`)}${field('Model', `<input id="cf_model" maxlength="30" value="${esc(v.model || '')}">`)}</div>`
          + field('VIN', `<input id="cf_vin" autocapitalize="characters" maxlength="17" value="${esc(v.vin || '')}">`)
          + field('Plate', `<input id="cf_plate" autocapitalize="characters" maxlength="12" value="${esc(v.plate || '')}">`)
          + field('Engine', `<input id="cf_engine" maxlength="80" value="${esc(v.engine || '')}">`)
          + `<div class="two">${field('Oil', `<input id="cf_oil" maxlength="40" value="${esc(v.oil || '')}">`)}${field('Oil filter', `<input id="cf_filter" maxlength="30" value="${esc(v.filter || '')}">`)}</div>`
          + `<div class="two">${field('Oil change every (miles)', `<input id="cf_iv_miles" inputmode="numeric" value="${mi(iv.miles)}">`)}${field('or (months)', `<input id="cf_iv_months" inputmode="numeric" value="${Math.round(iv.days / 30)}">`)}</div>`,
      };
    },
  };
  function fail(msg) { const e = $('#carErr'); e.textContent = msg; e.hidden = false; return false; }
  const submit = {
    async service() {
      const type = (document.querySelector('input[name="cf_type"]:checked') || {}).value === 'oil' ? 'oil' : 'other';
      const at = readDate(val('cf_date')), miles = readMiles(val('cf_miles')), cost = readMoney(val('cf_cost'));
      const title = type === 'oil' ? 'Oil change' : val('cf_title');
      if (!title) return fail('Say what was done.');
      if (!at) return fail('Pick the date.');
      if (Number.isNaN(miles)) return fail('Mileage should be a whole number, like 128812.');
      if (Number.isNaN(cost)) return fail('Cost should be an amount, like 86.28.');
      const nextMiles = type === 'oil' ? readMiles(val('cf_next_miles')) : null, nextAt = type === 'oil' ? readDate(val('cf_next_at')) : null;
      if (Number.isNaN(nextMiles)) return fail('Next due mileage should be a whole number.');
      if (nextMiles && miles && nextMiles <= miles) return fail('Next due mileage should be more than this visit’s mileage.');
      const fixes = [...document.querySelectorAll('#carBody [data-fix]')].filter(c => c.checked).map(c => c.dataset.fix);
      const d = { type, title, at, miles: miles || null, shop: val('cf_shop'), cost: cost || null, nextMiles: nextMiles || null, nextAt: nextAt || null,
        items: lines(val('cf_items')), recs: lines(val('cf_recs')), fixes, note: val('cf_note') };
      if (F.id) {
        if (!(await save(db.update('service', F.id, d)))) return false;
        toast('Saved');
      } else {
        if (!(await save(db.set('service', newId('svc'), { ...d, source: 'manual', createdAt: Date.now() })))) return false;
        toast(type === 'oil' ? 'Oil change logged' : 'Service logged');
      }
      return true;
    },
    async odometer() {
      const miles = readMiles(val('cf_miles')), at = readDate(val('cf_date'));
      if (!miles || Number.isNaN(miles)) return fail('Type the odometer reading, like 131020.');
      if (!at) return fail('Pick the date.');
      // a reading for today keeps the time it was typed, so it counts as the newest
      const when = dateInput(at) === dateInput(Date.now()) ? Date.now() : at;
      const prior = readings().filter(r => r.id !== F.id && r.at <= when).reduce((m, r) => (!m || r.miles > m.miles ? r : m), null);
      if (prior && miles < prior.miles) return fail(`That’s less than ${mi(prior.miles)}, read on ${dShort.format(prior.at)}.`);
      const d = { at: when, miles, note: val('cf_note') };
      if (!(await save(F.id ? db.update('odometer', F.id, d) : db.set('odometer', newId('odo'), { ...d, createdAt: Date.now() })))) return false;
      toast(`Mileage ${mi(miles)}`);
      return true;
    },
    async note() {
      const text = val('cf_text');
      if (!text) return fail('Write the note first.');
      if (!(await save(F.id ? db.update('carnote', F.id, { text }) : db.set('carnote', newId('note'), { text, at: Date.now() })))) return false;
      return true;
    },
    async vehicle() {
      const v = car();
      const year = val('cf_year') ? parseInt(val('cf_year'), 10) : null;
      const ivm = readMiles(val('cf_iv_miles')), ivmo = readMiles(val('cf_iv_months'));
      if (year != null && !(year > 1900 && year < 2100)) return fail('Year should look like 2017.');
      if (!ivm || Number.isNaN(ivm) || !ivmo || Number.isNaN(ivmo)) return fail('Oil change interval needs miles and months.');
      const d = { year, make: val('cf_make'), model: val('cf_model'), trim: val('cf_trim'), vin: val('cf_vin').toUpperCase(), plate: val('cf_plate').toUpperCase(),
        engine: val('cf_engine'), oil: val('cf_oil'), filter: val('cf_filter'), interval: { miles: ivm, days: ivmo * 30 } };
      return save(v ? db.update('vehicle', v.id, d) : db.set('vehicle', newId('car'), { ...d, createdAt: Date.now() }));
    },
  };

  document.body.insertAdjacentHTML('beforeend', `<dialog id="carSheet" aria-labelledby="carTitle">
    <form id="carForm" novalidate>
      <div class="sheet-head" id="carHead"><div class="grab"></div><div class="bar"><h2 id="carTitle"></h2><button type="button" class="circle" id="carClose" aria-label="Close"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></div></div>
      <div id="carBody" class="sheet-body"></div>
      <p id="carErr" class="err" hidden></p>
      <div class="sheet-foot"><button type="button" id="carDel" class="btn danger" hidden>Delete</button><button type="submit" id="carSave" class="btn solid">Save</button></div>
    </form>
  </dialog>`);
  const sheet = $('#carSheet');
  function openForm(kind, id, extra = {}) {
    if (!canSave() || !forms[kind]) return;
    const spec = forms[kind](id || null, extra);
    F = { kind, id: id || null, armed: false };
    $('#carTitle').textContent = spec.title;
    $('#carBody').innerHTML = spec.body;
    $('#carErr').hidden = true;
    const del = $('#carDel');
    del.hidden = !spec.del; del.textContent = 'Delete'; del.classList.remove('armed'); del.disabled = false;
    $('#carSave').disabled = false;
    if (ctx.setDrawer) ctx.setDrawer(false);
    sheet.style.transform = '';
    if (!sheet.open) sheet.showModal();
  }
  function closeForm() { if (sheet.open) sheet.close(); F = null; }
  $('#carClose').addEventListener('click', closeForm);
  sheet.addEventListener('close', () => { F = null; });
  $('#carBody').addEventListener('change', e => {
    if (e.target.name !== 'cf_type') return;
    const oil = e.target.value === 'oil';
    $('#cf_title_wrap').hidden = oil; $('#cf_next_wrap').hidden = !oil;
    if (!oil) { const t = $('#cf_title'); if (t && !t.value) t.focus(); }
  });
  $('#carDel').addEventListener('click', async e => {
    if (!F || !F.id) return;
    const b = e.currentTarget;
    if (!F.armed) { F.armed = true; b.classList.add('armed'); b.textContent = 'Tap again to delete'; return; }
    b.disabled = true;
    const k = F.kind === 'note' ? 'carnote' : F.kind;
    const ok = await save(db.remove(k, F.id));
    b.disabled = false;
    if (ok) { closeForm(); toast('Deleted'); }
  });
  $('#carForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!F) return;
    $('#carErr').hidden = true;
    const btn = $('#carSave');
    btn.disabled = true;
    const ok = await submit[F.kind]();
    btn.disabled = false;
    if (ok) closeForm();
  });
  // pull the sheet down by its top edge to dismiss
  let pull = null;
  sheet.addEventListener('touchstart', e => {
    pull = null;
    if (e.touches.length !== 1 || !e.target.closest('#carHead') || e.target.closest('button')) return;
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
    if (p.on && p.dy > 90) closeForm();
    sheet.style.transform = '';
  };
  sheet.addEventListener('touchend', endPull);
  sheet.addEventListener('touchcancel', endPull);

  /* ---------- taps routed here by POS (data-act="car-…") ---------- */
  function act(name, b) {
    if (name === 'car-toggle') { const id = b.dataset.id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); rerender(); return; }
    if (name === 'car-copy') {
      const v = b.dataset.v || '';
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('VIN copied'), () => toast(v));
      return;
    }
    if (!canSave()) return;
    if (name === 'car-form') openForm(b.dataset.form, b.dataset.id, { type: b.dataset.type, fix: b.dataset.fix });
  }
  const add = () => openForm('service', null, { type: 'oil' });
  const sheetOpen = () => sheet.open;

  return { view, act, add, start, stop, sheetOpen, badge, oilDue };
};
