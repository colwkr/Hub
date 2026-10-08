// POS Finance: the Split Ledger, running inside the Personal Operating System.
// Accounts hold a balance set from the bank; savings accounts are split into goals; spending limits reset monthly;
// every charge waits in "Needs approval" until it is sorted. Amounts are whole cents, times are epoch ms.
// Records live in Supabase table fin_docs (one row per account, bucket or transaction, owner-only).
window.POSFinance = function (ctx) {
  const { sb, toast, rerender, esc, clamp } = ctx;
  const $ = (s, r = document) => r.querySelector(s);
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmt = cents => usd.format((cents || 0) / 100);
  const plain = cents => ((cents || 0) / 100).toFixed(2);
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const shortDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long' });
  const DAY = 86400000;
  const ICON = {
    edit: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5h3.6L19 8.6 15.4 5 4.5 15.9zM13.6 6.8l3.6 3.6"/></svg>',
    plus: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M5.5 12h13"/></svg>',
  };
  const canSave = () => ctx.canSave();

  // Money is kept in whole cents. Returns null when the text is not an amount.
  function parseMoney(text, allowNegative) {
    const s = String(text ?? '').replace(/[$,\s]/g, '');
    const m = /^(-?)(\d*)(?:\.(\d{1,2}))?$/.exec(s);
    if (!m || (!m[2] && !m[3])) return null;
    if (m[1] && !allowNegative) return null;
    const cents = parseInt(m[2] || '0', 10) * 100 + parseInt((m[3] || '0').padEnd(2, '0'), 10);
    return m[1] ? -cents : cents;
  }

  const SUBS = { home: 'Overview', savings: 'Savings', spending: 'Spending', activity: 'Activity' };
  const S = { loaded: false, failed: false, accounts: [], buckets: [], txns: [], sub: 'home', open: new Set(), confirmClear: false };
  try { const t = localStorage.getItem('pos.fin.sub'); if (SUBS[t]) S.sub = t; } catch (e) {}
  let F = null; // the form currently in the sheet
  const charts = new Map();

  /* ---------- storage: same calls the ledger always made, now on Supabase ---------- */
  const KINDS = ['accounts', 'buckets', 'txns'];
  const must = ({ error }) => { if (error) throw error; };
  const strip = d => { const { id, ...rest } = d || {}; return rest; };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const refs = {};
  for (const k of KINDS) {
    refs[k] = {
      doc(id) {
        return {
          async set(d) {
            const rid = id || newId();
            S[k] = S[k].filter(x => x.id !== rid).concat([{ ...d, id: rid }]); rerender();
            try { must(await sb.from('fin_docs').insert({ id: rid, kind: k, data: d })); } catch (e) { scheduleLoad(); throw e; }
          },
          async update(patch) {
            const cur = S[k].find(x => x.id === id);
            if (!cur) throw new Error('missing');
            const merged = { ...strip(cur), ...patch };
            Object.assign(cur, patch); rerender();
            try { must(await sb.from('fin_docs').update({ data: merged }).eq('id', id)); } catch (e) { scheduleLoad(); throw e; }
          },
          async delete() {
            S[k] = S[k].filter(x => x.id !== id); rerender();
            try { must(await sb.from('fin_docs').delete().eq('id', id)); } catch (e) { scheduleLoad(); throw e; }
          },
        };
      },
    };
  }
  let loadT = null, channel = null;
  const scheduleLoad = () => { clearTimeout(loadT); loadT = setTimeout(load, 300); };
  async function load() {
    const { data, error } = await sb.from('fin_docs').select('id,kind,data').limit(20000);
    if (error) { S.failed = true; rerender(); return; }
    S.failed = false; S.loaded = true;
    for (const k of KINDS) S[k] = [];
    for (const r of data) if (S[r.kind]) S[r.kind].push({ ...r.data, id: r.id });
    rerender();
  }
  function start() {
    load();
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('pos-finance').on('postgres_changes', { event: '*', schema: 'public', table: 'fin_docs' }, scheduleLoad).subscribe();
  }
  function stop() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    S.loaded = false; S.failed = false; for (const k of KINDS) S[k] = [];
  }

  /* ---------- derived numbers ---------- */
  const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  const kind = k => S.buckets.filter(b => b.kind === k).sort(byCreated);
  const acct = id => S.accounts.find(a => a.id === id);
  const bucket = id => S.buckets.find(b => b.id === id);
  const isOut = t => t.dir !== 'in';
  const effect = (a, t) => (a.type === 'credit' ? (isOut(t) ? 1 : -1) : (isOut(t) ? -1 : 1)) * t.amount;
  const sorted = list => list.slice().sort(byCreated);
  const savingsAccounts = () => sorted(S.accounts.filter(a => a.type === 'savings'));
  const catsOf = a => kind('goal').filter(g => g.accountId === a.id);

  // An account holds the balance it was last set to, plus everything dated after that moment.
  function acctBalance(a) {
    let b = a.balance || 0;
    for (const t of S.txns) if (t.accountId === a.id && t.at > (a.balanceAt || 0)) b += effect(a, t);
    return b;
  }
  function catLeft(g) {
    let v = g.saved || 0;
    for (const t of S.txns) if (t.bucketId === g.id && isOut(t)) v -= t.amount;
    return v;
  }
  // Money in the account that no category holds. Positive: money came in and needs sorting.
  // Negative: money left. Charges still waiting for approval are not counted against it yet.
  function unsorted(a) {
    let pending = 0;
    for (const t of S.txns) if (t.accountId === a.id && isOut(t) && !t.bucketId && t.at > (a.balanceAt || 0)) pending += t.amount;
    return acctBalance(a) - catsOf(a).reduce((s, g) => s + catLeft(g), 0) + pending;
  }
  function slotOf(g) {
    if (Number.isInteger(g.slot)) return g.slot;
    const a = acct(g.accountId);
    return a ? catsOf(a).findIndex(x => x.id === g.id) : 0;
  }
  // one ink, stepped lighter down the list, so the bar reads in the same order as the rows under it
  const SHADES = [1, .72, .5, .34, .24, .17, .12, .09];
  const shadeOf = g => { const s = slotOf(g); return SHADES[s >= 0 && s < 8 ? s : 7]; };
  function monthRange(now = new Date()) {
    return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()];
  }
  function limitCharges(l) {
    const [a, b] = monthRange();
    return S.txns.filter(t => t.bucketId === l.id && isOut(t) && t.at >= a && t.at < b).sort((x, y) => y.at - x.at);
  }
  const limitSpent = l => limitCharges(l).reduce((s, t) => s + t.amount, 0);
  const inbox = () => S.txns.filter(t => isOut(t) && !t.bucketId).sort((a, b) => b.at - a.at);
  const savingsToSort = () => savingsAccounts().filter(a => unsorted(a) !== 0);

  function acctLabel(a) {
    if (!a) return 'Removed account';
    const l4 = (a.last4 || [])[0];
    return a.name + (l4 ? ' ••' + l4 : '');
  }
  function bucketLabel(t) {
    if (!t.bucketId) return null;
    if (t.bucketId === '_none') return 'Not spending';
    const b = bucket(t.bucketId);
    return b ? b.name : 'Removed category';
  }
  const exTag = d => d && d.example ? '<span class="tag">Example</span>' : '';
  const when = ms => dayFmt.format(ms) + ' · ' + timeFmt.format(ms);

  /* ---------- pieces ---------- */
  function chargeCard(t) {
    const chips = kind('limit').map(l => {
      const left = (l.monthly || 0) - limitSpent(l);
      return `<button type="button" class="chip" data-act="fin-sort" data-txn="${esc(t.id)}" data-bucket="${esc(l.id)}">${esc(l.name)}<span>${left >= 0 ? fmt(left) + ' left' : fmt(-left) + ' over'}</span></button>`;
    }).concat(kind('goal').filter(g => g.accountId === t.accountId).map(g =>
      `<button type="button" class="chip" data-act="fin-sort" data-txn="${esc(t.id)}" data-bucket="${esc(g.id)}">${esc(g.name)}<span>${fmt(catLeft(g))}</span></button>`
    ));
    return `<article class="float charge">
      <div class="c-top">
        <div><span class="name">${esc(t.merchant)}${exTag(t)}</span><span class="meta">${esc(when(t.at))} · ${esc(acctLabel(acct(t.accountId)))}</span></div>
        <span class="fig lg">${fmt(t.amount)}</span>
      </div>
      <div class="chips">${chips.join('')}<button type="button" class="chip quiet" data-act="fin-sort" data-txn="${esc(t.id)}" data-bucket="_none">Not spending</button></div>
    </article>`;
  }

  // "$500.00 has been added to Savings and needs to be sorted."
  function sortNote(a) {
    const u = unsorted(a), cats = catsOf(a);
    if (!u) return '';
    const btn = !canSave() ? '' : !cats.length
      ? `<button type="button" class="btn solid" data-act="fin-form" data-form="goal" data-account="${esc(a.id)}">New category</button>`
      : `<button type="button" class="btn solid" data-act="fin-form" data-form="allocate" data-id="${esc(a.id)}">${u > 0 ? 'Sort' : 'Choose'}</button>`;
    return u > 0
      ? `<div class="float note"><p><b>${fmt(u)}</b> has been added to ${esc(a.name)} and needs to be sorted.</p>${btn}</div>`
      : `<div class="float note bad"><p><b>${fmt(-u)}</b> has left ${esc(a.name)}. Choose which categories it came out of.</p>${btn}</div>`;
  }

  function splitBar(a) {
    const cats = catsOf(a);
    if (!cats.length) return '';
    const u = Math.max(0, unsorted(a));
    const parts = cats.map(g => ({ g, left: Math.max(0, catLeft(g)) }));
    const total = Math.max(parts.reduce((s, p) => s + p.left, 0) + u, 1);
    const pct = v => (v / total * 100).toFixed(2);
    const segs = parts.filter(p => p.left > 0).map(p => `<span class="seg" style="width:${pct(p.left)}%;opacity:${shadeOf(p.g)}"></span>`).join('')
      + (u > 0 ? `<span class="seg free" style="width:${pct(u)}%"></span>` : '');
    const label = parts.map(p => p.g.name + ' ' + fmt(p.left)).join(', ') + (u > 0 ? ', not sorted ' + fmt(u) : '');
    return `<div class="split" role="img" aria-label="${esc(label)}">${segs}</div>`;
  }

  // Balance as a stepped line from when it was last set (at most 30 days back) to now.
  function series(a) {
    const now = Date.now();
    const t0 = Math.min(Math.max(a.balanceAt || now, now - 30 * DAY), now - DAY);
    const tx = S.txns.filter(t => t.accountId === a.id && t.at > (a.balanceAt || 0) && t.at <= now).sort((x, y) => x.at - y.at);
    let v = a.balance || 0;
    for (const t of tx) if (t.at <= t0) v += effect(a, t);
    const pts = [{ t: t0, v }];
    for (const t of tx) if (t.at > t0) { v += effect(a, t); pts.push({ t: t.at, v }); }
    return { t0, t1: now, pts };
  }
  function chart(a) {
    const s = series(a);
    charts.set(a.id, s);
    const W = 300, H = 60, pad = 6;
    let lo = Math.min(...s.pts.map(p => p.v)), hi = Math.max(...s.pts.map(p => p.v));
    if (hi === lo) { hi += 1; lo -= 1; }
    const x = t => ((t - s.t0) / (s.t1 - s.t0) * W).toFixed(1);
    const y = v => (pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad)).toFixed(1);
    let d = `M0,${y(s.pts[0].v)}`;
    for (let i = 1; i < s.pts.length; i++) d += `H${x(s.pts[i].t)}V${y(s.pts[i].v)}`;
    d += `H${W}`;
    const last = s.pts[s.pts.length - 1].v;
    const label = `${a.type === 'credit' ? 'Amount owed' : 'Balance'} from ${shortDay.format(s.t0)} to today, now ${fmt(last)}`;
    return `<div class="chart" data-chart="${esc(a.id)}" role="img" aria-label="${esc(label)}">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="line" d="${d}" vector-effect="non-scaling-stroke"/></svg>
        <i class="end" style="top:${(y(last) / H * 100).toFixed(1)}%"></i><i class="xh" hidden></i><span class="tip" hidden></span>
      </div>
      <div class="axis"><span>${esc(shortDay.format(s.t0))}</span><span>Today</span></div>`;
  }

  function accountCard(a) {
    const credit = a.type === 'credit';
    const cards = (a.last4 || []).map(x => '••' + x).join(' ');
    return `<article class="float acct">
      <div class="a-head">
        <div><span class="lab">${esc(a.name)}${cards ? ' ' + esc(cards) : ''}${credit ? ' · owed' : ''}${exTag(a)}</span><span class="fig lg">${fmt(acctBalance(a))}</span></div>
        ${canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="account" data-id="${esc(a.id)}" aria-label="Edit ${esc(a.name)}">${ICON.edit}</button>` : ''}
      </div>
      ${chart(a)}
    </article>`;
  }

  /* ---------- views ---------- */
  function vHome() {
    const todo = inbox();
    const accounts = sorted(S.accounts);
    const sum = f => S.accounts.filter(f).reduce((s, a) => s + acctBalance(a), 0);
    const totals = accounts.length ? `<div class="totals">
        <div class="float"><span class="lab">Checking</span><span class="fig md">${fmt(sum(a => a.type === 'checking'))}</span></div>
        <div class="float"><span class="lab">Savings</span><span class="fig md">${fmt(sum(a => a.type === 'savings'))}</span></div>
        <div class="float"><span class="lab">Owed on cards</span><span class="fig md">${fmt(sum(a => a.type === 'credit'))}</span></div>
      </div>` : '';
    let left = '';
    if (todo.length) left += `<section class="sec"><span class="lab">Needs approval · ${todo.length}</span><div class="stack">${todo.map(chargeCard).join('')}</div></section>`;
    const notes = savingsToSort().map(sortNote).join('');
    if (notes) left += `<section class="sec">${notes}</section>`;
    if (!left) left = '<section class="sec"><span class="lab">Needs approval</span><p class="empty">Nothing waiting. New charges show up here to be sorted.</p></section>';
    let right = '<section class="sec"><div class="sec-head"><span class="lab">Accounts</span>'
      + (canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="account" aria-label="Add account">${ICON.plus}</button>` : '') + '</div>';
    right += accounts.length ? `<div class="stack">${accounts.map(accountCard).join('')}</div>`
      : '<p class="empty">No accounts yet. Add checking, savings and your credit card with today’s balance from Regions.</p>';
    right += '</section>';
    return `${totals}<div class="fin-two"><div>${left}</div><div>${right}</div></div>${examplesBar()}`;
  }

  function examplesBar() {
    const examples = [...S.accounts, ...S.buckets, ...S.txns].filter(d => d.example).length;
    if (!examples) return '';
    return `<div class="examples"><span>Example numbers are loaded.</span>${
      S.confirmClear
        ? `<button type="button" class="link" data-act="fin-clear-yes" style="color:var(--bad)">Delete ${examples} example ${examples === 1 ? 'item' : 'items'}</button><button type="button" class="link" data-act="fin-clear-no">Keep</button>`
        : '<button type="button" class="link" data-act="fin-clear-ask">Clear examples</button>'}</div>`;
  }

  function catRow(g) {
    const left = catLeft(g);
    const pct = g.target ? clamp(left / g.target * 100, 0, 100) : null;
    return `<div class="row"><div class="cat">
      <i class="dot" style="opacity:${shadeOf(g)}"></i>
      <span class="name">${esc(g.name)}${exTag(g)}</span>
      <span class="fig md"${left < 0 ? ' style="color:var(--bad)"' : ''}>${fmt(left)}</span>
      ${canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="goal" data-id="${esc(g.id)}" aria-label="Edit ${esc(g.name)}">${ICON.edit}</button>` : '<span></span>'}
      ${g.target ? `<div class="track"><span style="width:${pct.toFixed(2)}%"></span></div><span class="meta">${Math.round(pct)}% of ${fmt(g.target)}</span>` : ''}
    </div></div>`;
  }

  function vSavings() {
    const accts = savingsAccounts();
    if (!accts.length) return `<div class="fin-page"><p class="empty">No savings account yet. Add one and split its balance into categories.</p>${canSave() ? '<div><button type="button" class="btn solid" data-act="fin-form" data-form="account" data-type="savings">Add savings account</button></div>' : ''}</div>`;
    const total = accts.reduce((s, a) => s + acctBalance(a), 0);
    let h = `<div class="hero"><span class="fig xl">${fmt(total)}</span>${accts.length === 1 ? splitBar(accts[0]) : ''}</div>`;
    for (const a of accts) {
      const cats = catsOf(a);
      h += '<section class="sec">';
      if (accts.length > 1) h += `<div class="sec-head"><span class="lab">${esc(a.name)}</span><span class="fig md">${fmt(acctBalance(a))}</span></div>${splitBar(a)}`;
      h += sortNote(a);
      h += `<div class="float list">${cats.map(catRow).join('')}${canSave() ? `<button type="button" class="add-row" data-act="fin-form" data-form="goal" data-account="${esc(a.id)}"><span>New category</span>${ICON.plus}</button>` : ''}</div>`;
      h += '</section>';
    }
    return `<div class="fin-page">${h}</div>`;
  }

  function limitRow(l) {
    const charges = limitCharges(l);
    const spent = charges.reduce((s, t) => s + t.amount, 0);
    const left = (l.monthly || 0) - spent;
    const ratio = l.monthly ? spent / l.monthly : 0;
    const state = left < 0 ? 'over' : ratio >= 0.85 ? 'near' : '';
    const open = S.open.has(l.id);
    return `<div class="row limit ${state}">
      <div class="l-head">
        <div><span class="name">${esc(l.name)}${exTag(l)} ${state === 'over' ? '<span class="pill over">Over</span>' : state === 'near' ? '<span class="pill near">Almost out</span>' : ''}</span>
        <span class="meta num">${fmt(spent)} of ${fmt(l.monthly)}</span></div>
        <span class="fig lg"${left < 0 ? ' style="color:var(--bad)"' : ''}>${left < 0 ? '−' + fmt(-left) : fmt(left)}</span>
      </div>
      <div class="meter" role="img" aria-label="${esc(fmt(spent) + ' spent of ' + fmt(l.monthly))}"><span style="width:${Math.min(100, ratio * 100).toFixed(2)}%"></span></div>
      <div class="l-foot">
        ${charges.length ? `<button type="button" class="link" data-act="fin-toggle" data-id="${esc(l.id)}" aria-expanded="${open}">${open ? 'Hide' : 'Show'} ${charges.length} ${charges.length === 1 ? 'charge' : 'charges'}</button>` : '<span>No charges this month</span>'}
        <button type="button" class="link" data-act="fin-form" data-form="limit" data-id="${esc(l.id)}">Edit</button>
      </div>
      ${open && charges.length ? `<div class="mini">${charges.map(t => `<div><span>${esc(t.merchant)} · ${esc(shortDay.format(t.at))}</span><span class="num">${fmt(t.amount)}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }

  function vSpending() {
    const limits = kind('limit');
    const now = new Date();
    const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
    return `<div class="fin-page"><section class="sec"><span class="lab">${esc(monthFmt.format(now))} · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left</span>
      <div class="float list">${limits.map(limitRow).join('')}${canSave() ? `<button type="button" class="add-row" data-act="fin-form" data-form="limit"><span>New limit</span>${ICON.plus}</button>` : ''}</div></section></div>`;
  }

  function vActivity() {
    const all = S.txns.slice().sort((a, b) => b.at - a.at);
    if (!all.length) return '<div class="fin-page"><p class="empty">No charges or deposits yet. Tap + to add one.</p></div>';
    let h = '', day = '', rows = '';
    const flush = () => { if (rows) h += `<section class="sec"><span class="lab">${esc(day)}</span><div class="float list">${rows}</div></section>`; rows = ''; };
    for (const t of all) {
      const d = dayFmt.format(t.at);
      if (d !== day) { flush(); day = d; }
      const label = bucketLabel(t);
      const pill = !isOut(t) ? '<span class="pill">Deposit</span>' : label ? `<span class="pill">${esc(label)}</span>` : '<span class="pill todo">Needs approval</span>';
      rows += `<button type="button" class="tx" data-act="fin-form" data-form="charge" data-id="${esc(t.id)}">
        <span class="name">${esc(t.merchant)}${exTag(t)}</span>
        <span class="fig md t-amt ${isOut(t) ? '' : 'in'}">${isOut(t) ? '' : '+'}${fmt(t.amount)}</span>
        <span class="t-sub meta">${esc(timeFmt.format(t.at))} · ${esc(acctLabel(acct(t.accountId)))} ${pill}</span>
      </button>`;
    }
    flush();
    return `<div class="fin-page">${h}</div>`;
  }

  const views = { home: vHome, savings: vSavings, spending: vSpending, activity: vActivity };
  const counts = () => { const nSav = savingsToSort().length; return { home: inbox().length + nSav, savings: nSav }; };

  function view() {
    charts.clear();
    const n = counts();
    const tabs = Object.entries(SUBS).map(([k, label]) =>
      `<button type="button" data-act="fin-sub" data-sub="${k}"${S.sub === k ? ' aria-current="page"' : ''}>${label}${n[k] ? `<span class="badge">${n[k]}</span>` : ''}</button>`).join('');
    let body;
    if (S.failed) body = '<p class="empty">Your finances did not load. Check the connection; POS tries again when you come back to it.</p>';
    else if (!S.loaded) body = '<p class="empty">Loading your accounts and categories…</p>';
    else body = views[S.sub]();
    return `<div class="fin"><nav class="fin-tabs" aria-label="Finance sections">${tabs}</nav><div class="fin-scroll" id="finScroll" data-keep>${body}</div></div>`;
  }
  // what the menu badge shows: charges to approve plus savings to sort
  const badge = () => (S.loaded ? counts().home : 0);

  /* ---------- saving ---------- */
  async function save(promise) {
    try { await promise; return true; }
    catch (e) { toast('That did not save. Check your connection and try again.'); return false; }
  }
  async function sortTxn(id, bucketId) {
    const t = S.txns.find(x => x.id === id);
    if (!t) return;
    const prev = t.bucketId || null;
    const name = bucketId === '_none' ? 'Not spending' : (bucket(bucketId) || {}).name;
    if (await save(refs.txns.doc(id).update({ bucketId }))) toast('Approved to ' + name, () => save(refs.txns.doc(id).update({ bucketId: prev })));
  }
  async function clearExamples() {
    for (const key of ['txns', 'buckets', 'accounts']) {
      for (const d of S[key].filter(x => x.example)) if (!(await save(refs[key].doc(d.id).delete()))) return;
    }
    toast('Examples cleared');
  }

  /* ---------- forms ---------- */
  const field = (label, inner, hint) => `<label class="f"><span class="lab">${label}</span>${inner}${hint ? `<span class="f-h">${hint}</span>` : ''}</label>`;
  const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
  const opt = (value, label, sel) => `<option value="${esc(value)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
  function localInput(ms) {
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function bucketOptions(accountId, current) {
    return [opt('', 'Approve it later', !current)]
      .concat(kind('limit').map(l => opt(l.id, l.name + ' (limit)', current === l.id)))
      .concat(kind('goal').filter(g => g.accountId === accountId).map(g => opt(g.id, g.name + ' (savings)', current === g.id)))
      .concat([opt('_none', 'Not spending (transfer or payment)', current === '_none')]).join('');
  }
  function moveFields(g) {
    const others = kind('goal').filter(x => x.accountId === g.accountId && x.id !== g.id);
    if (!others.length) return '';
    return field('Move money out', `<input id="ff_move" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00">`, `${esc(g.name)} has ${fmt(Math.max(0, catLeft(g)))}. Leave blank to move nothing.`)
      + field('Move it to', `<select id="ff_to">${others.map(x => opt(x.id, `${x.name} (${fmt(catLeft(x))})`, false)).join('')}</select>`);
  }

  const forms = {
    charge(id) {
      const t = id ? S.txns.find(x => x.id === id) : null;
      const dir = t ? (isOut(t) ? 'out' : 'in') : 'out';
      const accounts = sorted(S.accounts);
      const accountId = t ? t.accountId : (accounts[0] || {}).id;
      return {
        title: t ? 'Edit entry' : 'Add a charge', del: !!t,
        body: `<div class="seg-ctl" role="radiogroup" aria-label="Kind">
            <label><input type="radio" name="ff_dir" id="ff_dir_out" value="out"${dir === 'out' ? ' checked' : ''}><span>Charge</span></label>
            <label><input type="radio" name="ff_dir" id="ff_dir_in" value="in"${dir === 'in' ? ' checked' : ''}><span>Deposit</span></label>
          </div>`
          + field('Amount', `<input id="ff_amount" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${t ? plain(t.amount) : ''}">`)
          + field('What was it', `<input id="ff_merchant" autocomplete="off" maxlength="80" placeholder="Shell, Kroger, paycheck" value="${t ? esc(t.merchant) : ''}">`)
          + field('Account', `<select id="ff_account">${accounts.map(a => opt(a.id, acctLabel(a), a.id === accountId)).join('')}</select>`)
          + field('When', `<input id="ff_when" type="datetime-local" value="${localInput(t ? t.at : Date.now())}">`, 'An entry dated before the account balance was last set does not change that balance.')
          + `<div id="ff_bucket_wrap"${dir === 'in' ? ' hidden' : ''}>${field('Where it goes', `<select id="ff_bucket">${bucketOptions(accountId, t ? t.bucketId : null)}</select>`)}</div>`,
      };
    },
    account(id, extra) {
      const a = id ? acct(id) : null;
      const type = a ? a.type : (extra.type || 'checking');
      return {
        title: a ? a.name : 'Add account', del: !!a,
        body: field('Name', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="Checking" value="${a ? esc(a.name) : ''}">`)
          + field('Type', `<select id="ff_type">${opt('checking', 'Checking', type === 'checking')}${opt('savings', 'Savings', type === 'savings')}${opt('credit', 'Credit card', type === 'credit')}</select>`)
          + field('Card or account ending', `<input id="ff_last4" inputmode="numeric" autocomplete="off" placeholder="1234" value="${a ? esc((a.last4 || []).join(', ')) : ''}">`, 'Last 4 digits. Two cards on one account: separate with a comma.')
          + field('Balance right now', `<input id="ff_balance" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${a ? plain(acctBalance(a)) : ''}">`, 'Copy it from Regions. For a credit card, enter what you owe.'),
      };
    },
    goal(id, extra) {
      const g = id ? bucket(id) : null;
      const accts = savingsAccounts();
      const a = acct(g ? g.accountId : extra.account) || accts[0];
      const free = a ? Math.max(0, unsorted(a)) : 0;
      return {
        title: g ? g.name : 'New category', del: !!g,
        body: field('Saving for', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="Motorcycle" value="${g ? esc(g.name) : ''}">`)
          + (accts.length > 1 && !g ? field('Held in', `<select id="ff_account">${accts.map(x => opt(x.id, x.name, a && x.id === a.id)).join('')}</select>`) : `<input type="hidden" id="ff_account" value="${a ? esc(a.id) : ''}">`)
          + field('Target', `<input id="ff_target" class="amount" inputmode="decimal" autocomplete="off" placeholder="Optional" value="${g && g.target ? plain(g.target) : ''}">`)
          + (g ? moveFields(g) : field('Put in now', `<input id="ff_start" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${free ? plain(free) : ''}">`, free ? `${fmt(free)} is waiting to be sorted.` : 'Nothing is waiting to be sorted, so this starts at $0.00. Edit another category to move money over from it.')),
      };
    },
    allocate(id) {
      const a = acct(id), u = unsorted(a), cats = catsOf(a);
      return {
        title: u > 0 ? `Sort ${fmt(u)}` : `Cover ${fmt(-u)}`, del: false,
        body: cats.map(g => `<div class="alloc">
              <label class="who" for="ff_alloc_${esc(g.id)}"><b><i class="dot" style="opacity:${shadeOf(g)}"></i>${esc(g.name)}</b><small>${fmt(catLeft(g))}</small></label>
              <input id="ff_alloc_${esc(g.id)}" data-alloc="${esc(g.id)}" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="${u > 0 ? 'Add to' : 'Take from'} ${esc(g.name)}">
              <button type="button" class="btn" data-rest="${esc(g.id)}">Rest</button>
            </div>`).join('')
          + `<div class="leftline"><span class="lab">${u > 0 ? 'Left to sort' : 'Left to cover'}</span><span class="fig md" id="ff_left">${fmt(Math.abs(u))}</span></div>`,
      };
    },
    limit(id) {
      const l = id ? bucket(id) : null;
      return {
        title: l ? l.name : 'New limit', del: !!l,
        body: field('Spending on', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="Gas" value="${l ? esc(l.name) : ''}">`)
          + field('Limit each month', `<input id="ff_monthly" class="amount" inputmode="decimal" autocomplete="off" placeholder="200.00" value="${l ? plain(l.monthly) : ''}">`),
      };
    },
  };

  // the sheet lives in its own dialog so it never collides with the task sheet
  document.body.insertAdjacentHTML('beforeend', `<dialog id="finSheet" aria-labelledby="finTitle">
    <form id="finForm" novalidate>
      <div class="sheet-head" id="finHead"><div class="grab"></div><div class="bar"><h2 id="finTitle"></h2><button type="button" class="circle" id="finClose" aria-label="Close"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></div></div>
      <div id="finBody" class="sheet-body"></div>
      <p id="finErr" class="err" hidden></p>
      <div class="sheet-foot"><button type="button" id="finDel" class="btn danger" hidden>Delete</button><button type="submit" id="finSave" class="btn solid">Save</button></div>
    </form>
  </dialog>`);
  const sheet = $('#finSheet');
  function openForm(kindName, id, extra = {}) {
    if (!canSave() || !forms[kindName]) return;
    const spec = forms[kindName](id || null, extra);
    F = { kind: kindName, id: id || null, extra, armed: false };
    $('#finTitle').textContent = spec.title;
    $('#finBody').innerHTML = spec.body;
    $('#finErr').hidden = true;
    const del = $('#finDel');
    del.hidden = !spec.del; del.textContent = 'Delete'; del.classList.remove('armed'); del.disabled = false;
    $('#finSave').disabled = false;
    if (ctx.setDrawer) ctx.setDrawer(false);
    sheet.style.transform = '';
    if (!sheet.open) sheet.showModal();
  }
  function closeForm() { if (sheet.open) sheet.close(); F = null; }
  function fail(msg) { const e = $('#finErr'); e.textContent = msg; e.hidden = false; return false; }

  // Reads the allocate form. Returns { rows:[{g, amount}], sum } or null when a field is not an amount.
  function readAlloc() {
    const rows = [];
    let sum = 0;
    for (const input of document.querySelectorAll('#finBody [data-alloc]')) {
      const text = input.value.trim();
      const amount = text ? parseMoney(text) : 0;
      if (amount === null) return null;
      rows.push({ g: bucket(input.dataset.alloc), amount, input });
      sum += amount;
    }
    return { rows, sum };
  }
  function refreshAlloc() {
    if (!F || F.kind !== 'allocate') return;
    const a = acct(F.id), r = readAlloc(), el = $('#ff_left');
    if (!a || !el) return;
    const left = Math.abs(unsorted(a)) - (r ? r.sum : 0);
    el.textContent = r ? (left < 0 ? fmt(-left) + ' too much' : fmt(left)) : 'Check the amounts';
    el.style.color = !r || left < 0 ? 'var(--bad)' : '';
  }

  const submit = {
    async charge() {
      const amount = parseMoney(val('ff_amount'));
      if (!amount) return fail('Enter an amount, like 25 or 25.00.');
      const accountId = val('ff_account');
      if (!acct(accountId)) return fail('Pick an account.');
      const at = new Date(val('ff_when')).getTime();
      if (!Number.isFinite(at)) return fail('Pick a date and time.');
      const dir = $('#ff_dir_in').checked ? 'in' : 'out';
      const data = { amount, merchant: val('ff_merchant').trim() || (dir === 'in' ? 'Deposit' : 'Charge'), accountId, at, dir, bucketId: dir === 'out' ? (val('ff_bucket') || null) : null, example: false };
      return F.id ? save(refs.txns.doc(F.id).update(data)) : save(refs.txns.doc().set({ ...data, source: 'manual', createdAt: Date.now() }));
    },
    async account() {
      const name = val('ff_name').trim();
      if (!name) return fail('Give the account a name.');
      const tokens = val('ff_last4').split(/[,\s]+/).filter(Boolean);
      if (tokens.some(x => !/^\d{4}$/.test(x))) return fail('Use the last 4 digits. Separate two cards with a comma.');
      const balance = parseMoney(val('ff_balance'), true);
      if (balance === null) return fail('Enter the balance, like 1250.00.');
      const type = val('ff_type');
      if (!F.id) return save(refs.accounts.doc().set({ name, type, last4: tokens, balance, balanceAt: Date.now(), createdAt: Date.now(), example: false }));
      const a = acct(F.id), patch = { name, type, last4: tokens, example: false };
      if (balance !== acctBalance(a) || type !== a.type) { patch.balance = balance; patch.balanceAt = Date.now(); }
      return save(refs.accounts.doc(F.id).update(patch));
    },
    async goal() {
      const name = val('ff_name').trim();
      if (!name) return fail('Say what you are saving for.');
      const targetText = val('ff_target').trim();
      const target = targetText ? parseMoney(targetText) : null;
      if (targetText && !target) return fail('Enter the target as an amount, or leave it blank.');
      if (F.id) {
        const g = bucket(F.id);
        if (!g) return fail('That category no longer exists.');
        const moveText = val('ff_move').trim();
        let moved = 0;
        if (moveText) {
          moved = parseMoney(moveText);
          if (!moved) return fail('Enter the amount to move, like 20 or 20.00, or leave it blank.');
          const left = Math.max(0, catLeft(g)), to = bucket(val('ff_to'));
          if (moved > left) return fail(`${g.name} only has ${fmt(left)}.`);
          if (!to) return fail('Pick the category to move it to.');
          if (!(await save(refs.buckets.doc(to.id).update({ saved: (to.saved || 0) + moved, example: false })))) return false;
        }
        const patch = { name, target, example: false };
        if (moved) patch.saved = (g.saved || 0) - moved;
        return save(refs.buckets.doc(F.id).update(patch));
      }
      const a = acct(val('ff_account'));
      if (!a) return fail('Add a savings account first.');
      const startText = val('ff_start').trim();
      const start = startText ? parseMoney(startText) : 0;
      if (start === null) return fail('Enter the amount to put in, or leave it blank.');
      const free = Math.max(0, unsorted(a));
      if (start > free) return fail(`Only ${fmt(free)} is waiting to be sorted in ${a.name}.`);
      const used = new Set(catsOf(a).map(slotOf));
      let slot = 0;
      while (used.has(slot) && slot < 8) slot++;
      return save(refs.buckets.doc().set({ kind: 'goal', name, accountId: a.id, target, saved: start, slot, createdAt: Date.now(), example: false }));
    },
    async allocate() {
      const a = acct(F.id);
      if (!a) return fail('That account no longer exists.');
      const u = unsorted(a), r = readAlloc();
      if (!r) return fail('Enter each amount like 20 or 20.00, or leave it blank.');
      if (!r.sum) return fail('Enter an amount for at least one category.');
      if (r.sum > Math.abs(u)) return fail(`That is ${fmt(r.sum - Math.abs(u))} more than there is to ${u > 0 ? 'sort' : 'cover'}.`);
      if (u < 0) for (const row of r.rows) if (row.amount > Math.max(0, catLeft(row.g))) return fail(`${row.g.name} only has ${fmt(Math.max(0, catLeft(row.g)))}.`);
      for (const row of r.rows) {
        if (!row.amount) continue;
        if (!(await save(refs.buckets.doc(row.g.id).update({ saved: (row.g.saved || 0) + (u > 0 ? row.amount : -row.amount), example: false })))) return false;
      }
      return true;
    },
    async limit() {
      const name = val('ff_name').trim();
      if (!name) return fail('Say what the limit is for.');
      const monthly = parseMoney(val('ff_monthly'));
      if (!monthly) return fail('Enter the monthly limit, like 200.');
      return F.id ? save(refs.buckets.doc(F.id).update({ name, monthly, example: false }))
        : save(refs.buckets.doc().set({ kind: 'limit', name, monthly, createdAt: Date.now(), example: false }));
    },
  };

  async function removeCurrent() {
    const { kind: k, id } = F;
    if (k === 'charge') return save(refs.txns.doc(id).delete());
    if (k === 'goal' || k === 'limit') return save(refs.buckets.doc(id).delete());
    if (k === 'account') {
      for (const t of S.txns.filter(x => x.accountId === id)) if (!(await save(refs.txns.doc(t.id).delete()))) return false;
      for (const g of S.buckets.filter(x => x.accountId === id)) if (!(await save(refs.buckets.doc(g.id).delete()))) return false;
      return save(refs.accounts.doc(id).delete());
    }
    return false;
  }

  /* ---------- sheet events ---------- */
  $('#finClose').addEventListener('click', closeForm);
  sheet.addEventListener('close', () => { F = null; });
  $('#finBody').addEventListener('change', e => {
    if (e.target.name === 'ff_dir') { const w = $('#ff_bucket_wrap'); if (w) w.hidden = $('#ff_dir_in').checked; }
    if (e.target.id === 'ff_account' && $('#ff_bucket')) $('#ff_bucket').innerHTML = bucketOptions(e.target.value, null);
  });
  $('#finBody').addEventListener('input', refreshAlloc);
  $('#finBody').addEventListener('click', e => {
    const b = e.target.closest('[data-rest]');
    if (!b || !F || F.kind !== 'allocate') return;
    const a = acct(F.id), input = document.querySelector(`#finBody [data-alloc="${CSS.escape(b.dataset.rest)}"]`);
    if (!a || !input) return;
    input.value = '';
    const r = readAlloc();
    let rest = Math.abs(unsorted(a)) - (r ? r.sum : 0);
    if (unsorted(a) < 0) rest = Math.min(rest, Math.max(0, catLeft(bucket(b.dataset.rest))));
    input.value = rest > 0 ? plain(rest) : '';
    refreshAlloc();
  });
  $('#finDel').addEventListener('click', async e => {
    if (!F) return;
    const b = e.currentTarget;
    if (!F.armed) {
      F.armed = true; b.classList.add('armed');
      b.textContent = F.kind === 'account' ? 'Delete account and its entries' : 'Tap again to delete';
      return;
    }
    b.disabled = true;
    const ok = await removeCurrent();
    b.disabled = false;
    if (ok) closeForm();
  });
  $('#finForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!F) return;
    $('#finErr').hidden = true;
    const btn = $('#finSave');
    btn.disabled = true;
    const ok = await submit[F.kind]();
    btn.disabled = false;
    if (ok) closeForm();
  });
  // pull the sheet down by its top edge to dismiss
  let pull = null;
  sheet.addEventListener('touchstart', e => {
    pull = null;
    if (e.touches.length !== 1 || !e.target.closest('#finHead') || e.target.closest('button')) return;
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

  // chart scrubbing: date and balance under the finger
  let tipTimer = null;
  function hideTips() { for (const el of document.querySelectorAll('.fin .chart .tip, .fin .chart .xh')) el.hidden = true; }
  function scrub(e) {
    const c = e.target.closest && e.target.closest('.fin .chart');
    if (!c) { if (e.type === 'pointermove') hideTips(); return; }
    const s = charts.get(c.dataset.chart);
    if (!s) return;
    const r = c.getBoundingClientRect();
    const f = clamp((e.clientX - r.left) / r.width, 0, 1), t = s.t0 + f * (s.t1 - s.t0);
    let v = s.pts[0].v;
    for (const p of s.pts) if (p.t <= t) v = p.v;
    const tip = $('.tip', c), xh = $('.xh', c);
    tip.textContent = `${shortDay.format(t)} · ${fmt(v)}`;
    tip.style.left = clamp(f * 100, 22, 78) + '%';
    xh.style.left = (f * 100) + '%';
    tip.hidden = false; xh.hidden = false;
    clearTimeout(tipTimer);
  }
  document.addEventListener('pointerdown', scrub);
  document.addEventListener('pointermove', scrub);
  document.addEventListener('pointerup', () => { clearTimeout(tipTimer); tipTimer = setTimeout(hideTips, 1500); });
  document.addEventListener('pointercancel', hideTips);

  /* ---------- taps routed here by POS (data-act="fin-…") ---------- */
  function act(name, b) {
    if (name === 'fin-sub') {
      if (!SUBS[b.dataset.sub]) return;
      S.sub = b.dataset.sub;
      try { localStorage.setItem('pos.fin.sub', S.sub); } catch (e) {}
      const sc = $('#finScroll'); if (sc) sc.scrollTop = 0;
      rerender();
      const sc2 = $('#finScroll'); if (sc2) sc2.scrollTop = 0;
      return;
    }
    if (!canSave()) return;
    if (name === 'fin-sort') sortTxn(b.dataset.txn, b.dataset.bucket);
    else if (name === 'fin-form') openForm(b.dataset.form, b.dataset.id, { account: b.dataset.account, type: b.dataset.type });
    else if (name === 'fin-toggle') { S.open.has(b.dataset.id) ? S.open.delete(b.dataset.id) : S.open.add(b.dataset.id); rerender(); }
    else if (name === 'fin-clear-ask') { S.confirmClear = true; rerender(); }
    else if (name === 'fin-clear-no') { S.confirmClear = false; rerender(); }
    else if (name === 'fin-clear-yes') { S.confirmClear = false; rerender(); clearExamples(); }
  }
  // the + button while Finance is showing: add a charge, or the first account when there is none
  function add() { openForm(S.accounts.length ? 'charge' : 'account', null, {}); }
  const sheetOpen = () => sheet.open;

  return { view, act, add, badge, start, stop, sheetOpen };
};
