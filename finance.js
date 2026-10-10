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
    check: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 12.5l3.6 3.6 7.4-8"/></svg>',
    warn: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.2 20.8 19.3H3.2z"/><path d="M12 10v4.2M12 16.8v.2"/></svg>',
    clock: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.3l2.8 1.7"/></svg>',
    chev: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 6.5 15 12l-5.5 5.5"/></svg>',
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

  const SUBS = { home: 'Overview', bills: 'Bills', loans: 'Loans', savings: 'Savings', spending: 'Spending', activity: 'Activity' };
  const S = { loaded: false, failed: false, accounts: [], buckets: [], txns: [], bills: [], loans: [], sub: 'home', open: new Set(), confirmClear: false };
  try { const t = localStorage.getItem('pos.fin.sub'); if (SUBS[t]) S.sub = t; } catch (e) {}
  let F = null; // the form currently in the sheet
  const charts = new Map();

  /* ---------- storage: same calls the ledger always made, now on Supabase ---------- */
  const KINDS = ['accounts', 'buckets', 'txns', 'bills', 'loans'];
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
    const [{ data, error }, mail] = await Promise.all([
      sb.from('fin_docs').select('id,kind,data').limit(20000),
      sb.from('bank_mail').select('received_at,status').ilike('sender', '%regions.com%').order('received_at', { ascending: false }).limit(1),
    ]);
    S.mail = mail && !mail.error && mail.data && mail.data[0] ? { at: Date.parse(mail.data[0].received_at) } : null;
    if (error) { S.failed = true; rerender(); return; }
    S.failed = false; S.loaded = true;
    for (const k of KINDS) S[k] = [];
    for (const r of data) if (S[r.kind]) S[r.kind].push({ ...r.data, id: r.id });
    rerender();
    if (S.bills.length) await autoPay();
    autoSort();
  }
  function start() {
    load();
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('pos-finance').on('postgres_changes', { event: '*', schema: 'public', table: 'fin_docs' }, scheduleLoad)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bank_mail' }, scheduleLoad).subscribe();
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

  /* ---------- bills and subscriptions: a day of the month, an amount, an account, and whether this month's went through ---------- */
  const pad2 = n => String(n).padStart(2, '0');
  const monthKeyOf = (y, m) => { const d = new Date(y, m, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
  const ordinal = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  const startOfDay = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const billById = id => S.bills.find(b => b.id === id);
  const groupOf = b => (b.group === 'sub' ? 'sub' : 'bill');
  const byDay = (a, b) => (a.day || 99) - (b.day || 99) || byCreated(a, b);
  const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const fmtShort = cents => (cents % 100 ? fmt(cents) : usd0.format(cents / 100));
  // the 31st falls on the last day of a shorter month
  function dueOn(b, y, m) {
    if (!b.day) return null;
    return new Date(y, m, Math.min(b.day, new Date(y, m + 1, 0).getDate())).getTime();
  }
  const paidIn = (b, mk) => (b.paid && b.paid[mk]) || null;
  // a month counts once the bill was in here by its day (one added on the 9th starts with next month's 7th)
  const appliesIn = (b, y, m) => { const d = dueOn(b, y, m); return d != null && d >= startOfDay(b.createdAt || 0); };
  const createdMonth = b => { const d = new Date(b.createdAt || 0); return monthKeyOf(d.getFullYear(), d.getMonth()); };
  // From its day, a bill is waiting on its charge; banks post a day or three late, so it only asks for a look after that.
  const GRACE = 3;
  const confirmedBy = p => !!(p && (p.txnId || p.confirmed));
  function billState(b, now = Date.now()) {
    const n = new Date(now), y = n.getFullYear(), m = n.getMonth(), today = startOfDay(now);
    const p = paidIn(b, monthKeyOf(y, m));
    if (p) return { st: 'paid', at: p.at || null, confirmed: confirmedBy(p) };
    if (!b.day) return { st: 'noday' };
    if (!appliesIn(b, y, m)) return { st: 'next', due: dueOn(b, y, m + 1) };
    const due = dueOn(b, y, m), days = Math.round((due - today) / DAY);
    if (days <= 0 && days >= -GRACE) return { st: 'waiting', due, days: -days };
    if (days < 0) return { st: 'late', due, days: -days };
    return { st: 'soon', due, days };
  }
  // what needs a look: no charge seen a few days after its day
  const billAlerts = () => S.bills.map(b => ({ b, s: billState(b) })).filter(x => x.s.st === 'late').sort((x, y) => x.s.due - y.s.due);
  function statusPill(s) {
    if (s.st === 'paid') return `<span class="pill ok">${ICON.check}${s.confirmed ? 'Charge confirmed' : 'Marked paid'}${s.at ? ' ' + esc(shortDay.format(s.at)) : ''}</span>`;
    if (s.st === 'waiting') return `<span class="pill wait">${ICON.clock}Waiting on charge</span>`;
    if (s.st === 'late') return `<span class="pill late">${ICON.warn}No charge seen</span>`;
    if (s.st === 'noday') return '<span class="pill">Set a day</span>';
    if (s.st === 'soon' && s.days === 1) return '<span class="pill">Tomorrow</span>';
    if (s.st === 'soon' && s.days < 7) return `<span class="pill">In ${s.days} days</span>`;
    return `<span class="pill">${esc(shortDay.format(s.due))}</span>`;
  }
  // which month's charge a payment belongs to: the due date nearest to it
  function nearestMonth(b, at) {
    const d = new Date(at);
    let best = null;
    for (const off of [-1, 0, 1]) {
      const due = dueOn(b, d.getFullYear(), d.getMonth() + off);
      if (due == null) continue;
      if (!best || Math.abs(due - at) < Math.abs(best.due - at)) best = { due, mk: monthKeyOf(d.getFullYear(), d.getMonth() + off) };
    }
    return best ? best.mk : monthKeyOf(d.getFullYear(), d.getMonth());
  }
  // A charge checks a bill off when its name (or a word you gave it) shows in the charge, at about the amount,
  // a few days either side of the day. A bill of $20 or more also matches on the exact amount alone.
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const namedIn = (b, t) => {
    const m = ' ' + norm(t.merchant) + ' ', squashed = m.replace(/ /g, '');
    return [b.name, ...String(b.match || '').split(',')].map(norm).filter(x => x.length >= 3)
      .some(x => m.includes(' ' + x + ' ') || squashed.includes(x.replace(/ /g, '')));
  };
  const sameAcct = (b, t) => !b.accountId || !t.accountId || b.accountId === t.accountId;
  // named: about the price (prices drift, taxes get added), from any account. Unnamed: the exact price, from its account.
  function billMatches(b, t) {
    const named = namedIn(b, t);
    if (!b.amount) return named;
    const diff = Math.abs(t.amount - b.amount);
    return (named && diff <= Math.max(200, Math.round(b.amount * 0.35))) || (diff <= 1 && b.amount >= 2000 && sameAcct(b, t));
  }
  function matchMonth(b, t) {
    if (!b.day) return null;
    const d = new Date(t.at);
    for (const off of [0, -1, 1]) {
      const due = dueOn(b, d.getFullYear(), d.getMonth() + off), mk = monthKeyOf(d.getFullYear(), d.getMonth() + off);
      if (paidIn(b, mk) || t.at < due - 3 * DAY || t.at > due + 8 * DAY) continue;
      if (billMatches(b, t)) return mk;
    }
    return null;
  }
  // unpaid bills a charge could be (its name shows, or about its price), nearest first: offered when you approve it
  function billsNear(t) {
    const priced = b => b.amount && sameAcct(b, t) && Math.abs(t.amount - b.amount) <= Math.max(100, Math.round(b.amount * 0.05));
    return S.bills.filter(b => b.day && (namedIn(b, t) || priced(b)))
      .map(b => ({ b, mk: nearestMonth(b, t.at), named: namedIn(b, t) }))
      .map(x => ({ ...x, due: dueOn(x.b, +x.mk.slice(0, 4), +x.mk.slice(5) - 1) }))
      .filter(x => !paidIn(x.b, x.mk) && (x.named ? Math.abs(x.due - t.at) <= 10 * DAY : t.at >= x.due - 2 * DAY && t.at <= x.due + 4 * DAY))
      .sort((x, y) => Math.abs(x.due - t.at) - Math.abs(y.due - t.at)).map(x => x.b);
  }

  function acctLabel(a) {
    if (!a) return 'Removed account';
    const l4 = (a.last4 || [])[0];
    return a.name + (l4 ? ' ••' + l4 : '');
  }
  function bucketLabel(t) {
    if (!t.bucketId) return null;
    if (t.bucketId === '_none') return 'Not spending';
    if (String(t.bucketId).startsWith('bill:')) { const bl = billById(t.bucketId.slice(5)); return bl ? bl.name : 'Removed bill'; }
    const b = bucket(t.bucketId);
    return b ? b.name : 'Removed category';
  }
  const exTag = d => d && d.example ? '<span class="tag">Example</span>' : '';
  const when = ms => dayFmt.format(ms) + ' · ' + timeFmt.format(ms);

  /* ---------- loans: what's left, when it's done, and what a little extra each month saves ---------- */
  const loanById = id => S.loans.find(l => l.id === id);
  const monYr = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
  // the payments since you last set the balance: each month its bill was paid counts as one payment
  function loanPayments(l) {
    const b = l.billId ? billById(l.billId) : null;
    if (!b || !b.paid || !l.payment) return [];
    return Object.values(b.paid).map(p => p && p.at).filter(at => at && at > (l.balanceAt || 0)).sort((x, y) => x - y);
  }
  // today's balance: what you set, less the principal in each payment since (interest is taken monthly at the APR)
  function loanNow(l) {
    if (l.balance == null) return null;
    let bal = l.balance;
    const r = (l.apr || 0) / 1200;
    for (const at of loanPayments(l)) { const i = Math.round(bal * r); bal = Math.max(0, bal - Math.max(0, l.payment - i)); }
    return bal;
  }
  // month by month from here: how many payments are left and the interest in them
  function payoff(l, extra = 0) {
    const start = loanNow(l);
    if (start == null || !l.payment) return null;
    const r = (l.apr || 0) / 1200, pay = l.payment + extra;
    let bal = start, months = 0, interest = 0;
    const pts = [bal];
    while (bal > 0 && months < 600) {
      const i = Math.round(bal * r);
      if (pay <= i) return { never: true, pts };
      interest += i; bal = Math.max(0, bal + i - pay); months++; pts.push(bal);
    }
    return { months, interest, pts };
  }
  // the next payment: its bill's day this month if that hasn't been paid yet, else next month's
  function nextPayment(l) {
    const b = l.billId ? billById(l.billId) : null, n = new Date();
    if (!b || !b.day) return new Date(n.getFullYear(), n.getMonth() + 1, n.getDate()).getTime();
    const s = billState(b);
    return s.st === 'paid' || s.st === 'next' ? dueOn(b, n.getFullYear(), n.getMonth() + 1) : dueOn(b, n.getFullYear(), n.getMonth());
  }
  const payoffDate = (l, months) => { const d = new Date(nextPayment(l)); return new Date(d.getFullYear(), d.getMonth() + Math.max(0, months - 1), d.getDate()).getTime(); };
  function loanChart(l, extra) {
    const base = payoff(l, 0), plan = extra ? payoff(l, extra) : null;
    if (!base || base.never) return '';
    const W = 300, H = 70, pad = 4, n = Math.max(base.pts.length - 1, 1), hi = base.pts[0] || 1;
    const path = pts => pts.map((v, i) => `${i ? 'L' : 'M'}${(i / n * W).toFixed(1)},${(pad + (1 - v / hi) * (H - 2 * pad)).toFixed(1)}`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="${plan ? 'ghost' : 'line'}" d="${path(base.pts)}" vector-effect="non-scaling-stroke"/>
        ${plan && !plan.never ? `<path class="line" d="${path(plan.pts)}" vector-effect="non-scaling-stroke"/>` : ''}
      </svg>
      <div class="axis"><span>${esc(monYr.format(nextPayment(l)))}</span><span>${esc(monYr.format(payoffDate(l, base.months)))}</span></div>`;
  }
  // "+$50 a month: paid off Aug 2028, 7 months sooner, $1,234 less interest"
  function extraText(l, extra) {
    const base = payoff(l, 0), plan = payoff(l, extra);
    if (!base || !plan) return '';
    if (base.never) return 'The payment doesn’t cover the interest, so this never gets paid off. Raise the payment.';
    if (!extra) return 'Slide to see what paying a little extra each month does.';
    const sooner = base.months - plan.months, saved = base.interest - plan.interest;
    return `<b>+${esc(usd0.format(extra / 100))} a month:</b> paid off ${esc(monYr.format(payoffDate(l, plan.months)))}${sooner > 0 ? `, ${sooner} ${sooner === 1 ? 'month' : 'months'} sooner` : ''}${saved > 0 ? `, ${esc(fmt(saved))} less interest` : ''}.`;
  }

  /* ---------- pieces ---------- */
  function chargeCard(t) {
    const billChips = billsNear(t).slice(0, 3).map(b =>
      `<button type="button" class="chip bill" data-act="fin-sort" data-txn="${esc(t.id)}" data-bucket="bill:${esc(b.id)}">${esc(b.name)}<span>${b.amount ? fmt(b.amount) + ' ' : ''}${groupOf(b) === 'sub' ? 'subscription' : 'bill'}</span></button>`);
    const chips = billChips.concat(kind('limit').map(l => {
      const left = (l.monthly || 0) - limitSpent(l);
      return `<button type="button" class="chip" data-act="fin-sort" data-txn="${esc(t.id)}" data-bucket="${esc(l.id)}">${esc(l.name)}<span>${!l.monthly ? fmt(limitSpent(l)) + ' this month' : left >= 0 ? fmt(left) + ' left' : fmt(-left) + ' over'}</span></button>`;
    })).concat(kind('goal').filter(g => g.accountId === t.accountId).map(g =>
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
    const due = billAlerts();
    if (due.length) left += `<section class="sec"><span class="lab">Bills</span><div class="stack">${due.map(billNote).join('')}</div></section>`;
    if (todo.length) left += `<section class="sec"><span class="lab">Needs approval · ${todo.length}</span><div class="stack">${todo.map(chargeCard).join('')}</div></section>`;
    const notes = savingsToSort().map(sortNote).join('');
    if (notes) left += `<section class="sec">${notes}</section>`;
    if (!left) left = '<section class="sec"><span class="lab">Needs approval</span><p class="empty">Nothing waiting. New charges show up here to be sorted.</p></section>';
    let right = '<section class="sec"><div class="sec-head"><span class="lab">Accounts</span>'
      + (canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="account" aria-label="Add account">${ICON.plus}</button>` : '') + '</div>';
    right += accounts.length ? `<div class="stack">${accounts.map(accountCard).join('')}</div>`
      : '<p class="empty">No accounts yet. Add checking, savings and your credit card with today’s balance from Regions.</p>';
    right += mailLine() + '</section>';
    return `${totals}<div class="fin-two"><div>${left}</div><div>${right}</div></div>${examplesBar()}`;
  }

  // whether the Regions alert emails are reaching POS
  function mailLine() {
    if (!S.mail) return '<p class="meta mail-line"><i class="mdot off"></i>Regions alerts: none received yet</p>';
    const mins = Math.round((Date.now() - S.mail.at) / 60000);
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} hr ago` : dayFmt.format(S.mail.at);
    return `<p class="meta mail-line"><i class="mdot"></i>Regions alerts connected · last one ${esc(ago)}</p>`;
  }
  // "Progressive, $357.66, was due Oct 4 and no charge has shown up."
  function billNote({ b, s }) {
    const what = `<b>${esc(b.name)}</b>${b.amount ? `, ${fmt(b.amount)},` : ''}`;
    return `<div class="float note bill-note ${s.st}"><p>${ICON.warn}<span>${what} was due ${esc(shortDay.format(s.due))} and no charge has shown up. If you paid it another way, check it off.</span></p>${canSave() ? `<button type="button" class="btn solid" data-act="fin-bill-paid" data-id="${esc(b.id)}">Paid</button>` : ''}</div>`;
  }

  // what a bill is made of, line by line, as on its last statement
  function billParts(b) {
    const parts = b.parts || [], key = 'parts-' + b.id, open = S.open.has(key), sum = parts.reduce((t, x) => t + (x.amount || 0), 0);
    return `<div class="b-parts${open ? ' open' : ''}">
      <button type="button" class="b-more" data-act="fin-toggle" data-id="${esc(key)}" aria-expanded="${open}"><span>What’s in the ${esc(fmt(sum))}</span>${ICON.chev}</button>
      ${open ? `<div class="bp-list">${parts.map(x => `<div class="bp"><span class="bp-l"><span>${esc(x.name)}</span>${x.note ? `<small>${esc(x.note)}</small>` : ''}</span><span class="bp-a${x.amount < 0 ? ' neg' : ''}">${x.amount < 0 ? '−' + esc(fmt(-x.amount)) : esc(fmt(x.amount))}</span></div>`).join('')}
        ${b.partsNote ? `<p class="meta bp-note">${esc(b.partsNote)}</p>` : ''}</div>` : ''}
    </div>`;
  }
  function billRow(b) {
    const s = billState(b), a = b.accountId ? acct(b.accountId) : null;
    const where = [b.day ? `The ${ordinal(b.day)}` : 'No day yet', b.accountId ? acctLabel(a) : 'No account yet'].join(' · ');
    const month = monthFmt.format(new Date());
    return `<div class="bill-row st-${s.st}">
      <button type="button" class="b-chk" data-act="fin-bill-paid" data-id="${esc(b.id)}" aria-pressed="${s.st === 'paid'}" aria-label="${s.st === 'paid' ? `${esc(b.name)} is checked off for ${month}. Undo` : `Check off ${esc(b.name)} for ${month}`}">${ICON.check}</button>
      <button type="button" class="b-main" data-act="fin-form" data-form="bill" data-id="${esc(b.id)}">
        <span class="b-l"><span class="name">${esc(b.name)}</span><span class="meta">${esc(where)}</span></span>
        <span class="b-r"><span class="fig md">${b.amount ? fmt(b.amount) : '<span class="b-none">Set amount</span>'}</span>${statusPill(s)}</span>
      </button>
    </div>${b.parts && b.parts.length ? billParts(b) : ''}`;
  }

  function vBills() {
    const now = new Date(), month = monthFmt.format(now);
    const list = g => S.bills.filter(b => groupOf(b) === g).sort(byDay);
    const per = l => l.reduce((t, b) => t + (b.amount || 0), 0);
    const bills = list('bill'), subs = list('sub');
    // still to go out this month: not checked off, and due this month
    const toGo = S.bills.filter(b => b.amount && ['waiting', 'late', 'soon'].includes(billState(b).st)).reduce((t, b) => t + b.amount, 0);
    const alerts = billAlerts();
    const sec = (g, label, l) => `<section class="sec"><div class="sec-head"><span class="lab">${label}${l.length ? ' · ' + fmt(per(l)) + ' a month' : ''}</span></div>
      <div class="float list">${l.map(billRow).join('')}${canSave() ? `<button type="button" class="add-row" data-act="fin-form" data-form="bill" data-group="${g}"><span>${g === 'sub' ? 'New subscription' : 'New bill'}</span>${ICON.plus}</button>` : ''}</div></section>`;
    return `<div class="totals">
        <div class="float"><span class="lab">Bills</span><span class="fig md">${fmt(per(bills))}</span></div>
        <div class="float"><span class="lab"><span class="l-long">Subscriptions</span><span class="l-short">Subs</span></span><span class="fig md">${fmt(per(subs))}</span></div>
        <div class="float"><span class="lab">Left in ${esc(month)}</span><span class="fig md">${fmt(toGo)}</span></div>
      </div>
      ${alerts.length ? `<section class="sec"><div class="stack">${alerts.map(billNote).join('')}</div></section>` : ''}
      <div class="fin-two"><div>${sec('bill', 'Bills', bills)}</div><div>${sec('sub', 'Subscriptions', subs)}</div></div>`;
  }

  function loanCard(l) {
    const bal = loanNow(l), b = l.billId ? billById(l.billId) : null, extra = l.extra || 0;
    const apr = l.apr == null ? '<span class="pill warn">APR not set</span>' : `<span class="pill${l.aprSure ? '' : ' warn'}">${esc(String(+l.apr))}% APR${l.aprSure ? '' : ' · confirm'}</span>`;
    const credit = l.credit || 0, net = l.payment ? Math.max(0, l.payment - credit) : null;
    const how = [l.payment ? (credit ? `${fmt(net)} a month after a ${fmt(credit)} credit (${fmt(l.payment)} before it)` : `${fmt(l.payment)} a month`) : null,
      b ? `paid with the ${b.name} bill${b.day ? ` on the ${ordinal(b.day)}` : ''}` : 'not tied to a bill'].filter(Boolean).join(' · ');
    const need = bal == null ? `Add today’s balance from ${esc(l.lender || 'the lender')} to see when it’s paid off.` : !l.payment ? `Add the monthly payment${b && b.name === 'Verizon' ? ' (the phone’s part of the Verizon bill)' : ''} to see when it’s paid off.` : '';
    const base = need ? null : payoff(l, 0);
    const since = loanPayments(l).length;
    return `<article class="float loan" data-loan="${esc(l.id)}">
      <div class="a-head">
        <div><span class="lab">${esc(l.name)}${l.lender ? ' · ' + esc(l.lender) : ''}</span><span class="fig lg">${bal == null ? '—' : fmt(bal)}</span>
          <span class="meta">${esc(how)}</span><span class="l-pills">${apr}${since ? `<span class="pill">${since} ${since === 1 ? 'payment' : 'payments'} taken off since ${esc(shortDay.format(l.balanceAt))}</span>` : ''}</span></div>
        ${canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="loan" data-id="${esc(l.id)}" aria-label="Edit ${esc(l.name)}">${ICON.edit}</button>` : ''}
      </div>
      ${need ? `<p class="loan-need">${need}</p>${canSave() ? `<div><button type="button" class="btn solid" data-act="fin-form" data-form="loan" data-id="${esc(l.id)}">Add it</button></div>` : ''}` : `
      <p class="loan-off">${base && !base.never ? `Paid off <b>${esc(monYr.format(payoffDate(l, base.months)))}</b> · ${base.months} ${base.months === 1 ? 'payment' : 'payments'} left${base.interest ? ` · about ${esc(fmt(base.interest))} interest to go` : ''}` : 'Not on track to be paid off at this payment.'}</p>
      <div class="loan-chart" data-lc>${loanChart(l, extra)}</div>
      ${credit && base && !base.never ? `<p class="loan-warn">${ICON.warn}<span>Don’t pay this off early. The ${esc(fmt(credit))} monthly credit stops if you do, so paying off the ${esc(fmt(bal))} now costs about <b>${esc(fmt(Math.max(0, bal - net * base.months)))}</b> more than finishing the ${base.months} payments (${esc(fmt(net * base.months))} out of pocket).</span></p>` : `
      <div class="lx">
        <label for="lx_${esc(l.id)}">Pay extra each month <b data-lx-val>+${esc(usd0.format(extra / 100))}</b></label>
        <input type="range" id="lx_${esc(l.id)}" min="0" max="${Math.max(500, Math.ceil(extra / 10000) * 100)}" step="10" value="${extra / 100}" data-loan-extra="${esc(l.id)}">
        <p class="meta" data-lx-res>${extraText(l, extra)}</p>
      </div>`}`}
    </article>`;
  }

  function vLoans() {
    const loans = S.loans.slice().sort(byCreated);
    const known = loans.filter(l => loanNow(l) != null);
    const owed = known.reduce((t, l) => t + loanNow(l), 0), monthly = loans.reduce((t, l) => t + Math.max(0, (l.payment || 0) - (l.credit || 0)), 0);
    const plans = loans.map(l => ({ l, p: payoff(l, l.extra || 0) }));
    const ready = plans.length && plans.every(x => x.p && !x.p.never);
    const free = ready ? Math.max(...plans.map(x => payoffDate(x.l, x.p.months))) : null;
    return `<div class="totals">
        <div class="float"><span class="lab">Owed on loans</span><span class="fig md">${known.length ? fmt(owed) : '—'}</span></div>
        <div class="float"><span class="lab">Each month</span><span class="fig md">${fmt(monthly)}</span></div>
        <div class="float"><span class="lab">Debt free</span><span class="fig md">${free ? esc(monYr.format(free)) : '—'}</span></div>
      </div>
      <section class="sec"><div class="sec-head"><span class="lab">Loans</span>${canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="loan" aria-label="Add a loan">${ICON.plus}</button>` : ''}</div>
        ${loans.length ? `<div class="loan-grid">${loans.map(loanCard).join('')}</div>` : '<p class="empty">No loans yet. Add one with today’s balance, its APR and the monthly payment.</p>'}
        <p class="meta loan-how">Each month its bill gets paid (a confirmed charge, or checked off), that payment comes off the balance, less the interest. Update the balance from the lender now and then to keep it exact.</p>
      </section>`;
  }

  function examplesBar() {
    const examples = [...S.accounts, ...S.buckets, ...S.txns].filter(d => d.example).length;
    if (!examples) return '';
    return `<div class="examples"><span>Example numbers are loaded.</span>${
      S.confirmClear
        ? `<button type="button" class="link" data-act="fin-clear-yes" style="color:var(--bad)">Delete ${examples} example ${examples === 1 ? 'item' : 'items'}</button><button type="button" class="link" data-act="fin-clear-no">Keep</button>`
        : '<button type="button" class="link" data-act="fin-clear-ask">Clear examples</button>'}</div>`;
  }

  // A category can be a list of things to buy: each item has its own price, and the list's total is the target.
  const isList = g => Array.isArray(g.items);
  const listTotal = g => (g.items || []).reduce((t, i) => t + (i.price || 0), 0);
  const goalTarget = g => (isList(g) ? listTotal(g) : g.target || 0);
  function listItems(g) {
    const items = g.items || [];
    const rows = items.map(i => `<div class="li${i.got ? ' got' : ''}">
        <button type="button" class="b-chk" data-act="fin-item-got" data-id="${esc(g.id)}" data-item="${esc(i.id)}" aria-pressed="${!!i.got}" aria-label="${i.got ? 'Not bought yet' : 'Bought'}: ${esc(i.name)}">${ICON.check}</button>
        <button type="button" class="li-main" data-act="fin-form" data-form="item" data-id="${esc(g.id)}" data-item="${esc(i.id)}"${canSave() ? '' : ' disabled'}>
          <span class="li-n">${esc(i.name)}</span>${i.price ? `<span class="fig li-p">${fmt(i.price)}</span>` : '<span class="li-none">Add price</span>'}
        </button></div>`).join('');
    return `<div class="li-list">${rows}${canSave() ? `<button type="button" class="add-row li-add" data-act="fin-form" data-form="item" data-id="${esc(g.id)}"><span>Add an item</span>${ICON.plus}</button>` : ''}</div>`;
  }
  function catRow(g) {
    const left = catLeft(g), target = goalTarget(g), list = isList(g);
    const pct = target ? clamp(left / target * 100, 0, 100) : null;
    const items = g.items || [], unpriced = items.filter(i => !i.price).length, toBuy = items.filter(i => !i.got).reduce((t, i) => t + (i.price || 0), 0);
    const open = list && S.open.has(g.id);
    const listMeta = list ? [`${items.length} ${items.length === 1 ? 'item' : 'items'}`, unpriced ? `${unpriced} need${unpriced === 1 ? 's' : ''} a price` : null,
      items.some(i => i.got) && toBuy ? `${fmt(toBuy)} still to buy` : null].filter(Boolean).join(' · ') : '';
    return `<div class="row${list ? ' is-list' : ''}"><div class="cat">
      <i class="dot" style="opacity:${shadeOf(g)}"></i>
      <span class="name">${esc(g.name)}${exTag(g)}${list ? ' <span class="pill">List</span>' : ''}</span>
      <span class="fig md"${left < 0 ? ' style="color:var(--bad)"' : ''}>${fmt(left)}</span>
      ${canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="goal" data-id="${esc(g.id)}" aria-label="Edit ${esc(g.name)}">${ICON.edit}</button>` : '<span></span>'}
      ${target ? `<div class="track"><span style="width:${pct.toFixed(2)}%"></span></div><span class="meta">${Math.round(pct)}% of ${fmt(target)}${list ? ' total' : ''}</span>` : ''}
      ${list ? `<div class="li-foot"><span class="meta">${esc(listMeta)}</span><button type="button" class="link" data-act="fin-toggle" data-id="${esc(g.id)}" aria-expanded="${open}">${open ? 'Hide items' : 'Show items'}</button></div>` : ''}
    </div>${open ? listItems(g) : ''}</div>`;
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

  // this month in a category: what's been spent, building day by day; with a limit, the even pace to it (dashed)
  function spendChart(l, charges) {
    const now = new Date(), y = now.getFullYear(), mo = now.getMonth(), dim = new Date(y, mo + 1, 0).getDate();
    const today = now.getDate(), byDay = new Array(dim + 1).fill(0);
    for (const t of charges) byDay[new Date(t.at).getDate()] += t.amount;
    const pts = [[0, 0]];
    let cum = 0;
    for (let d = 1; d <= today; d++) { if (byDay[d]) { pts.push([d - 1 + 0.5, cum]); cum += byDay[d]; pts.push([d - 1 + 0.5, cum]); } }
    pts.push([today, cum]);
    const top = Math.max(l.monthly || 0, cum, 1) * 1.08, W = 300, H = 56;
    const X = d => (d / dim * W).toFixed(1), Y = v => (H - 2 - v / top * (H - 6)).toFixed(1);
    const line = pts.map(([d, v], i) => `${i ? 'L' : 'M'}${X(d)},${Y(v)}`).join('');
    const area = `${line}L${X(today)},${H}L0,${H}Z`;
    const pace = l.monthly ? `<path class="pace" d="M0,${Y(0)}L${W},${Y(l.monthly)}" vector-effect="non-scaling-stroke"/><path class="cap" d="M0,${Y(l.monthly)}H${W}" vector-effect="non-scaling-stroke"/>` : '';
    return `<div class="s-chart" aria-hidden="true"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${pace}<path class="fill" d="${area}"/><path class="line" d="${line}" vector-effect="non-scaling-stroke"/></svg>
      <i class="s-dot" style="left:${(today / dim * 100).toFixed(2)}%;top:${(Number(Y(cum)) / H * 100).toFixed(2)}%"></i>
      <div class="axis"><span>${esc(shortDay.format(new Date(y, mo, 1)))}</span><span>${esc(shortDay.format(new Date(y, mo, dim)))}</span></div></div>`;
  }
  // where this month's spending went, category by category
  function spendSplit(limits) {
    const parts = limits.map(l => ({ l, v: limitSpent(l) })).filter(p => p.v > 0).sort((a, b) => b.v - a.v);
    const total = parts.reduce((t, p) => t + p.v, 0);
    if (!total) return `<div class="hero"><span class="fig xl">${fmt(0)}</span><span class="meta">Nothing spent in your categories yet this month.</span></div>`;
    const op = i => [1, .72, .5, .34, .24, .17, .12, .09][Math.min(i, 7)];
    return `<div class="hero"><div class="s-top"><span class="lab">Spent this month</span><span class="fig xl">${fmt(total)}</span></div>
      <div class="split" role="img" aria-label="${esc(parts.map(p => `${p.l.name} ${fmt(p.v)}`).join(', '))}">${parts.map((p, i) => `<span class="seg" style="width:${(p.v / total * 100).toFixed(2)}%;opacity:${op(i)}"></span>`).join('')}</div>
      <div class="s-legend">${parts.map((p, i) => `<span><i class="dot" style="opacity:${op(i)}"></i>${esc(p.l.name)} <b>${fmt(p.v)}</b> <small>${Math.round(p.v / total * 100)}%</small></span>`).join('')}</div></div>`;
  }
  function limitRow(l) {
    const charges = limitCharges(l);
    const spent = charges.reduce((s, t) => s + t.amount, 0);
    if (!l.monthly) {
      const open = S.open.has(l.id);
      return `<div class="row limit tracking">
        <div class="l-head"><div><span class="name">${esc(l.name)}${exTag(l)}</span><span class="meta">This month · no limit set</span></div><span class="fig lg">${fmt(spent)}</span></div>
        ${spendChart(l, charges)}
        <div class="l-foot">
          ${charges.length ? `<button type="button" class="link" data-act="fin-toggle" data-id="${esc(l.id)}" aria-expanded="${open}">${open ? 'Hide' : 'Show'} ${charges.length} ${charges.length === 1 ? 'charge' : 'charges'}</button>` : '<span>No charges this month</span>'}
          <button type="button" class="link" data-act="fin-form" data-form="limit" data-id="${esc(l.id)}">Edit</button>
        </div>
        ${open && charges.length ? `<div class="mini">${charges.map(t => `<div><span>${esc(t.merchant)} · ${esc(shortDay.format(t.at))}</span><span class="num">${fmt(t.amount)}</span></div>`).join('')}</div>` : ''}
      </div>`;
    }
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
      ${spendChart(l, charges)}
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
    return `<div class="fin-page">${spendSplit(limits)}<section class="sec"><span class="lab">${esc(monthFmt.format(now))} · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left</span>
      <div class="float list">${limits.map(limitRow).join('')}${canSave() ? `<button type="button" class="add-row" data-act="fin-form" data-form="limit"><span>New category</span>${ICON.plus}</button>` : ''}</div></section></div>`;
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

  const views = { home: vHome, bills: vBills, loans: vLoans, savings: vSavings, spending: vSpending, activity: vActivity };
  const counts = () => { const nSav = savingsToSort().length, nBills = billAlerts().length; return { home: inbox().length + nSav + nBills, savings: nSav, bills: nBills }; };

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
  const billIdOf = bucketId => (String(bucketId || '').startsWith('bill:') ? bucketId.slice(5) : null);
  // "QT 1140 Outside" -> "qt outside": the place, without store numbers, so every visit matches
  const merchantKey = m => String(m || '').toLowerCase().replace(/[^a-z' -]+/g, ' ').replace(/\s+/g, ' ').trim();
  const GENERIC = /^(charge|deposit|card or withdrawal|transfer (sent|received))$/;
  async function learnMerchant(bucketId, t) {
    const g = bucket(bucketId), key = merchantKey(t.merchant);
    if (!g || !key || GENERIC.test(key)) return;
    // one place belongs to one category: take it off any other
    for (const o of S.buckets.filter(x => x.id !== g.id && (x.merchants || []).includes(key))) await save(refs.buckets.doc(o.id).update({ merchants: o.merchants.filter(k => k !== key) }));
    if (!(g.merchants || []).includes(key)) await save(refs.buckets.doc(g.id).update({ merchants: [...(g.merchants || []), key] }));
  }
  let sortBusy = false;
  async function autoSort() {
    if (sortBusy || !canSave()) return;
    sortBusy = true;
    try {
      for (const t of inbox()) {
        const key = merchantKey(t.merchant), g = key && S.buckets.find(b => (b.merchants || []).includes(key));
        if (!g) continue;
        if (!(await save(refs.txns.doc(t.id).update({ bucketId: g.id })))) break;
        toast(`${t.merchant}, ${fmt(t.amount)}: sorted to ${g.name}`);
      }
    } finally { sortBusy = false; }
  }
  async function sortTxn(id, bucketId) {
    const t = S.txns.find(x => x.id === id);
    if (!t) return;
    const prev = t.bucketId || null, bid = billIdOf(bucketId);
    const name = bucketId === '_none' ? 'Not spending' : bid ? (billById(bid) || {}).name : (bucket(bucketId) || {}).name;
    if (!(await save(refs.txns.doc(id).update({ bucketId })))) return;
    if (!bid && bucketId !== '_none') learnMerchant(bucketId, t);
    const learned = bid ? await linkBill(bid, t, false) : null;
    toast(bid ? `${name}: charge confirmed${learned && learned.length ? `. Now ${learned.join(', ')}` : ''}` : 'Approved to ' + name, async () => {
      if (await save(refs.txns.doc(id).update({ bucketId: prev }))) { if (bid) await unlinkBill(bid, id); }
    });
  }
  // a payment checks off the month whose due date it's nearest to
  // and what the charge says becomes the bill's: its day, its price, its account. Returns what changed, or false.
  async function linkBill(billId, t, auto) {
    const b = billById(billId);
    if (!b) return false;
    const mk = nearestMonth(b, t.at), day = new Date(t.at).getDate(), learned = [];
    const patch = { paid: { ...(b.paid || {}), [mk]: { at: t.at, txnId: t.id, auto: !!auto } } };
    if (b.day !== day) { patch.day = day; learned.push(`the ${ordinal(day)}`); }
    if (t.amount && b.amount !== t.amount) { patch.amount = t.amount; learned.push(fmt(t.amount)); }
    if (t.accountId && acct(t.accountId) && b.accountId !== t.accountId) { patch.accountId = t.accountId; learned.push(acctLabel(acct(t.accountId))); }
    return (await save(refs.bills.doc(billId).update(patch))) ? learned : false;
  }
  async function unlinkBill(billId, txnId) {
    const b = billById(billId);
    if (!b || !b.paid) return true;
    const paid = { ...b.paid };
    let hit = false;
    for (const k of Object.keys(paid)) if (paid[k] && paid[k].txnId === txnId) { delete paid[k]; hit = true; }
    return hit ? save(refs.bills.doc(billId).update({ paid })) : true;
  }
  async function togglePaid(id) {
    const b = billById(id);
    if (!b) return;
    const now = new Date(), mk = monthKeyOf(now.getFullYear(), now.getMonth()), month = monthFmt.format(now);
    const before = { ...(b.paid || {}) }, paid = { ...before };
    const was = !!paid[mk];
    if (was) delete paid[mk]; else paid[mk] = { at: Date.now() };
    if (await save(refs.bills.doc(id).update({ paid })))
      toast(was ? `${b.name} is no longer checked off for ${month}` : `${b.name} checked off for ${month}`, () => save(refs.bills.doc(id).update({ paid: before })));
  }
  // Charges that arrive (by hand now, from the bank's alert emails later) check off the bill they match.
  // Only a single clear match counts; anything that could be two bills waits in Needs approval.
  let autoBusy = false;
  async function autoPay() {
    if (autoBusy || !canSave()) return;
    autoBusy = true;
    try {
      const floor = Date.now() - 45 * DAY;
      for (const t of S.txns.filter(x => isOut(x) && !x.bucketId && x.at >= floor)) {
        const hits = S.bills.filter(b => matchMonth(b, t));
        if (hits.length !== 1) continue;
        const b = hits[0];
        if (!(await save(refs.txns.doc(t.id).update({ bucketId: 'bill:' + b.id })))) break;
        const learned = await linkBill(b.id, t, true);
        toast(`${b.name}: charge confirmed, ${fmt(t.amount)}${learned && learned.length ? `. Now ${learned.join(', ')}` : ''}`);
      }
    } finally { autoBusy = false; }
  }
  // moving it on the calendar moves its day for every month
  async function moveBill(id, day) {
    const b = billById(id);
    if (!b || !canSave() || !day || b.day === day) return false;
    const prev = b.day || null;
    if (!(await save(refs.bills.doc(id).update({ day })))) return false;
    toast(`${b.name} is now due on the ${ordinal(day)} of every month`, () => save(refs.bills.doc(id).update({ day: prev })));
    return true;
  }
  // for the calendar: the bills due on a day, and how that month's stands
  function billsOn(k) {
    if (!S.loaded || !S.bills.length) return [];
    const [y, mo, dd] = k.split('-').map(Number), m = mo - 1, mk = monthKeyOf(y, m);
    const today = startOfDay(Date.now()), cur = new Date(today), isCur = y === cur.getFullYear() && m === cur.getMonth();
    const out = [];
    for (const b of S.bills.slice().sort(byDay)) {
      const due = dueOn(b, y, m);
      if (due == null || new Date(due).getDate() !== dd || mk < createdMonth(b)) continue;
      const p = paidIn(b, mk);
      let st = p ? 'paid' : '';
      if (!p && isCur && appliesIn(b, y, m) && due <= today) st = Math.round((today - due) / DAY) <= GRACE ? 'waiting' : 'late';
      out.push({ id: b.id, name: b.name, amount: b.amount || 0, short: b.amount ? fmtShort(b.amount) : '', group: groupOf(b), st });
    }
    return out;
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
      .concat(kind('limit').map(l => opt(l.id, l.name + ' (spending)', current === l.id)))
      .concat(kind('goal').filter(g => g.accountId === accountId).map(g => opt(g.id, g.name + ' (savings)', current === g.id)))
      .concat(S.bills.slice().sort(byDay).map(b => opt('bill:' + b.id, b.name + (groupOf(b) === 'sub' ? ' (subscription)' : ' (bill)'), current === 'bill:' + b.id)))
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
          + (g && isList(g) ? `<p class="where">The target is the list’s total, <b>${fmt(listTotal(g))}</b>, from its items’ prices.</p>`
            : field('Target', `<input id="ff_target" class="amount" inputmode="decimal" autocomplete="off" placeholder="Optional" value="${g && g.target ? plain(g.target) : ''}">`))
          + (g ? '' : `<label class="f-check"><input type="checkbox" id="ff_list"><span>A list of things to buy, each with its own price</span></label>`)
          + (g ? moveFields(g) : field('Put in now', `<input id="ff_start" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${free ? plain(free) : ''}">`, free ? `${fmt(free)} is waiting to be sorted.` : 'Nothing is waiting to be sorted, so this starts at $0.00. Edit another category to move money over from it.')),
      };
    },
    item(id, extra) {
      const g = bucket(id), i = g && extra.item ? (g.items || []).find(x => x.id === extra.item) : null;
      return {
        title: i ? i.name : `Add to ${g ? g.name : 'the list'}`, del: !!i,
        body: field('Item', `<input id="ff_name" autocomplete="off" maxlength="60" placeholder="Couch" value="${i ? esc(i.name) : ''}">`)
          + field('Price', `<input id="ff_price" class="amount" inputmode="decimal" autocomplete="off" placeholder="Add it later" value="${i && i.price ? plain(i.price) : ''}">`, 'Leave it blank until you know it; the list total adds it in then.')
          + (i ? `<label class="f-check"><input type="checkbox" id="ff_got"${i.got ? ' checked' : ''}><span>Bought</span></label>` : ''),
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
    bill(id, extra) {
      const b = id ? billById(id) : null;
      const group = b ? groupOf(b) : (extra.group === 'sub' ? 'sub' : 'bill');
      const now = new Date(), month = monthFmt.format(now), paidNow = b && paidIn(b, monthKeyOf(now.getFullYear(), now.getMonth()));
      const days = [opt('', 'Not set', !(b && b.day))].concat(Array.from({ length: 31 }, (_, i) => opt(String(i + 1), `The ${ordinal(i + 1)}`, !!b && b.day === i + 1))).join('');
      const accts = [opt('', 'Not set', !(b && b.accountId))].concat(sorted(S.accounts).map(a => opt(a.id, acctLabel(a), !!b && b.accountId === a.id))).join('');
      return {
        title: b ? b.name : group === 'sub' ? 'New subscription' : 'New bill', del: !!b,
        body: `<div class="seg-ctl" role="radiogroup" aria-label="Kind">
            <label><input type="radio" name="ff_group" id="ff_group_bill" value="bill"${group === 'bill' ? ' checked' : ''}><span>Bill</span></label>
            <label><input type="radio" name="ff_group" id="ff_group_sub" value="sub"${group === 'sub' ? ' checked' : ''}><span>Subscription</span></label>
          </div>`
          + field('Name', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="${group === 'sub' ? 'Spotify' : 'Rent'}" value="${b ? esc(b.name) : ''}">`)
          + field('Price', `<input id="ff_amount" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${b && b.amount ? plain(b.amount) : ''}">`)
          + field('Charged on', `<select id="ff_day">${days}</select>`, 'Just the day of the month. The 31st lands on the last day of shorter months.')
          + field('Comes out of', `<select id="ff_acct">${accts}</select>`)
          + field('Shows on the bank as', `<input id="ff_match" autocomplete="off" maxlength="120" placeholder="Optional" value="${b && b.match ? esc(b.match) : ''}">`, 'Words from the charge, separated by commas. The name is already looked for; these help check it off on its own.')
          + (b ? `<label class="f-check"><input type="checkbox" id="ff_paid"${paidNow ? ' checked' : ''}><span>Paid for ${esc(month)}</span></label>` : ''),
      };
    },
    loan(id) {
      const l = id ? loanById(id) : null;
      const bills = [opt('', 'None', !(l && l.billId))].concat(S.bills.slice().sort(byDay).map(b => opt(b.id, `${b.name}${b.day ? ' · the ' + ordinal(b.day) : ''}`, !!l && l.billId === b.id))).join('');
      const bal = l ? loanNow(l) : null;
      return {
        title: l ? l.name : 'New loan', del: !!l,
        body: field('Name', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="Car" value="${l ? esc(l.name) : ''}">`)
          + field('Lender', `<input id="ff_lender" autocomplete="off" maxlength="40" placeholder="Optional" value="${l && l.lender ? esc(l.lender) : ''}">`)
          + field('Balance right now', `<input id="ff_balance" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${bal != null ? plain(bal) : ''}">`, 'From the lender’s site or app. Payments after today come off it on their own.')
          + field('APR', `<input id="ff_apr" inputmode="decimal" autocomplete="off" placeholder="0" value="${l && l.apr != null ? esc(String(+l.apr)) : ''}">`, 'Percent a year. 0 for a no-interest phone plan.')
          + `<label class="f-check"><input type="checkbox" id="ff_aprsure"${!l || l.aprSure ? ' checked' : ''}><span>The APR is confirmed</span></label>`
          + field('Monthly payment', `<input id="ff_payment" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${l && l.payment ? plain(l.payment) : ''}">`, 'Only the loan’s part, if it shares a bill with other things.')
          + field('Credit back each month', `<input id="ff_credit" class="amount" inputmode="decimal" autocomplete="off" placeholder="Optional" value="${l && l.credit ? plain(l.credit) : ''}">`, 'A promo credit the lender takes off the bill each month, like Verizon’s device credit. What you really pay is the payment less this.')
          + field('Paid with which bill', `<select id="ff_bill">${bills}</select>`, 'Each month this bill gets paid counts as a payment.'),
      };
    },
    limit(id) {
      const l = id ? bucket(id) : null;
      return {
        title: l ? l.name : 'New spending category', del: !!l,
        body: field('Spending on', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="Gas" value="${l ? esc(l.name) : ''}">`)
          + field('Limit each month', `<input id="ff_monthly" class="amount" inputmode="decimal" autocomplete="off" placeholder="No limit" value="${l && l.monthly ? plain(l.monthly) : ''}">`, 'Leave it blank to just track what goes here.')
          + (l && (l.merchants || []).length ? `<p class="where">Charges from <b>${esc(l.merchants.join(', '))}</b> sort here on their own.</p>` : ''),
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
      const old = F.id ? S.txns.find(x => x.id === F.id) : null, was = old ? billIdOf(old.bucketId) : null, now = billIdOf(data.bucketId);
      const id = F.id || newId();
      if (!(await (F.id ? save(refs.txns.doc(id).update(data)) : save(refs.txns.doc(id).set({ ...data, source: 'manual', createdAt: Date.now() }))))) return false;
      if (was && was !== now) await unlinkBill(was, id);
      if (now) await linkBill(now, { ...data, id }, false);
      if (data.bucketId && !now && data.bucketId !== '_none' && (!old || old.bucketId !== data.bucketId)) learnMerchant(data.bucketId, data);
      return true;
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
      const targetText = $('#ff_target') ? val('ff_target').trim() : '';
      const target = targetText ? parseMoney(targetText) : null;
      if (targetText && !target) return fail('Enter the target as an amount, or leave it blank.');
      const asList = !!($('#ff_list') && $('#ff_list').checked);
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
        const patch = isList(g) ? { name, example: false } : { name, target, example: false };
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
      return save(refs.buckets.doc().set({ kind: 'goal', name, accountId: a.id, target: asList ? null : target, saved: start, slot, createdAt: Date.now(), example: false, ...(asList ? { items: [] } : {}) }));
    },
    async item() {
      const g = bucket(F.id);
      if (!g) return fail('That list no longer exists.');
      const name = val('ff_name').trim();
      if (!name) return fail('Name the item.');
      const priceText = val('ff_price').trim();
      const price = priceText ? parseMoney(priceText) : null;
      if (priceText && !price) return fail('Enter the price as an amount, like 249.99, or leave it blank.');
      const items = (g.items || []).slice();
      if (F.extra.item) {
        const k = items.findIndex(x => x.id === F.extra.item);
        if (k < 0) return fail('That item is no longer on the list.');
        items[k] = { ...items[k], name, price, got: !!($('#ff_got') && $('#ff_got').checked) };
      } else items.push({ id: newId(), name, price, got: false });
      S.open.add(g.id);
      return save(refs.buckets.doc(g.id).update({ items }));
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
    async bill() {
      const name = val('ff_name').trim();
      if (!name) return fail('Give it a name.');
      const amountText = val('ff_amount').trim();
      const amount = amountText ? parseMoney(amountText) : null;
      if (amountText && !amount) return fail('Enter the price, like 12.99, or leave it blank.');
      const day = parseInt(val('ff_day'), 10) || null;
      const accountId = val('ff_acct') || null;
      const group = $('#ff_group_sub').checked ? 'sub' : 'bill';
      const match = val('ff_match').trim().slice(0, 120);
      const data = { name, amount, day, accountId, group, match };
      if (!F.id) return save(refs.bills.doc().set({ ...data, paid: {}, createdAt: Date.now() }));
      const b = billById(F.id);
      if (!b) return fail('That one no longer exists.');
      const now = new Date(), mk = monthKeyOf(now.getFullYear(), now.getMonth()), box = $('#ff_paid');
      if (box && box.checked !== !!paidIn(b, mk)) {
        const paid = { ...(b.paid || {}) };
        if (box.checked) paid[mk] = { at: Date.now() }; else delete paid[mk];
        data.paid = paid;
      }
      return save(refs.bills.doc(F.id).update(data));
    },
    async loan() {
      const name = val('ff_name').trim();
      if (!name) return fail('Give the loan a name.');
      const balText = val('ff_balance').trim(), payText = val('ff_payment').trim(), aprText = val('ff_apr').trim().replace('%', '');
      const balance = balText ? parseMoney(balText) : null;
      if (balText && balance === null) return fail('Enter the balance, like 12450.00, or leave it blank.');
      const payment = payText ? parseMoney(payText) : null;
      if (payText && !payment) return fail('Enter the monthly payment, like 324.78, or leave it blank.');
      const apr = aprText ? Number(aprText) : null;
      if (aprText && !(apr >= 0 && apr < 100)) return fail('Enter the APR as a percent, like 14 or 6.9.');
      const creditText = val('ff_credit').trim(), credit = creditText ? parseMoney(creditText) : null;
      if (creditText && !credit) return fail('Enter the monthly credit, like 30.55, or leave it blank.');
      if (credit && payment && credit > payment) return fail('The credit can’t be more than the payment.');
      const data = { name, lender: val('ff_lender').trim() || null, apr, aprSure: $('#ff_aprsure').checked, payment, credit, billId: val('ff_bill') || null };
      if (!F.id) return save(refs.loans.doc().set({ ...data, balance, balanceAt: Date.now(), extra: 0, createdAt: Date.now() }));
      const l = loanById(F.id);
      if (!l) return fail('That loan no longer exists.');
      if (balance !== loanNow(l)) { data.balance = balance; data.balanceAt = Date.now(); }
      return save(refs.loans.doc(F.id).update(data));
    },
    async limit() {
      const name = val('ff_name').trim();
      if (!name) return fail('Say what the limit is for.');
      const monthlyText = val('ff_monthly').trim(), monthly = monthlyText ? parseMoney(monthlyText) : null;
      if (monthlyText && !monthly) return fail('Enter the monthly limit, like 200, or leave it blank.');
      return F.id ? save(refs.buckets.doc(F.id).update({ name, monthly, example: false }))
        : save(refs.buckets.doc().set({ kind: 'limit', name, monthly, createdAt: Date.now(), example: false }));
    },
  };

  async function removeCurrent() {
    const { kind: k, id } = F;
    if (k === 'charge') {
      const t = S.txns.find(x => x.id === id), bid = t ? billIdOf(t.bucketId) : null;
      if (!(await save(refs.txns.doc(id).delete()))) return false;
      if (bid) await unlinkBill(bid, id);
      return true;
    }
    if (k === 'bill') return save(refs.bills.doc(id).delete());
    if (k === 'loan') return save(refs.loans.doc(id).delete());
    if (k === 'item') { const g = bucket(id); return !!g && save(refs.buckets.doc(id).update({ items: (g.items || []).filter(x => x.id !== F.extra.item) })); }
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

  // the extra-payment slider on a loan: numbers and chart follow while dragging; saved when you let go
  document.addEventListener('input', e => {
    const r = e.target.closest && e.target.closest('[data-loan-extra]');
    if (!r) return;
    const l = loanById(r.dataset.loanExtra), card = r.closest('[data-loan]');
    if (!l || !card) return;
    const extra = Math.round(Number(r.value) * 100);
    card.querySelector('[data-lx-val]').textContent = '+' + usd0.format(extra / 100);
    card.querySelector('[data-lx-res]').innerHTML = extraText(l, extra);
    card.querySelector('[data-lc]').innerHTML = loanChart(l, extra);
  });
  document.addEventListener('change', e => {
    const r = e.target.closest && e.target.closest('[data-loan-extra]');
    if (!r || !canSave()) return;
    const l = loanById(r.dataset.loanExtra), extra = Math.round(Number(r.value) * 100);
    if (l && extra !== (l.extra || 0)) save(refs.loans.doc(l.id).update({ extra }));
  });

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
    else if (name === 'fin-form') openForm(b.dataset.form, b.dataset.id, { account: b.dataset.account, type: b.dataset.type, group: b.dataset.group, item: b.dataset.item });
    else if (name === 'fin-item-got') {
      const g = bucket(b.dataset.id);
      if (!g) return;
      const items = (g.items || []).map(x => (x.id === b.dataset.item ? { ...x, got: !x.got } : x));
      save(refs.buckets.doc(g.id).update({ items }));
    }
    else if (name === 'fin-bill-paid') togglePaid(b.dataset.id);
    else if (name === 'fin-toggle') { S.open.has(b.dataset.id) ? S.open.delete(b.dataset.id) : S.open.add(b.dataset.id); rerender(); }
    else if (name === 'fin-clear-ask') { S.confirmClear = true; rerender(); }
    else if (name === 'fin-clear-no') { S.confirmClear = false; rerender(); }
    else if (name === 'fin-clear-yes') { S.confirmClear = false; rerender(); clearExamples(); }
  }
  // the + button while Finance is showing: add a charge, or the first account when there is none
  function add() {
    if (S.sub === 'bills') openForm('bill', null, {});
    else if (S.sub === 'loans') openForm('loan', null, {});
    else openForm(S.accounts.length ? 'charge' : 'account', null, {});
  }
  const sheetOpen = () => sheet.open;

  return { view, act, add, badge, start, stop, sheetOpen, billsOn, moveBill };
};
