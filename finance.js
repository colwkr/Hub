// POS Finance: the Split Ledger, running inside the Personal Operating System.
// Accounts hold a balance set from the bank; savings accounts are split into goals; spending limits reset monthly;
// every charge waits in "Needs approval" until you sort it yourself: nothing is ever sorted for you (a place you've sorted
// before is only suggested first). Amounts are whole cents, times are epoch ms.
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
    back: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 6.5 9 12l5.5 5.5"/></svg>',
    up: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18.5v-13M6.5 11 12 5.5l5.5 5.5"/></svg>',
    down: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.5v13M6.5 13 12 18.5l5.5-5.5"/></svg>',
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

  const SUBS = { home: 'Overview', bills: 'Bills', loans: 'Loans', savings: 'Savings', lists: 'Lists', spending: 'Spending', activity: 'Activity' };
  const S = { loaded: false, failed: false, accounts: [], buckets: [], txns: [], bills: [], loans: [], income: [], months: [], worth: [], sub: 'home', open: new Set(), confirmClear: false, ovMk: null, spMk: null, day: null, nw: 'net' };
  try { const t = localStorage.getItem('pos.fin.sub'); if (SUBS[t]) S.sub = t; const w = localStorage.getItem('pos.fin.nw'); if (w) S.nw = w; } catch (e) {}
  let F = null; // the form currently in the sheet
  const charts = new Map();

  /* ---------- storage: same calls the ledger always made, now on Supabase ---------- */
  const KINDS = ['accounts', 'buckets', 'txns', 'bills', 'loans', 'income', 'months', 'worth'];
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
    const relabel = window.POSRelabel || (x => x);
    for (const r of data) if (S[r.kind]) S[r.kind].push({ ...r.data, ...(r.kind === 'txns' && r.data.merchant ? { merchant: relabel(r.data.merchant) } : {}), id: r.id });
    rerender();
    await autoIncome();
    dropStrayExamples();
    await saveMonths();
    saveWorth();
  }
  // once your real accounts and categories are in, example charges left behind only skew the numbers: they go
  let dropping = false;
  async function dropStrayExamples() {
    if (dropping || !canSave() || S.accounts.some(a => a.example) || S.buckets.some(b => b.example)) return;
    const stray = S.txns.filter(t => t.example);
    if (!stray.length) return;
    dropping = true;
    try { for (const t of stray) if (!(await save(refs.txns.doc(t.id).delete()))) break; } finally { dropping = false; }
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
  /* ---------- months: "2026-10" keys ---------- */
  // POS started keeping money by the month in October 2026
  const START = '2026-10';
  const curMk = () => { const d = new Date(); return monthKeyOf(d.getFullYear(), d.getMonth()); };
  const mkParts = mk => [+mk.slice(0, 4), +mk.slice(5, 7) - 1];
  const mkAdd = (mk, n) => { const [y, m] = mkParts(mk); return monthKeyOf(y, m + n); };
  const mkRange = mk => { const [y, m] = mkParts(mk); return [new Date(y, m, 1).getTime(), new Date(y, m + 1, 1).getTime()]; };
  const mkDate = mk => { const [y, m] = mkParts(mk); return new Date(y, m, 1); };
  const mkName = mk => monthFmt.format(mkDate(mk));
  const mkLong = mk => monthYearFmt.format(mkDate(mk));
  const mkShortName = mk => monthShortFmt.format(mkDate(mk));
  const monthYearFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  const monthShortFmt = new Intl.DateTimeFormat(undefined, { month: 'short' });
  const inMk = (at, mk) => { const [a, b] = mkRange(mk); return at >= a && at < b; };
  const dkey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  // a category's limit in a month: the latest change made for that month or one before it, else the limit it started with.
  // Lowering it for November carries on into December and after, until another change. null: no limit, just tracking.
  function limitFor(l, mk = curMk()) {
    const m = l.months || {};
    const keys = Object.keys(m).filter(k => k <= mk).sort();
    const v = keys.length ? m[keys[keys.length - 1]] : l.monthly;
    return v || null;
  }
  function limitCharges(l, mk = curMk()) {
    return S.txns.filter(t => t.bucketId === l.id && isOut(t) && inMk(t.at, mk)).sort((x, y) => y.at - x.at);
  }
  const limitSpent = (l, mk) => limitCharges(l, mk).reduce((s, t) => s + t.amount, 0);
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
  // a yearly one (every: 'year') renews once a year, in its month (1-12); the rest renew every month
  const yearly = b => b.every === 'year' && b.month >= 1 && b.month <= 12;
  const perMonth = b => (yearly(b) ? Math.round((b.amount || 0) / 12) : b.amount || 0);
  // the 31st falls on the last day of a shorter month; a yearly one is only due in its month
  function dueOn(b, y, m) {
    if (!b.day) return null;
    const first = new Date(y, m, 1), yy = first.getFullYear(), mm = first.getMonth();
    if (yearly(b) && mm !== b.month - 1) return null;
    return new Date(yy, mm, Math.min(b.day, new Date(yy, mm + 1, 0).getDate())).getTime();
  }
  // the next time it's due after this month (next month for most; up to a year out for a yearly one)
  function dueAfter(b, y, m) {
    for (let i = 1; i <= 12; i++) { const d = dueOn(b, y, m + i); if (d != null) return d; }
    return null;
  }
  const renewText = b => (yearly(b) && b.day ? `${shortDay.format(new Date(2000, b.month - 1, b.day))} each year` : b.day ? `The ${ordinal(b.day)}` : 'No day yet');
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
    if (!appliesIn(b, y, m)) return { st: 'next', due: dueAfter(b, y, m) };
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
    const far = s.due && new Date(s.due).getFullYear() !== new Date().getFullYear();
    return `<span class="pill">${esc(shortDay.format(s.due))}${far ? ', ' + new Date(s.due).getFullYear() : ''}</span>`;
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
    const cur = plan && !plan.never ? plan.pts : base.pts;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="fill" d="${path(cur)}L${W},${H}L0,${H}Z"/>
        <path class="${plan ? 'ghost' : 'line'}" d="${path(base.pts)}" vector-effect="non-scaling-stroke"/>
        ${plan && !plan.never ? `<path class="line" d="${path(plan.pts)}" vector-effect="non-scaling-stroke"/>` : ''}
      </svg>
      <i class="l-dot"></i>
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

  /* ---------- paychecks: what comes in, and when ---------- */
  // A paycheck lands on set days of the month (the 15th and the 30th; the 30th is the last day of a shorter month),
  // or every two weeks from a payday you know. One that falls on a weekend comes the Friday before.
  const incById = id => S.income.find(i => i.id === id);
  // set by hand (a deposit marked as a move between accounts, or not), else read from the bank's words
  const isTransfer = t => (t.transfer != null ? !!t.transfer : /\btransfer\b/i.test(`${t.merchant || ''} ${t.alert || ''}`));
  // the paycheck a deposit is ('_no': marked as not a paycheck, so it's never matched to one)
  const payOf = t => (t.payId && t.payId !== '_no' && incById(t.payId) ? t.payId : null);
  // money that came in and counts as income: not a move between your own accounts
  const isIncome = t => !isOut(t) && !isTransfer(t) && !t.example;
  function weekdayBefore(d) { const w = d.getDay(); if (w === 6) d.setDate(d.getDate() - 1); else if (w === 0) d.setDate(d.getDate() - 2); return d; }
  function paydays(inc, mk) {
    const [y, m] = mkParts(mk), out = new Map();
    const add = d => { const s = weekdayBefore(d); if (inMk(s.getTime(), mk)) out.set(dkey(s.getTime()), s.getTime()); };
    if (inc.every === 14 && inc.anchor) {
      const [ay, am, ad] = inc.anchor.split('-').map(Number), a0 = new Date(ay, am - 1, ad).getTime();
      const k = Math.floor((mkRange(mk)[0] - a0) / (14 * DAY));
      for (let i = k - 1; i <= k + 3; i++) add(new Date(ay, am - 1, ad + i * 14));
    } else {
      for (const off of [0, 1]) for (const day of inc.days || []) add(new Date(y, m + off, Math.min(day, new Date(y, m + off + 1, 0).getDate())));
    }
    return [...out.entries()].sort((a, b) => a[1] - b[1]).map(([key, at]) => ({ key, at }));
  }
  // a payday: arrived (its deposit found, or checked off by hand), coming, waiting on it, or not seen
  function payState(inc, p) {
    const hits = S.txns.filter(t => t.payId === inc.id && t.payDay === p.key);
    if (hits.length) return { st: 'got', amount: hits.reduce((s, t) => s + t.amount, 0), at: Math.max(...hits.map(t => t.at)) };
    const g = inc.got && inc.got[p.key];
    if (g) return { st: 'got', amount: g.amount || inc.amount || 0, at: g.at, manual: true };
    if (p.at < startOfDay(inc.createdAt || 0)) return { st: 'before', amount: inc.amount || 0 };
    const days = Math.round((p.at - startOfDay(Date.now())) / DAY);
    return { st: days > 0 ? 'expected' : days >= -GRACE ? 'waiting' : 'missed', amount: inc.amount || 0, days };
  }
  const payWords = inc => [inc.name, ...String(inc.match || '').split(',')].map(norm).filter(x => x.length >= 3);
  const payNamed = (inc, t) => { const m = ' ' + norm(`${t.merchant} ${t.alert || ''}`) + ' ', sq = m.replace(/ /g, ''); return payWords(inc).some(x => m.includes(' ' + x + ' ') || sq.includes(x.replace(/ /g, ''))); };
  // which deposits are this paycheck: ones that name it, else one near its amount, else a same-day split that adds up to it
  function pickPay(inc, p, pool) {
    const near = t => Math.abs(t.at - p.at);
    const byDay = list => { const g = new Map(); for (const t of list) { const k = dkey(t.at); if (!g.has(k)) g.set(k, []); g.get(k).push(t); } return [...g.values()].sort((a, b) => near(a[0]) - near(b[0])); };
    const named = pool.filter(t => payNamed(inc, t));
    if (named.length) return byDay(named)[0];
    if (!inc.amount) return [];
    const one = pool.filter(t => Math.abs(t.amount - inc.amount) <= Math.round(inc.amount * 0.15)).sort((a, b) => near(a) - near(b));
    if (one.length) return [one[0]];
    return byDay(pool).find(g => g.length > 1 && Math.abs(g.reduce((s, t) => s + t.amount, 0) - inc.amount) <= Math.round(inc.amount * 0.03)) || [];
  }
  // a deposit that arrives a few days either side of a payday becomes that paycheck (it isn't counted twice)
  let incBusy = false;
  async function autoIncome() {
    if (incBusy || !canSave() || !S.income.length) return;
    incBusy = true;
    try {
      const now = Date.now(), mk = curMk();
      const free = () => S.txns.filter(t => isIncome(t) && !t.payId && t.at >= now - 45 * DAY);
      for (const inc of S.income) {
        const days = [mkAdd(mk, -1), mk, mkAdd(mk, 1)].flatMap(k => paydays(inc, k)).filter(p => p.at >= now - 40 * DAY && p.at <= now + 6 * DAY);
        for (const p of days) {
          const pool = free().filter(t => t.at >= p.at - 5 * DAY && t.at < p.at + 5 * DAY && (!inc.accountId || !t.accountId || t.accountId === inc.accountId));
          if (!pool.length) continue;
          const have = S.txns.filter(t => t.payId === inc.id && t.payDay === p.key);
          // already found: only another deposit naming it on the same day joins it (a paycheck split between accounts)
          const pick = have.length ? pool.filter(t => payNamed(inc, t) && dkey(t.at) === dkey(have[0].at)) : pickPay(inc, p, pool);
          if (!pick.length) continue;
          for (const t of pick) if (!(await save(refs.txns.doc(t.id).update({ payId: inc.id, payDay: p.key })))) return;
          const total = S.txns.filter(t => t.payId === inc.id && t.payDay === p.key).reduce((s, t) => s + t.amount, 0);
          const patch = {};
          if (inc.got && inc.got[p.key]) { const got = { ...inc.got }; delete got[p.key]; patch.got = got; }
          // the paycheck's usual amount follows what really lands, unless it's way off (a bonus, a short week)
          if (total !== inc.amount && inc.amount && Math.abs(total - inc.amount) <= inc.amount * 0.1) patch.amount = total;
          if (Object.keys(patch).length) await save(refs.income.doc(inc.id).update(patch));
          toast(`Paycheck arrived: ${fmt(total)}${patch.amount ? `. Now expecting ${fmt(total)} each payday` : ''}`);
        }
      }
    } finally { incBusy = false; }
  }
  async function togglePay(incId, key) {
    const inc = incById(incId);
    if (!inc) return;
    const got = { ...(inc.got || {}) }, was = !!got[key];
    if (was) delete got[key]; else got[key] = { at: Date.now(), amount: inc.amount || 0 };
    const day = shortDay.format(new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8)));
    if (await save(refs.income.doc(inc.id).update({ got })))
      toast(was ? `Paycheck for ${day} is no longer checked off` : `Paycheck for ${day} checked off`, () => save(refs.income.doc(inc.id).update({ got: inc.got || {} })));
  }

  /* ---------- a month of money: what came in, what went out and where ---------- */
  // a bill that is really a loan's payment (the car's) sits with the loans; a bill with a small loan inside (the phone's part of Verizon) stays a bill
  const loanOfBill = b => S.loans.find(l => l.billId === b.id && l.payment && b.amount && l.payment >= b.amount * 0.8) || null;
  // which month a bill's charge counts for: the month it checked off, else when it went through
  const billMonthOf = (b, t) => { for (const [k, p] of Object.entries(b.paid || {})) if (p && p.txnId === t.id) return k; return monthKeyOf(new Date(t.at).getFullYear(), new Date(t.at).getMonth()); };
  const DUE = new Set(['due', 'waiting', 'late', 'noday']);
  function monthModel(mk) {
    const cur = curMk(), [y, m] = mkParts(mk), [, end] = mkRange(mk), today = startOfDay(Date.now());
    const pays = S.income.flatMap(inc => paydays(inc, mk).map(p => ({ incId: inc.id, name: inc.name, key: p.key, at: p.at, ...payState(inc, p) })))
      .map(({ days, manual, ...p }) => ({ ...p, ...(manual ? { manual: true } : {}) }));
    const others = S.txns.filter(t => isIncome(t) && !payOf(t) && inMk(t.at, mk)).sort((a, b) => a.at - b.at).map(t => ({ id: t.id, name: t.merchant || 'Deposit', at: t.at, amount: t.amount }));
    const lines = [], missing = [];
    const outs = S.txns.filter(t => isOut(t) && t.bucketId !== '_none');
    for (const b of S.bills.slice().sort(byDay)) {
      const loan = loanOfBill(b), group = loan ? 'loan' : groupOf(b), name = loan ? `${loan.name} payment` : b.name;
      const tagged = outs.filter(t => t.bucketId === 'bill:' + b.id && billMonthOf(b, t) === mk);
      const p = paidIn(b, mk);
      let amount = tagged.reduce((s, t) => s + t.amount, 0);
      if (p && !p.txnId) amount += b.amount || 0;
      const line = { id: b.id, group, name, ...(loan && b.name !== name ? { note: b.name } : {}) };
      if (amount || p) { lines.push({ ...line, amount, st: 'paid', at: p && p.at ? p.at : tagged.length ? Math.max(...tagged.map(t => t.at)) : null }); continue; }
      if (createdMonth(b) > mk) continue;
      if (!b.amount) { missing.push({ id: b.id, group, name }); continue; }
      if (!b.day) { lines.push({ ...line, amount: b.amount, st: mk < cur ? 'unseen' : 'noday' }); continue; }
      const due = dueOn(b, y, m);
      if (due == null) continue; // a yearly one, outside its month
      let st;
      if (mk < cur) st = 'unseen';
      else if (due < startOfDay(b.createdAt || 0)) st = 'before';
      else { const d = Math.round((due - today) / DAY); st = d > 0 ? 'due' : d >= -GRACE ? 'waiting' : 'late'; }
      lines.push({ ...line, amount: b.amount, st, at: due });
    }
    // charges to a bill that's since been removed
    const gone = outs.filter(t => String(t.bucketId || '').startsWith('bill:') && !billById(t.bucketId.slice(5)) && inMk(t.at, mk));
    if (gone.length) lines.push({ id: '_gonebill', group: 'bill', name: 'Removed bill', amount: gone.reduce((s, t) => s + t.amount, 0), st: 'paid' });
    for (const l of kind('limit')) {
      const spent = limitSpent(l, mk);
      if (!spent && (l.createdAt || 0) >= end) continue;
      lines.push({ id: l.id, group: 'cat', name: l.name, amount: spent, limit: limitFor(l, mk) });
    }
    const known = new Set(S.buckets.map(b => b.id));
    const stray = outs.filter(t => t.bucketId && !String(t.bucketId).startsWith('bill:') && !known.has(t.bucketId) && inMk(t.at, mk));
    if (stray.length) lines.push({ id: '_gonecat', group: 'cat', name: 'Removed category', amount: stray.reduce((s, t) => s + t.amount, 0), limit: null });
    for (const g of S.buckets.filter(b => b.kind === 'goal')) {
      const v = outs.filter(t => t.bucketId === g.id && inMk(t.at, mk)).reduce((s, t) => s + t.amount, 0);
      if (v) lines.push({ id: g.id, group: 'goal', name: g.name, amount: v });
    }
    // money moved into savings from your other accounts (less what came back out of it)
    const isSav = t => (acct(t.accountId) || {}).type === 'savings';
    const saved = S.txns.filter(t => inMk(t.at, mk) && isSav(t) && (isOut(t) ? (isTransfer(t) || t.bucketId === '_none') : isTransfer(t)) && !t.example)
      .reduce((s, t) => s + (isOut(t) ? -t.amount : t.amount), 0);
    if (saved > 0) lines.push({ id: '_saved', group: 'save', name: 'Moved to savings', amount: saved });
    const waiting = outs.filter(t => !t.bucketId && inMk(t.at, mk));
    if (waiting.length) lines.push({ id: '_wait', group: 'wait', name: `${waiting.length} ${waiting.length === 1 ? 'charge' : 'charges'} to approve`, amount: waiting.reduce((s, t) => s + t.amount, 0) });
    return { mk, pays, others, lines, missing };
  }
  // the totals, worked out the same way from a live month or a saved one
  function monthTotals(mod) {
    const cur = curMk(), ahead = mod.mk >= cur;
    const inAll = mod.pays.reduce((s, p) => s + (p.amount || 0), 0) + mod.others.reduce((s, o) => s + o.amount, 0);
    const inGot = mod.pays.filter(p => p.st === 'got' || p.st === 'before').reduce((s, p) => s + (p.amount || 0), 0) + mod.others.reduce((s, o) => s + o.amount, 0);
    let done = 0, due = 0, open = 0, saved = 0;
    for (const l of mod.lines) {
      if (l.group === 'cat') { done += l.amount; if (ahead && l.limit) open += Math.max(0, l.limit - l.amount); }
      else if (l.group === 'save') saved += l.amount;
      else if (DUE.has(l.st)) due += l.amount;
      else done += l.amount;
    }
    return { inAll, inGot, done, due, open, saved, left: inAll - done - due - saved, free: inAll - done - due - saved - open };
  }

  // Each month's figures are kept: this month's and last month's follow the data (late charges, re-sorting);
  // an older month shows what was saved for it, even after a bill or category is gone.
  const stable = v => (Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object'
    ? `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',')}}` : JSON.stringify(v === undefined ? null : v));
  const snapOf = mk => S.months.find(x => x.id === 'month-' + mk) || null;
  function modelFor(mk) {
    const s = mk < mkAdd(curMk(), -1) ? snapOf(mk) : null;
    return s ? { mk, pays: s.pays || [], others: s.others || [], lines: s.lines || [], missing: s.missing || [] } : monthModel(mk);
  }
  let monthsBusy = false;
  async function saveMonths() {
    if (monthsBusy || !canSave() || !S.loaded) return;
    monthsBusy = true;
    try {
      for (const mk of [mkAdd(curMk(), -1), curMk()]) {
        if (mk < START) continue;
        const data = monthModel(mk), old = snapOf(mk);
        if (old && stable({ ...strip(old), savedAt: 0 }) === stable({ ...data, savedAt: 0 })) continue;
        const ref = refs.months.doc('month-' + mk), body = { ...data, savedAt: Date.now() };
        try { await (old ? ref.update(body) : ref.set(body)); } catch (e) { break; }
      }
    } finally { monthsBusy = false; }
  }

  /* ---------- worth: what you own less what you owe, kept day by day ---------- */
  // "Something you own" (type 'asset'): the car, cash at home. It counts toward what you own; nothing is charged to it.
  const isThing = a => a.type === 'asset';
  // an account's balance at a moment: the balance last set, plus or minus the charges and deposits between then and that moment
  function acctAt(a, t) {
    const at0 = a.balanceAt || 0;
    let b = a.balance || 0;
    for (const x of S.txns) {
      if (x.accountId !== a.id) continue;
      if (x.at > at0 && x.at <= t) b += effect(a, x);
      else if (x.at <= at0 && x.at > t) b -= effect(a, x);
    }
    return b;
  }
  // a loan at a moment: the balance last set, less the principal in each payment made by then
  function loanAt(l, t) {
    if (l.balance == null) return 0;
    let bal = l.balance;
    const r = (l.apr || 0) / 1200;
    for (const at of loanPayments(l)) { if (at > t) break; const i = Math.round(bal * r); bal = Math.max(0, bal - Math.max(0, l.payment - i)); }
    return bal;
  }
  // a thing you own counts from the day you added it; before that, the chart carries today's value back (you had it then too)
  function worthAt(t) {
    let cash = 0, things = 0, owe = 0;
    for (const a of S.accounts) {
      if (a.example || (isThing(a) && (a.createdAt || 0) > t)) continue;
      const v = acctAt(a, t);
      if (a.type === 'credit') owe += v; else if (isThing(a)) things += v; else cash += v;
    }
    for (const l of S.loans) owe += loanAt(l, t);
    return { cash, things, owe };
  }
  const dayMs = (k, plus = 0) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d + plus).getTime(); };
  const nextDay = k => dkey(dayMs(k, 1));
  // the saved days, "2026-10-14" → { c: cash, t: things you own, o: owed, e: 1 when worked out afterwards from the charges }
  function worthDays() {
    const out = new Map();
    for (const d of S.worth) if (d.mk && d.days) for (const [dd, p] of Object.entries(d.days)) out.set(`${d.mk}-${dd}`, p);
    return out;
  }
  // Each time Finance loads, today's figures are kept (one doc a month, a line a day). Days nobody opened it, and the days
  // before the first one kept, back to the first charge seen, are worked out from the charges and deposits in between.
  let worthBusy = false;
  async function saveWorth() {
    if (worthBusy || !canSave() || !S.loaded || !S.accounts.some(a => !a.example)) return;
    worthBusy = true;
    try {
      const have = worthDays(), today = dkey(Date.now()), want = new Map();
      const w = worthAt(Date.now());
      want.set(today, { c: w.cash, t: w.things, o: w.owe });
      const keys = [...have.keys()].sort();
      const firstTx = S.txns.filter(x => !x.example).reduce((m, x) => Math.min(m, x.at), Infinity);
      let from = keys.length ? nextDay(keys[keys.length - 1]) : Number.isFinite(firstTx) ? dkey(firstTx) : today;
      if (from < START + '-01') from = START + '-01';
      for (let k = from, n = 0; k < today && n < 400; k = nextDay(k), n++) {
        if (have.has(k)) continue;
        const p = worthAt(dayMs(k, 1) - 1);
        want.set(k, { c: p.cash, t: p.things, o: p.owe, e: 1 });
      }
      const byMk = new Map();
      for (const [k, p] of want) { const mk = k.slice(0, 7); if (!byMk.has(mk)) byMk.set(mk, {}); byMk.get(mk)[k.slice(8)] = p; }
      for (const [mk, days] of [...byMk.entries()].sort()) {
        const id = 'worth-' + mk, old = S.worth.find(x => x.id === id), merged = { ...((old && old.days) || {}), ...days };
        if (old && stable(old.days || {}) === stable(merged)) continue;
        const ref = refs.worth.doc(id);
        try { await (old ? ref.update({ mk, days: merged }) : ref.set({ mk, days: merged })); } catch (e) { break; }
      }
    } finally { worthBusy = false; }
  }
  // day by day for the chart, today live. A thing you own added later is counted on the days before it too.
  function worthSeries() {
    const days = worthDays(), today = dkey(Date.now());
    const w = worthAt(Date.now());
    days.set(today, { c: w.cash, t: w.things, o: w.owe });
    const things = S.accounts.filter(a => isThing(a) && !a.example);
    return [...days.keys()].sort().map(k => {
      const p = days.get(k), end = dayMs(k, 1) - 1;
      const later = things.filter(a => (a.createdAt || 0) > end).reduce((s, a) => s + acctBalance(a), 0);
      const own = (p.c || 0) + (p.t || 0) + later, owe = p.o || 0;
      return { k, at: dayMs(k), own, owe, net: own - owe, est: !!p.e };
    });
  }
  // how much net worth grows in a month if things carry on: what goes into savings, plus what the loan payments take off
  function worthPace() {
    const cur = curMk(), prev = mkAdd(cur, -1);
    const savedIn = mk => (mk >= START ? monthTotals(modelFor(mk)).saved : 0);
    const saved = Math.max(savedIn(cur), savedIn(prev));
    let principal = 0;
    for (const l of S.loans) { const bal = loanNow(l); if (!bal || !l.payment) continue; principal += Math.min(bal, Math.max(0, l.payment - Math.round(bal * (l.apr || 0) / 1200))); }
    return { saved, principal, month: saved + principal };
  }

  /* ---------- pieces ---------- */
  function chargeCard(t) {
    const billChips = billsNear(t).slice(0, 3).map(b =>
      `<button type="button" class="chip bill" data-act="fin-sort" data-txn="${esc(t.id)}" data-bucket="bill:${esc(b.id)}">${esc(b.name)}<span>${b.amount ? fmt(b.amount) + ' ' : ''}${groupOf(b) === 'sub' ? 'subscription' : 'bill'}</span></button>`);
    const usual = usualFor(t), limits = kind('limit').slice().sort((a, b) => (b === usual) - (a === usual));
    const chips = billChips.concat(limits.map(l => {
      const lim = limitFor(l), left = (lim || 0) - limitSpent(l), u = l === usual;
      return `<button type="button" class="chip${u ? ' usual' : ''}" data-act="fin-sort" data-txn="${esc(t.id)}" data-bucket="${esc(l.id)}"${u ? ' title="Where this place went last time"' : ''}>${esc(l.name)}<span>${u ? 'Last time · ' : ''}${!lim ? fmt(limitSpent(l)) + ' this month' : left >= 0 ? fmt(left) + ' left' : fmt(-left) + ' over'}</span></button>`;
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


  /* ---------- the overview's pictures ---------- */
  // a big money figure, the cents dimmed
  const big = c => { const t = fmt(c), i = t.lastIndexOf('.'); return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<span class="cents">${esc(t.slice(i))}</span>`; };
  // this month's bills on a line from the 1st to the last day: bigger dot, bigger bill
  function billLine() {
    const now = new Date(), y = now.getFullYear(), m = now.getMonth(), dim = new Date(y, m + 1, 0).getDate(), today = now.getDate();
    const items = S.bills.filter(b => b.day && appliesIn(b, y, m)).map(b => ({ b, s: billState(b), d: new Date(dueOn(b, y, m)).getDate() }));
    if (!items.length) return '';
    const open = x => ['waiting', 'late', 'soon'].includes(x.s.st);
    const toGo = items.filter(x => open(x) && x.b.amount);
    const toGoSum = toGo.reduce((t, x) => t + x.b.amount, 0);
    const pos = d => (dim > 1 ? (d - 1) / (dim - 1) * 100 : 50);
    const byDay = new Map();
    for (const x of items) { if (!byDay.has(x.d)) byDay.set(x.d, []); byDay.get(x.d).push(x); }
    const sums = [...byDay.values()].map(g => g.reduce((t, x) => t + (x.b.amount || 0), 0));
    const most = Math.max(...sums, 1);
    const nodes = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, g]) => {
      const sum = g.reduce((t, x) => t + (x.b.amount || 0), 0), size = Math.round(14 + Math.sqrt(sum / most) * 18);
      const st = g.some(x => x.s.st === 'late') ? 'late' : g.every(x => x.s.st === 'paid') ? 'paid' : 'due';
      const names = g.map(x => `${x.b.name}${x.b.amount ? ' ' + fmt(x.b.amount) : ''}`).join(', ');
      return { d, g, sum, st, html: `<button type="button" class="bl-node ${st}" style="left:${pos(d).toFixed(2)}%;--s:${size}px" data-act="fin-sub" data-sub="bills" title="${esc(shortDay.format(new Date(y, m, d)))}: ${esc(names)}" aria-label="${esc(shortDay.format(new Date(y, m, d)))}: ${esc(names)}${st === 'paid' ? ', paid' : st === 'late' ? ', no charge seen' : ''}"></button>` };
    });
    // labels for the bills still to come, biggest first; two rows, and one that would crowd another is left to the tooltip
    const rows = [[], []], labels = [], room = window.innerWidth < 700 ? 44 : 28;
    for (const n of nodes.filter(x => x.st !== 'paid').sort((a, b) => b.sum - a.sum)) {
      const p = pos(n.d), r = rows.findIndex(row => row.every(q => Math.abs(q - p) > room));
      if (r < 0 || labels.length >= 3) continue;
      rows[r].push(p);
      const top = n.g.slice().sort((a, b) => (b.b.amount || 0) - (a.b.amount || 0))[0].b;
      const edge = p < 9 ? ' at-start' : p > 91 ? ' at-end' : '';
      labels.push(`<span class="bl-tag r${r}${edge}" style="left:${p.toFixed(2)}%"><b>${esc(top.name)}</b>${top.amount ? ' ' + esc(fmt(top.amount)) : ''}${n.g.length > 1 ? ` <small>+${n.g.length - 1}</small>` : ''}</span>`);
    }
    const ticks = [1, 10, 20, dim].map(d => `<span style="left:${pos(d).toFixed(2)}%">${d === 1 ? esc(shortDay.format(new Date(y, m, 1))) : d}</span>`).join('');
    // can each account cover what it still has to pay this month?
    const cover = sorted(S.accounts.filter(a => a.type !== 'credit')).map(a => {
      const due = toGo.filter(x => x.b.accountId === a.id).reduce((t, x) => t + x.b.amount, 0);
      if (!due) return '';
      const bal = acctBalance(a), short = due - bal;
      return `<div class="bl-cover${short > 0 ? ' short' : ''}">
        <div class="bl-ct"><span>${esc(a.name)} account</span><span class="num">${short > 0 ? `${fmt(bal)} for ${fmt(due)} · <b>${fmt(short)} short</b>` : `covers the ${fmt(due)} still to pay`}</span></div>
        <div class="meter" role="img" aria-label="${esc(`${a.name}: ${fmt(bal)} for ${fmt(due)} still to pay`)}"><span style="width:${Math.max(0, Math.min(100, bal / due * 100)).toFixed(1)}%"></span></div>
      </div>`;
    }).join('');
    return `<article class="float bl">
      <div class="bl-head"><span class="lab">Bills · ${esc(monthFmt.format(now))}</span><span class="meta">${toGo.length ? `<b>${fmt(toGoSum)}</b> still to go · ${toGo.length} ${toGo.length === 1 ? 'bill' : 'bills'}` : 'All paid this month'}</span></div>
      <div class="bl-track" role="group" aria-label="Bills in ${esc(monthFmt.format(now))}">
        <i class="bl-line"></i><i class="bl-past" style="width:${pos(today).toFixed(2)}%"></i>
        ${labels.join('')}${nodes.map(n => n.html).join('')}
        <i class="bl-today" style="left:${pos(today).toFixed(2)}%"></i>
        <div class="bl-axis">${ticks}<span class="bl-now" style="left:${pos(today).toFixed(2)}%">Today</span></div>
      </div>
      ${cover}
    </article>`;
  }
  // spending by day this month: one thin bar a day; days still to come are outlines
  function dailyBars(limits, mk = curMk()) {
    const now = new Date(), [y, m] = mkParts(mk), dim = new Date(y, m + 1, 0).getDate(), cur = curMk();
    const today = mk === cur ? now.getDate() : mk < cur ? dim + 1 : 0;
    const day = new Array(dim + 1).fill(0);
    for (const l of limits) for (const t of limitCharges(l, mk)) day[new Date(t.at).getDate()] += t.amount;
    const most = Math.max(...day, 1);
    const bars = [];
    for (let d = 1; d <= dim; d++) {
      const v = day[d], future = d > today;
      const tip = `${shortDay.format(new Date(y, m, d))}: ${future ? 'still to come' : fmt(v)}`;
      bars.push(`<span class="db${future ? ' later' : v ? '' : ' zero'}${d === today ? ' today' : ''}" style="--h:${future ? 12 : v ? Math.max(8, v / most * 100).toFixed(1) : 4}%" title="${esc(tip)}"></span>`);
    }
    return `<div class="daily" role="img" aria-label="${esc(`Spending by day in ${mkName(mk)}, most on one day ${fmt(most === 1 ? 0 : most)}`)}"><div class="db-bars">${bars.join('')}</div>
      <div class="db-axis"><span>${esc(shortDay.format(new Date(y, m, 1)))}</span>${mk === cur ? `<span class="db-now" style="left:${((today - 0.5) / dim * 100).toFixed(2)}%">Today</span>` : ''}<span>${esc(shortDay.format(new Date(y, m, dim)))}</span></div></div>`;
  }
  // a ring per category: how much of its limit is used, or just what's been spent when it has none
  function ring(l, mk = curMk()) {
    const spent = limitSpent(l, mk), lim = limitFor(l, mk) || 0, p = lim ? spent / lim : 0;
    const R = 26, C = 2 * Math.PI * R, st = lim && spent > lim ? 'over' : lim && p >= 0.85 ? 'near' : '';
    const mid = lim ? `${Math.round(p * 100)}%` : usd0.format(Math.round(spent / 100));
    return `<button type="button" class="ring ${st}${lim ? '' : ' open'}" data-act="fin-card" data-id="${esc(l.id)}" aria-label="${esc(`${l.name}: ${fmt(spent)}${lim ? ' of ' + fmt(lim) : ', no limit'}`)}">
      <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="r-track" cx="32" cy="32" r="${R}"/>${lim && spent ? `<circle class="r-fill" cx="32" cy="32" r="${R}" stroke-dasharray="${Math.max(2, Math.min(1, p) * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 32 32)"/>` : ''}<text x="32" y="37" text-anchor="middle">${esc(mid)}</text></svg>
      <span class="r-name">${esc(l.name)}</span><span class="r-sub">${lim ? `${esc(fmt(spent))} of ${esc(usd0.format(lim / 100))}` : 'no limit'}</span>
    </button>`;
  }
  // a share of the month's income: "12%", "4.5%", "<0.1%"
  const pctText = f => (f == null || !isFinite(f) ? '' : f <= 0 ? '0%' : f < 0.001 ? '<0.1%' : f < 0.1 ? (f * 100).toFixed(1).replace(/\.0$/, '') + '%' : Math.round(f * 100) + '%');
  // can each account cover the bills it still has to pay this month?
  function coverage() {
    const toGo = S.bills.filter(b => b.amount && b.accountId && ['waiting', 'late', 'soon'].includes(billState(b).st));
    return sorted(S.accounts.filter(a => a.type !== 'credit')).map(a => {
      const due = toGo.filter(b => b.accountId === a.id).reduce((t, b) => t + b.amount, 0), bal = acctBalance(a);
      return { a, due, bal, short: due - bal };
    }).filter(c => c.due);
  }
  // the debit card on a checking account: the last of its numbers when it has more than one ("6444, 7206": card 7206)
  // a credit card account is the card itself, so its number is the card's
  const cardOf = a => (a.card !== undefined ? a.card : (a.last4 || []).length > (a.type === 'credit' ? 0 : 1) ? a.last4[a.last4.length - 1] : null);
  function cardArt(a) {
    if (a.type === 'checking') {
      const c = cardOf(a);
      return c ? `<span class="dcard" role="img" aria-label="Debit card ending ${esc(c)}"><i class="dc-chip"></i><span class="dc-no">${esc(c)}</span></span>`
        : '<span class="dcard none" role="img" aria-label="No card on this account"><span>No card</span></span>';
    }
    if (a.type === 'credit' && cardOf(a)) return `<span class="dcard credit" role="img" aria-label="Credit card ending ${esc(cardOf(a))}"><i class="dc-chip"></i><span class="dc-no">${esc(cardOf(a))}</span></span>`;
    if (isThing(a)) return /car|truck|cr-?v|vehicle|bike|motorcycle/i.test(a.name || '')
      ? '<span class="ac-ic" aria-hidden="true"><svg class="i" viewBox="0 0 24 24"><path d="M5 16.5h14M6.5 16.5v2M17.5 16.5v2"/><path d="M4.5 16.5v-4l2-5h11l2 5v4"/><path d="M4.5 12.5h15"/><circle cx="8" cy="14.5" r=".6"/><circle cx="16" cy="14.5" r=".6"/></svg></span>'
      : '<span class="ac-ic" aria-hidden="true"><svg class="i" viewBox="0 0 24 24"><path d="M12.5 3.5H19a1.5 1.5 0 0 1 1.5 1.5v6.5l-9 9-8-8z"/><circle cx="16" cy="8" r="1.4"/></svg></span>';
    return a.type === 'savings'
      ? `<span class="ac-ic" aria-hidden="true"><svg class="i" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8v-.8M12 16v-.8M7 19v1.5M17 19v1.5"/></svg></span>`
      : `<span class="ac-ic" aria-hidden="true"><svg class="i" viewBox="0 0 24 24"><rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M3.5 10h17M7 14.5h3"/></svg></span>`;
  }
  // the accounts stacked, the way the bank lists them; tap one to update its balance
  function acctList() {
    const accts = [...sorted(S.accounts.filter(a => !isThing(a))), ...sorted(S.accounts.filter(isThing))];
    if (!accts.length) return `<article class="float ac"><span class="lab">Accounts</span><p class="empty">No accounts yet.</p>${canSave() ? '<div><button type="button" class="btn solid" data-act="fin-form" data-form="account">Add account</button></div>' : ''}</article>`;
    const cov = coverage();
    const rows = accts.map(a => {
      const credit = a.type === 'credit', num = (a.last4 || [])[0], bal = acctBalance(a);
      const short = cov.find(c => c.a.id === a.id && c.short > 0);
      const u = a.type === 'savings' ? unsorted(a) : 0, cats = a.type === 'savings' ? catsOf(a).length : 0;
      const sort = u && canSave() ? `<button type="button" class="ac-sort" data-act="fin-form" data-form="${cats ? 'allocate' : 'goal'}" ${cats ? `data-id="${esc(a.id)}"` : `data-account="${esc(a.id)}"`}>${u > 0 ? `Sort ${esc(fmt(u))}` : `Cover ${esc(fmt(-u))}`}</button>` : '';
      return `<div class="ac-row">
        <button type="button" class="ac-main" data-act="fin-form" data-form="account" data-id="${esc(a.id)}"${canSave() ? '' : ' disabled'} aria-label="${esc(`${a.name}${credit ? ', owed' : ''}: ${fmt(bal)}. Update the balance`)}">
          <span class="ac-art">${cardArt(a)}</span>
          <span class="ac-n"><b>${esc(a.name)}</b><span>${isThing(a) ? 'What it’s worth' : `${num ? '••' + esc(num) : ''}${credit ? (num ? ' · ' : '') + 'owed' : ''}`}</span></span>
          <span class="ac-v${credit ? ' owed' : ''}">${big(bal)}</span>
        </button>
        ${short ? `<span class="ac-short">${ICON.warn}${esc(fmt(short.short))} short for bills</span>` : ''}${sort}
      </div>`;
    }).join('');
    return `<article class="float ac"><span class="lab">Accounts</span><div class="ac-list">${rows}</div></article>`;
  }

  // what counts as spending on a day: every charge out, but not money moved between your accounts or marked "not spending"
  const spentIn = mk => S.txns.filter(t => isOut(t) && !isTransfer(t) && t.bucketId !== '_none' && inMk(t.at, mk));
  // the month as plain boxes, one a day: the more spent, the deeper the color. Today is ringed.
  function heatCal(mk) {
    const [y, m] = mkParts(mk), dim = new Date(y, m + 1, 0).getDate(), lead = new Date(y, m, 1).getDay(), cur = curMk();
    const today = mk === cur ? new Date().getDate() : mk < cur ? dim + 1 : 0;
    const day = new Array(dim + 1).fill(0), n = new Array(dim + 1).fill(0);
    for (const t of spentIn(mk)) { const d = new Date(t.at).getDate(); day[d] += t.amount; n[d]++; }
    const most = Math.max(...day, 1), sel = S.day && S.day.startsWith(mk + '-') ? +S.day.slice(8) : 0;
    let cells = '<i class="hc-pad"></i>'.repeat(lead);
    for (let d = 1; d <= dim; d++) {
      const v = day[d], later = d > today, dt = new Date(y, m, d);
      const a = v ? (0.22 + 0.78 * Math.sqrt(v / most)).toFixed(2) : '0';
      const say = `${dayFmt.format(dt)}${d === today ? ', today' : ''}: ${later ? 'still to come' : v ? `${fmt(v)}, ${n[d]} ${n[d] === 1 ? 'charge' : 'charges'}` : 'nothing spent'}`;
      cells += `<button type="button" class="hc-d${later ? ' later' : ''}${d === today ? ' today' : ''}${d === sel ? ' sel' : ''}" style="--a:${a}" data-act="fin-day" data-day="${mk}-${pad2(d)}" aria-pressed="${d === sel}" aria-label="${esc(say)}" title="${esc(say)}"${later ? ' disabled' : ''}></button>`;
    }
    return `<article class="float hc"><span class="lab">Spending each day · ${esc(mkShortName(mk))}</span><div class="hc-grid" role="group" aria-label="${esc(`Spending each day in ${mkName(mk)}`)}">${cells}</div></article>`;
  }
  // the day you tapped: each charge, where it went, and the total
  function dayCard(mk) {
    if (!S.day || !S.day.startsWith(mk + '-')) return '';
    const [y, mo, d] = S.day.split('-').map(Number), dt = new Date(y, mo - 1, d), k = S.day;
    const list = spentIn(mk).filter(t => dkey(t.at) === k).sort((a, b) => a.at - b.at), total = list.reduce((s, t) => s + t.amount, 0);
    const rows = list.map(t => `<button type="button" class="hc-tx" data-act="fin-form" data-form="charge" data-id="${esc(t.id)}"${canSave() ? '' : ' disabled'}>
        <b>${esc(t.merchant || 'Charge')}${exTag(t)}</b><span class="num">${esc(fmt(t.amount))}</span>
        <small>${esc(timeFmt.format(t.at))} · ${esc(bucketLabel(t) || 'Needs approval')} · ${esc(acctLabel(acct(t.accountId)))}</small></button>`).join('');
    return `<article class="float hc-day"><div class="hc-dh"><span class="lab">${esc(dayFmt.format(dt))}</span><span class="fig md">${esc(fmt(total))}</span>
      <button type="button" class="circle hc-close" data-act="fin-day" data-day="${k}" aria-label="Close this day"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg></button></div>
      ${rows ? `<div class="hc-list">${rows}</div>` : '<p class="empty">Nothing spent this day.</p>'}</article>`;
  }


  /* ---------- pay: the salary, what lands, and what comes out for taxes ---------- */
  // checks in a year: twice a month is 24, every two weeks is 26
  const checksPerYear = inc => (inc.every === 14 ? 26 : inc.every === 7 ? 52 : Math.max(1, (inc.days || []).length) * 12);
  // 2026, a single filer: federal on top of the $16,100 standard deduction; South Carolina from AGI less its own
  // deduction ($15,000, phasing out between $40,000 and $95,000), 1.99% under $30,000 and 5.21% less $966 above it.
  // An estimate of the split only: the real total is what the deposit shows.
  function taxSplit(salary) {
    const g = salary / 100, fedTaxable = Math.max(0, g - 16100);
    const fedBands = [[12400, .10], [50400, .12], [105700, .22], [201775, .24], [256225, .32], [640600, .35], [Infinity, .37]];
    let fed = 0, low = 0;
    for (const [top, r] of fedBands) { if (fedTaxable > low) fed += (Math.min(fedTaxable, top) - low) * r; low = top; }
    const scDed = g <= 40000 ? 15000 : g >= 95000 ? 0 : 15000 * (1 - (g - 40000) / 55000), scTaxable = Math.max(0, g - scDed);
    const sc = scTaxable < 30000 ? scTaxable * 0.0199 : scTaxable * 0.0521 - 966;
    const c = v => Math.round(v * 100);
    return { ss: c(Math.min(g, 184500) * 0.062), med: c(g * 0.0145), fed: c(fed), sc: c(Math.max(0, sc)) };
  }
  function payCard(mk) {
    if (!S.income.length) return `<article class="float pay"><span class="lab">Pay</span><p class="empty">Add your paycheck to see it here.</p>${canSave() ? '<div><button type="button" class="btn solid" data-act="fin-form" data-form="income">Add paycheck</button></div>' : ''}</article>`;
    return S.income.slice().sort(byCreated).map(inc => {
      const n = checksPerYear(inc), net = inc.amount || 0, sal = inc.salary || 0, yrNet = net * n;
      const rows = [['Each check', sal / n, net], ['Month', sal / 12, yrNet / 12], ['Year', sal, yrNet], ['Week', sal / 52, yrNet / 52]];
      const money = v => esc(fmt(Math.round(v)));
      const tr = ([l, g, t]) => `<tr${l === 'Year' ? ' class="py-yr"' : ''}><th scope="row">${l}</th>${sal ? `<td>${money(g)}</td><td class="tax">${money(g - t)}</td>` : ''}<td class="net">${money(t)}</td></tr>`;
      const sched = inc.every === 14 ? 'every two weeks' : inc.every === 7 ? 'every week' : (inc.days || []).length > 1 ? `the ${inc.days.map(ordinal).join(' and ')}` : inc.days && inc.days[0] ? `the ${ordinal(inc.days[0])}` : '';
      const pays = paydays(inc, mk).map(p => payState(inc, p)), got = pays.filter(p => p.st === 'got' || p.st === 'before').length;
      const out = sal ? sal / n - net : 0, key = 'tax-' + inc.id, open = S.open.has(key);
      let split = '';
      if (sal && open) {
        const e = taxSplit(sal), per = v => v / n, known = per(e.ss) + per(e.med) + per(e.fed) + per(e.sc), rest = out - known;
        const line = (l, v, note = '') => `<div class="py-x"><span>${l}${note ? ` <small>${note}</small>` : ''}</span><span class="num">${money(v)}</span></div>`;
        split = `<div class="py-split">${line('Social Security', per(e.ss), '6.2%')}${line('Medicare', per(e.med), '1.45%')}${line('Federal income tax', per(e.fed), 'about')}${line('South Carolina income tax', per(e.sc), 'about')}
          ${Math.abs(rest) >= 100 ? line(rest > 0 ? 'Everything else' : 'Less than the estimate', Math.abs(rest), rest > 0 ? 'benefits, or the estimate off' : '') : ''}
          <p class="meta">Each check, worked out from 2026 rates for a single filer. A pay stub has the exact split.</p></div>`;
      }
      return `<article class="float pay">
        <div class="py-head"><span class="lab">Pay · ${esc(inc.name || 'Paycheck')}</span>${canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="income" data-id="${esc(inc.id)}" aria-label="Edit pay">${ICON.edit}</button>` : ''}</div>
        ${sal ? `<div class="py-top"><span class="py-sal">${big(sal)}<small> a year before taxes</small></span><span class="py-pct">${(out / (sal / n) * 100).toFixed(1).replace(/\.0$/, '')}% taken out</span></div>` : `<button type="button" class="link py-add" data-act="fin-form" data-form="income" data-id="${esc(inc.id)}"${canSave() ? '' : ' disabled'}>Add your yearly salary to see taxes</button>`}
        <table class="py-t"><thead><tr><th></th>${sal ? '<th>Before taxes</th><th>Taxes</th>' : ''}<th>Take-home</th></tr></thead><tbody>${rows.map(tr).join('')}</tbody></table>
        <p class="meta py-foot">${n} checks a year${sched ? `, on ${esc(sched)}` : ''} · ${esc(mkName(mk))}: ${got} of ${pays.length} in</p>
        ${sal ? `<button type="button" class="link py-more" data-act="fin-toggle" data-id="${esc(key)}" aria-expanded="${open}">${open ? 'Hide' : 'What comes out of each check'}</button>${split}` : ''}
      </article>`;
    }).join('');
  }
  // a payday that's passed with no deposit seen: did it come?
  function payNotes() {
    const today = startOfDay(Date.now()), mk = curMk();
    return S.income.flatMap(inc => [mkAdd(mk, -1), mk].flatMap(k => paydays(inc, k)).map(p => ({ inc, p, s: payState(inc, p) })))
      .filter(x => (x.s.st === 'waiting' || x.s.st === 'missed') && x.p.at < today && x.p.at >= today - 20 * DAY)
      .map(({ inc, p }) => `<div class="float note bill-note late"><p>${ICON.warn}<span>The <b>${esc(fmt(inc.amount))}</b> paycheck for ${esc(shortDay.format(p.at))} hasn’t shown up. If it came, check it off.</span></p>${canSave() ? `<button type="button" class="btn solid" data-act="fin-pay" data-id="${esc(inc.id)}" data-key="${esc(p.key)}">It came</button>` : ''}</div>`).join('');
  }

  /* ---------- views ---------- */
  const ovMk = () => (S.ovMk && S.ovMk >= START ? S.ovMk : curMk());
  const signed = c => (c < 0 ? '−' : '') + fmt(Math.abs(c));
  const bigSigned = c => (c < 0 ? '<span class="neg">−</span>' : '') + big(Math.abs(c));
  const dollars = c => usd0.format(Math.round(c / 100));
  const kShort = c => { const d = Math.abs(c) / 100, t = d >= 1000 ? (d / 1000).toFixed(d >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(d)); return (c < 0 ? '−$' : '$') + t; };
  // round numbers for a chart's side, about three steps apart
  function niceTicks(lo, hi) {
    const raw = Math.max(hi - lo, 1) / 3, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= raw) || raw, out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-6; v += step) out.push(Math.round(v));
    return out;
  }

  /* ---------- net worth: what you own less what you owe, over time ---------- */
  const NW = { net: { name: 'Net worth', tab: 'Net worth' }, own: { name: 'What you own', tab: 'Own' }, owe: { name: 'What you owe', tab: 'Owe' } };
  let worthPts = null; // the drawn points, for the finger
  function worthPlot(ser, sel) {
    const n = ser.length, vals = ser.map(p => p[sel]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.18, Math.abs(hi) * 0.03, 5000);
    lo -= pad; hi += pad;
    const ticks = niceTicks(lo, hi), W = 600, H = 200;
    const t0 = ser[0].at, t1 = Math.max(ser[n - 1].at, t0 + DAY);
    const X = at => (n === 1 ? W : (at - t0) / (t1 - t0) * W), Y = v => (1 - (v - lo) / (hi - lo)) * H;
    const d = n === 1 ? `M0,${Y(vals[0]).toFixed(1)}H${W}` : ser.map((p, i) => `${i ? 'L' : 'M'}${X(p.at).toFixed(1)},${Y(p[sel]).toFixed(1)}`).join('');
    const area = n > 1 ? `<path class="nw-area" d="${d}L${W},${H}L0,${H}Z"/>` : '';
    const grid = ticks.map(v => `<path class="nw-g${v === 0 ? ' zero' : ''}" d="M0,${Y(v).toFixed(1)}H${W}" vector-effect="non-scaling-stroke"/>`).join('');
    const labels = ticks.map(v => `<span class="nw-y${v === 0 ? ' zero' : ''}" style="top:${(Y(v) / H * 100).toFixed(2)}%">${esc(kShort(v))}</span>`).join('');
    worthPts = { sel, pts: ser.map(p => ({ x: X(p.at) / W, y: Y(p[sel]) / H, p })) };
    const last = worthPts.pts[n - 1];
    const say = `${NW[sel].name}, ${shortDay.format(ser[0].at)} to today: ${signed(vals[0])} to ${signed(vals[n - 1])}`;
    return `<div class="nw-plot${n === 1 ? ' one' : ''}" role="img" aria-label="${esc(say)}">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="nwFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eceef2" stop-opacity=".13"/><stop offset="1" stop-color="#eceef2" stop-opacity="0"/></linearGradient></defs>
          ${grid}${area}<path class="nw-line" d="${d}" vector-effect="non-scaling-stroke"/></svg>
        ${labels}<i class="nw-end" style="left:${(last.x * 100).toFixed(2)}%;top:${(last.y * 100).toFixed(2)}%"></i>
        <i class="nw-xh" hidden></i><i class="nw-dot" hidden></i><span class="nw-tip" hidden></span>
      </div>
      <div class="nw-axis"><span>${n === 1 ? 'Today' : esc(shortDay.format(ser[0].at))}</span><span>${n === 1 ? 'A point gets added each day' : 'Today'}</span></div>`;
  }
  function worthCard() {
    const ser = worthSeries(), sel = NW[S.nw] ? S.nw : 'net', now = ser[ser.length - 1], first = ser[0];
    const ch = now[sel] - first[sel], better = sel === 'owe' ? ch < 0 : ch > 0, since = shortDay.format(first.at);
    const delta = ser.length < 2 ? '<span class="nw-d">Tracking starts today</span>' : !ch ? `<span class="nw-d">No change since ${esc(since)}</span>`
      : `<span class="nw-d ${better ? 'good' : 'bad'}">${ch > 0 ? ICON.up : ICON.down}<span>${ch > 0 ? 'Up' : 'Down'} ${esc(fmt(Math.abs(ch)))} since ${esc(since)}</span></span>`;
    const tabs = Object.entries(NW).map(([k, v]) => `<button type="button" data-act="fin-nw" data-nw="${k}" aria-pressed="${k === sel}">${v.tab}</button>`).join('');
    // the sum, spelled out: own less owe is net worth
    const eq = `<div class="nw-eq">
        <span><small>You own</small><b>${esc(fmt(now.own))}</b></span><i aria-hidden="true">−</i>
        <span><small>You owe</small><b>${esc(fmt(now.owe))}</b></span><i aria-hidden="true">=</i>
        <span><small>Net worth</small><b${now.net < 0 ? ' class="neg"' : ''}>${esc(signed(now.net))}</b></span></div>`;
    let note = '';
    const pace = worthPace();
    if (sel === 'net' && pace.month > 0) {
      const how = `${pace.saved ? `${esc(dollars(pace.saved))} a month into savings` : ''}${pace.saved && pace.principal ? ' and ' : ''}${pace.principal ? `${esc(dollars(pace.principal))} a month off your loans` : ''}`;
      if (now.net < 0) {
        const m = Math.ceil(-now.net / pace.month), d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + m);
        note = `At this pace, ${how}, you pass $0 around <b>${esc(monYr.format(d))}</b>.`;
      } else note = `At this pace, ${how}, it grows about <b>${esc(dollars(pace.month))}</b> a month.`;
    } else if (sel === 'owe') {
      const plans = S.loans.map(l => ({ l, p: payoff(l, l.extra || 0) })).filter(x => x.p && !x.p.never);
      if (plans.length) note = `At today’s payments, the last loan is paid off <b>${esc(monYr.format(Math.max(...plans.map(x => payoffDate(x.l, x.p.months)))))}</b>.`;
    } else if (sel === 'own') note = `Checking and savings${S.accounts.some(isThing) ? ', plus what you own' : ''}. The credit card and loans are in what you owe.`;
    const car = S.loans.find(l => /cr-?v|car|truck|auto/i.test(`${l.name} ${l.lender || ''}`));
    const add = !S.accounts.some(isThing) && canSave() ? `<div class="nw-add"><span>${car ? `Your ${esc(car.name)} is worth something too.` : 'A car or cash at home counts too.'} Add what it would sell for and your net worth counts it.</span>
        <button type="button" class="btn" data-act="fin-form" data-form="account" data-type="asset"${car ? ` data-name="${esc(car.name)}"` : ''}>Add ${car ? 'it' : 'one'}</button></div>` : '';
    return `<article class="float nw">
      <div class="nw-head"><div class="nw-tt"><span class="lab">${NW[sel].name}</span><span class="fig nw-fig">${bigSigned(now[sel])}</span>${delta}</div>
        <div class="nw-tabs" role="group" aria-label="Show">${tabs}</div></div>
      ${worthPlot(ser, sel)}
      ${eq}${note ? `<p class="nw-note">${note}</p>` : ''}${add}
    </article>`;
  }

  /* ---------- where the month's money goes ---------- */
  // a spending category is a need (groceries, gas) or a want: set on the category, until then guessed from its name
  const needGuess = n => /grocer|\bgas\b|fuel|medic|pharm|doctor|rent|utilit|insur|daycare|child|baby|school|tuition|toll|parking|transit|pet food|cat food/i.test(n)
    && !/snack|fun|fast|eat|restaurant|coffee|treat|game|hobby/i.test(n);
  const isNeed = l => (l.need != null ? !!l.need : needGuess(l.name || ''));
  const isGiving = b => /tithe|giving|offering|donat|charit|missions?\b/i.test(b.name || '');
  // a common guide for a paycheck: needs under half, wants under 30%, and 20% or more saved
  const MG = { give: { name: 'Giving' }, need: { name: 'Needs', aim: ['under', 0.5] }, want: { name: 'Wants', aim: ['under', 0.3] }, save: { name: 'Saved', aim: ['over', 0.2] }, other: { name: 'Other' } };
  const MG_ORDER = ['give', 'need', 'want', 'save', 'other'];
  // This month and the ones ahead are a plan: every bill counts whether it's paid yet or not, and each spending category
  // counts at its limit (or what's been spent, once that's more). What's left is yours even if every limit gets used.
  // A month gone by shows what really went out.
  function moneyModel(mk) {
    const cur = curMk(), future = mk > cur, plan = mk >= cur, mod = modelFor(mk), tot = monthTotals(mod), rows = [], subs = [];
    for (const l of mod.lines) {
      const spent = l.amount || 0, v = l.group === 'cat' && plan ? Math.max(l.limit || 0, spent) : spent;
      if (!v) continue;
      const done = DUE.has(l.st) ? 0 : l.group === 'cat' ? spent : v;
      if (l.group === 'sub') { subs.push({ ...l, amount: v, done }); continue; }
      let g = 'other', sub = '', go = null;
      if (l.group === 'save') { g = 'save'; go = 'savings'; }
      else if (l.group === 'bill' || l.group === 'loan') {
        const b = billById(l.id);
        g = b && isGiving(b) ? 'give' : 'need'; go = l.group === 'loan' ? 'loans' : 'bills';
        sub = l.st === 'paid' ? `Paid${l.at ? ' ' + shortDay.format(l.at) : ''}` : l.st === 'late' ? `Due ${shortDay.format(l.at)} · no charge seen` : l.st === 'unseen' ? 'No charge seen'
          : l.st === 'before' ? shortDay.format(l.at) : l.at ? `Due ${shortDay.format(l.at)}` : 'No day set';
      } else if (l.group === 'cat') {
        const c = bucket(l.id), lim = l.limit || 0;
        g = c && isNeed(c) ? 'need' : 'want'; go = 'spending';
        sub = !plan ? (lim ? `${fmtShort(lim)} limit` : 'No limit') : !lim ? `${fmt(spent)} so far · no limit` : spent > lim ? `${fmt(spent)} spent · ${fmtShort(spent - lim)} over the limit` : `${fmt(spent)} of ${fmtShort(lim)} spent`;
      }
      else if (l.group === 'goal') { sub = 'Paid from a savings goal'; go = 'savings'; }
      else if (l.group === 'wait') sub = 'Still to approve';
      rows.push({ id: l.id, g, name: l.name, sub, v, done, go, wait: l.group === 'wait' });
    }
    if (subs.length) {
      const top = subs.slice().sort((a, b) => b.amount - a.amount);
      rows.push({ id: '_subs', g: 'want', name: `Subscriptions · ${subs.length}`, sub: top.slice(0, 3).map(x => x.name).join(', ') + (top.length > 3 ? ` and ${top.length - 3} more` : ''),
        v: subs.reduce((t, x) => t + x.amount, 0), done: subs.reduce((t, x) => t + x.done, 0), go: 'bills' });
    }
    const sums = {};
    for (const g of MG_ORDER) sums[g] = rows.filter(r => r.g === g).reduce((t, r) => t + r.v, 0);
    const used = rows.reduce((t, r) => t + r.v, 0), ahead = mod.pays.filter(p => p.st === 'expected' || p.st === 'waiting').length;
    // each paycheck before taxes (a twenty-fourth of the salary, twice a month), and what taxes held back from it
    let taxes = 0, taxesDone = 0;
    for (const p of mod.pays) {
      const inc = incById(p.incId), g = inc && inc.salary ? Math.round(inc.salary / checksPerYear(inc)) : 0, t = Math.max(0, g - (p.amount || 0));
      taxes += t; if (p.st === 'got' || p.st === 'before') taxesDone += t;
    }
    return { mk, future, plan, inAll: tot.inAll, gross: tot.inAll + taxes, taxes, taxesDone, rows, used, left: tot.inAll - used, sums, missing: mod.missing || [], pays: mod.pays.length, ahead };
  }
  function monthStep(mk) {
    const cur = curMk(), prev = mkAdd(mk, -1), next = mkAdd(mk, 1), max = mkAdd(cur, 12);
    const name = mkName(mk) + (mk.slice(0, 4) !== cur.slice(0, 4) ? ' ' + mk.slice(0, 4) : '');
    return `<div class="mg-nav" role="group" aria-label="Pick a month">
      <button type="button" class="circle" data-act="fin-month" data-for="ov" data-mk="${prev}"${prev < START ? ' disabled' : ''} aria-label="${esc(mkLong(prev))}">${ICON.back}</button>
      <span class="mg-mo">${esc(name)}</span>
      <button type="button" class="circle" data-act="fin-month" data-for="ov" data-mk="${next}"${next > max ? ' disabled' : ''} aria-label="${esc(mkLong(next))}">${ICON.chev}</button>
      ${mk !== cur ? `<button type="button" class="link" data-act="fin-month" data-for="ov" data-mk="${cur}">Now</button>` : ''}</div>`;
  }
  function moneyCard(mk) {
    const m = moneyModel(mk), base = m.gross || m.inAll, pct = v => (base ? pctText(v / base) : '');
    const leftName = m.plan ? 'Left after everything' : 'Left over';
    // the whole paycheck as one bar: taxes, giving, needs, wants, saved, and what's left (or how short it comes)
    const parts = [];
    if (m.taxes) parts.push({ k: 'tax', name: 'Taxes', v: m.taxes });
    for (const g of MG_ORDER) if (m.sums[g] > 0) parts.push({ k: g, name: MG[g].name, v: m.sums[g] });
    if (m.left > 0) parts.push({ k: 'left', name: 'Left', v: m.left });
    else if (m.left < 0) parts.push({ k: 'short', name: 'Short', v: -m.left });
    const seg = p => `<span class="mg-seg g-${p.k}" style="flex-grow:${p.v}" title="${esc(`${p.k === 'short' ? 'Short by' : p.name + ':'} ${fmt(p.v)}${p.k === 'short' ? '' : ', ' + pct(p.v)}`)}">
        <span class="mg-sv"><b>${p.k === 'short' ? '−' + esc(dollars(p.v)) : esc(pct(p.v))}</b><small>${p.k === 'short' ? 'short' : esc(dollars(p.v))}</small><i>${esc(p.name)}</i></span></span>`;
    const say = `${fmt(base)} pay before taxes. ` + parts.map(p => p.k === 'short' ? `short by ${fmt(p.v)}` : `${p.name} ${fmt(p.v)} (${pct(p.v)})`).join(', ');
    const legend = parts.map(p => (p.k === 'short' ? `<span class="short"><i class="mg-key g-short"></i>Short ${esc(dollars(p.v))}</span>` : `<span><i class="mg-key g-${p.k}"></i>${esc(p.name)}</span>`)).join('');
    // 50/30/20, measured on what's left of the pay once taxes and giving are out
    const room = m.inAll - m.sums.give;
    const rule = g => {
      const f = room > 0 ? m.sums[g] / room : null, [how, aim] = MG[g].aim, a = Math.round(aim * 100);
      const ok = f == null ? null : how === 'under' ? f <= aim : f >= aim;
      return `<span class="mg-c${ok ? ' ok' : ok === false && how === 'under' ? ' bad' : ''}">${ok ? ICON.check : ok === false && how === 'under' ? ICON.warn : ''}<b>${MG[g].name} ${f == null ? '—' : esc(pctText(f))}</b><small>${how === 'under' ? 'under' : 'at least'} ${a}%</small></span>`;
    };
    const row = r => {
      const go = r.wait ? 'data-act="fin-todo"' : r.go ? `data-act="fin-sub" data-sub="${r.go}"${r.go === 'spending' ? ` data-mk="${mk}"` : ''}` : 'disabled';
      return `<button type="button" class="mg-r" ${go}><span class="mg-n"><b>${esc(r.name)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span><span class="num">${esc(fmt(r.v))}</span><span class="pct">${esc(pct(r.v))}</span>
        <span class="mg-bar" aria-hidden="true">${r.done ? `<i class="g-${r.g}" style="width:${Math.max(0.6, r.done / base * 100).toFixed(2)}%"></i>` : ''}${r.v > r.done ? `<i class="g-${r.g} rest" style="width:${Math.max(0.6, (r.v - r.done) / base * 100).toFixed(2)}%"></i>` : ''}</span></button>`;
    };
    const head = (k, name, v) => `<div class="mg-gh"><span><i class="mg-key g-${k}"></i>${name}</span><span class="num">${esc(fmt(v))}</span><span class="pct">${esc(pct(v))}</span></div>`;
    const taxRows = m.taxes ? `<div class="mg-grp">${head('tax', 'Taxes', m.taxes)}${row({ g: 'tax', name: 'Held back from your pay', sub: `${m.pays} ${m.pays === 1 ? 'paycheck' : 'paychecks'} · Social Security, Medicare, federal and state`, v: m.taxes, done: m.taxesDone })}</div>` : '';
    const groups = MG_ORDER.filter(g => m.rows.some(r => r.g === g)).map(g => `<div class="mg-grp">${head(g, MG[g].name, m.sums[g])}
        ${m.rows.filter(r => r.g === g).sort((a, b) => b.v - a.v).map(row).join('')}</div>`).join('');
    const leftRow = m.inAll ? `<div class="mg-left${m.left < 0 ? ' over' : ''}"><span>${m.left < 0 ? (m.plan ? 'Short if you use every limit' : 'More than came in') : leftName}</span><span class="num">${esc(signed(m.left))}</span><span class="pct">${m.left > 0 ? esc(pct(m.left)) : ''}</span></div>` : '';
    const miss = m.missing.length ? `<p class="mg-miss">${ICON.warn}<span><b>${esc(m.missing.map(x => x.name).join(', ').replace(/, ([^,]*)$/, ' and $1'))}</b> ${m.missing.length === 1 ? 'has' : 'have'} no amount yet, so ${m.missing.length === 1 ? 'it isn’t' : 'they aren’t'} counted here.</span>${canSave() ? '<button type="button" class="link" data-act="fin-sub" data-sub="bills">Add on Bills</button>' : ''}</p>` : '';
    const inSub = [m.taxes ? `before taxes · ${fmt(m.inAll)} take-home` : m.future ? 'coming in' : 'take-home', m.ahead ? `${m.ahead} ${m.ahead === 1 ? 'paycheck' : 'paychecks'} still to come` : ''].filter(Boolean).join(' · ');
    return `<article class="float mg">
      <div class="mg-head"><span class="lab">Where it goes</span>${monthStep(mk)}</div>
      <div class="mg-in"><span class="fig">${big(base)}</span><span class="meta">${esc(inSub)}</span></div>
      ${base || m.used ? `<div class="mg-stack" role="img" aria-label="${esc(say)}">${parts.map(seg).join('')}</div>
      <div class="mg-legend" aria-hidden="true">${legend}</div>
      ${room > 0 ? `<div class="mg-rule"><span class="mg-rl">50/30/20 of the ${esc(dollars(room))} left after taxes${m.sums.give ? ' and giving' : ''}</span><div class="mg-cs">${rule('need')}${rule('want')}${rule('save')}</div></div>` : ''}
      ${m.plan ? '<p class="mg-guide">Every bill and spending limit counts in full, so what’s left is yours even if you use every limit. On each line, solid is already paid and faded is still to come.</p>' : ''}
      ${miss}<div class="mg-list">${taxRows}${groups}${leftRow}</div>` : `<p class="empty">Nothing in ${esc(mkName(mk))} yet.</p>`}
    </article>`;
  }

  /* ---------- savings, at a glance ---------- */
  function saveCard(mk) {
    const accts = savingsAccounts();
    if (!accts.length) return '';
    const total = accts.reduce((t, a) => t + acctBalance(a), 0), saved = monthTotals(modelFor(mk)).saved;
    const first = g => (/emergenc/i.test(g.name) ? 0 : 1);
    const goals = kind('goal').filter(g => !g.example).sort((a, b) => first(a) - first(b) || slotOf(a) - slotOf(b) || byCreated(a, b));
    const rows = goals.map(g => {
      const left = catLeft(g), target = goalTarget(g), f = target ? clamp(left / target, 0, 1) : null;
      return `<button type="button" class="sv-r" data-act="fin-sub" data-sub="savings">
        <span class="sv-n">${esc(g.name)}</span><span class="num">${esc(fmt(left))}${target ? `<small> of ${esc(fmtShort(target))}</small>` : ''}</span>
        ${target ? `<span class="sv-bar" role="img" aria-label="${esc(`${Math.round(f * 100)}% of ${fmt(target)}`)}"><i style="width:${(f * 100).toFixed(1)}%"></i></span>` : ''}</button>`;
    }).join('');
    return `<article class="float sv">
      <div class="sv-head"><span class="lab">Savings</span>${saved ? `<span class="sv-in">+${esc(fmt(saved))} in ${esc(mkName(mk))}</span>` : ''}</div>
      <span class="fig sv-fig">${big(total)}</span>
      ${rows ? `<div class="sv-list">${rows}</div>` : ''}
    </article>`;
  }

  // the overview: how you're doing, in pictures. The month arrows move what it went on, its days and its pay together.
  function vHome() {
    const todo = inbox(), pays = payNotes(), mk = ovMk();
    const appr = todo.length ? `<section class="sec" id="finTodo"><span class="lab">Needs approval · ${todo.length}</span><div class="stack">${todo.map(chargeCard).join('')}</div></section>` : '';
    return `<div class="ov3">
      ${todo.length ? `<div class="ov-top"><button type="button" class="btn ov-todo" data-act="fin-todo">${todo.length} to approve</button></div>` : ''}
      ${pays ? `<div class="stack">${pays}</div>` : ''}
      <div class="ov-cols">
        <div class="ov-l">${worthCard()}${moneyCard(mk)}${payCard(mk)}</div>
        <div class="ov-r">${acctList()}${saveCard(mk)}${heatCal(mk)}${dayCard(mk)}</div>
      </div>
      ${appr}
    </div>${examplesBar()}`;
  }

  // A list of bills for layouts, filtered. filter.status: 'upcoming' (not paid, due or late this month, or due within
  // filter.days, default 31), 'late', 'unpaid', 'paid', or 'all' (default); filter.group: 'bill' or 'sub'; filter.days.
  function billsWidget(f) {
    const status = ['upcoming', 'late', 'unpaid', 'paid', 'all'].includes(f.status) ? f.status : 'all';
    const days = f.days > 0 ? Math.min(f.days, 366) : status === 'upcoming' ? 31 : null;
    const horizon = days ? startOfDay(Date.now()) + days * DAY : null;
    const ok = (b, s) => {
      if (f.group === 'bill' || f.group === 'sub') { if (groupOf(b) !== f.group) return false; }
      if (status === 'late') return s.st === 'late';
      if (status === 'paid') return s.st === 'paid';
      if (status === 'unpaid' && s.st === 'paid') return false;
      if (status === 'upcoming' && !['soon', 'waiting', 'late', 'next'].includes(s.st)) return false;
      if (horizon && status !== 'all' && s.due && s.due > horizon) return false;
      return true;
    };
    const list = S.bills.map(b => ({ b, s: billState(b) })).filter(x => ok(x.b, x.s)).sort((x, y) => (x.s.due || 9e15) - (y.s.due || 9e15) || byDay(x.b, y.b));
    const what = f.group === 'sub' ? 'Subscriptions' : f.group === 'bill' ? 'Bills' : 'Bills and subscriptions';
    const label = { upcoming: `Upcoming · next ${days} days`, late: 'Late', unpaid: 'Not paid yet', paid: 'Paid this month', all: '' }[status];
    const total = list.reduce((t, x) => t + (x.b.amount || 0), 0);
    return `<section class="sec"><div class="sec-head"><span class="lab">${esc(what)}${label ? ' · ' + esc(label) : ''}${list.length ? ' · ' + fmt(total) : ''}</span></div>
      <div class="float list">${list.length ? list.map(x => billRow(x.b)).join('') : '<p class="empty">Nothing here right now.</p>'}</div></section>`;
  }
  // the overview's cards by name, for a layout row (layout.js). Each takes the row's filter and size.
  function widgets() {
    const mk = ovMk();
    return {
      'fin.approve': { render: () => { const todo = inbox(); return todo.length ? `<section class="sec" id="finTodo"><span class="lab">Needs approval · ${todo.length}</span><div class="stack">${todo.map(chargeCard).join('')}</div></section>` : ''; } },
      'fin.pay-notes': { render: () => { const p = payNotes(); return p ? `<div class="stack">${p}</div>` : ''; } },
      'fin.worth': { render: () => worthCard() },
      'fin.money': { render: () => moneyCard(mk) },
      'fin.pay': { render: () => payCard(mk) },
      'fin.accounts': { render: () => acctList() },
      'fin.saving': { render: () => saveCard(mk) },
      'fin.heat': { render: () => heatCal(mk) },
      'fin.day': { render: () => dayCard(mk) },
      'fin.bill-line': { render: () => billLine() },
      'fin.bills': { render: f => billsWidget(f) },
    };
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
    const where = [renewText(b), b.accountId ? acctLabel(a) : 'No account yet'].join(' · ');
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
    const per = l => l.reduce((t, b) => t + perMonth(b), 0); // a yearly one counts a twelfth each month
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
      ${billLine()}
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
    const items = g.items || [], sell = g.mode === 'sell';
    const rows = items.map(i => `<div class="li${i.got ? ' got' : ''}">
        <button type="button" class="b-chk" data-act="fin-item-got" data-id="${esc(g.id)}" data-item="${esc(i.id)}" aria-pressed="${!!i.got}" aria-label="${i.got ? (sell ? 'Not gone yet' : 'Not bought yet') : (sell ? 'Sold or given away' : 'Bought')}: ${esc(i.name)}">${ICON.check}</button>
        <button type="button" class="li-main" data-act="fin-form" data-form="item" data-id="${esc(g.id)}" data-item="${esc(i.id)}"${canSave() ? '' : ' disabled'}>
          <span class="li-n">${esc(i.name)}</span>${i.price ? `<span class="fig li-p">${fmt(i.price)}</span>` : `<span class="li-none">${sell ? 'Add asking price' : 'Add price'}</span>`}
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

  // lists that aren't savings: things to buy someday, things to sell or give away
  function vLists() {
    const lists = kind('list');
    const card = g => {
      const sell = g.mode === 'sell', items = g.items || [], open = items.filter(i => !i.got), done = items.filter(i => i.got);
      const sum = open.reduce((t, i) => t + (i.price || 0), 0), unpriced = open.filter(i => !i.price).length, doneSum = done.reduce((t, i) => t + (i.price || 0), 0);
      const meta = [`${open.length} ${sell ? 'still to go' : 'still to buy'}`, unpriced ? `${unpriced} without a price` : null,
        done.length ? `${done.length} ${sell ? 'gone' : 'bought'}${doneSum ? ' for ' + fmt(doneSum) : ''}` : null].filter(Boolean).join(' · ');
      return `<section class="sec"><div class="sec-head"><span class="lab">${esc(g.name)}</span>${canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="list" data-id="${esc(g.id)}" aria-label="Edit ${esc(g.name)}">${ICON.edit}</button>` : ''}</div>
        <div class="float fl-card">
          <div class="fl-top"><span class="fig lg">${big(sum)}</span><span class="meta">${sell ? (sum ? 'if it all sells at its asking price' : 'Add asking prices to see what it could bring in') : (sum ? 'for what still needs buying' : 'Add prices to see what it adds up to')}</span><span class="meta">${esc(meta)}</span></div>
          ${listItems(g)}
        </div></section>`;
    };
    return `<div class="fin-page wide">${lists.length ? `<div class="fl-grid">${lists.map(card).join('')}</div>` : '<p class="empty">No lists yet. A list keeps things to buy, or to sell, with their prices, apart from your savings.</p>'}
      ${canSave() ? '<div><button type="button" class="btn" data-act="fin-form" data-form="list">New list</button></div>' : ''}</div>`;
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

  // a month in a category: what's been spent, building day by day; with a limit, the even pace to it (dashed)
  function spendChart(l, charges, mk) {
    const cur = curMk(), [y, mo] = mkParts(mk), dim = new Date(y, mo + 1, 0).getDate(), lim = limitFor(l, mk);
    const today = mk === cur ? new Date().getDate() : dim, byDay = new Array(dim + 1).fill(0);
    for (const t of charges) byDay[new Date(t.at).getDate()] += t.amount;
    const pts = [[0, 0]];
    let cum = 0;
    for (let d = 1; d <= today; d++) { if (byDay[d]) { pts.push([d - 1 + 0.5, cum]); cum += byDay[d]; pts.push([d - 1 + 0.5, cum]); } }
    pts.push([today, cum]);
    const top = Math.max(lim || 0, cum, 1) * 1.08, W = 300, H = 56;
    const X = d => (d / dim * W).toFixed(1), Y = v => (H - 2 - v / top * (H - 6)).toFixed(1);
    const line = pts.map(([d, v], i) => `${i ? 'L' : 'M'}${X(d)},${Y(v)}`).join('');
    const area = `${line}L${X(today)},${H}L0,${H}Z`;
    const pace = lim ? `<path class="pace" d="M0,${Y(0)}L${W},${Y(lim)}" vector-effect="non-scaling-stroke"/><path class="cap" d="M0,${Y(lim)}H${W}" vector-effect="non-scaling-stroke"/>` : '';
    return `<div class="s-chart" aria-hidden="true"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${pace}<path class="fill" d="${area}"/><path class="line" d="${line}" vector-effect="non-scaling-stroke"/></svg>
      <i class="s-dot" style="left:${(today / dim * 100).toFixed(2)}%;top:${(Number(Y(cum)) / H * 100).toFixed(2)}%"></i>
      <div class="axis"><span>${esc(shortDay.format(new Date(y, mo, 1)))}</span><span>${esc(shortDay.format(new Date(y, mo, dim)))}</span></div></div>`;
  }
  // where a month's spending went, category by category
  function spendSplit(limits, mk) {
    const cur = curMk(), parts = limits.map(l => ({ l, v: limitSpent(l, mk) })).filter(p => p.v > 0).sort((a, b) => b.v - a.v);
    const total = parts.reduce((t, p) => t + p.v, 0), when = mk === cur ? 'this month' : `in ${mkName(mk)}`;
    if (!total) return `<div class="hero"><span class="fig xl">${fmt(0)}</span><span class="meta">Nothing spent in your categories ${esc(when)}${mk === cur ? ' yet' : ''}.</span>${limits.length ? dailyBars(limits, mk) : ''}</div>`;
    const op = i => [1, .72, .5, .34, .24, .17, .12, .09][Math.min(i, 7)];
    return `<div class="hero"><div class="s-top"><span class="lab">Spent ${esc(when)}</span><span class="fig xl">${big(total)}</span></div>
      <div class="split" role="img" aria-label="${esc(parts.map(p => `${p.l.name} ${fmt(p.v)}`).join(', '))}">${parts.map((p, i) => `<span class="seg" style="width:${(p.v / total * 100).toFixed(2)}%;opacity:${op(i)}"></span>`).join('')}</div>
      <div class="s-legend">${parts.map((p, i) => `<span><i class="dot" style="opacity:${op(i)}"></i>${esc(p.l.name)} <b>${fmt(p.v)}</b> <small>${Math.round(p.v / total * 100)}%</small></span>`).join('')}</div>
      <div class="rings">${limits.map(l => ring(l, mk)).join('')}</div>${dailyBars(limits, mk)}</div>`;
  }
  function limitRow(l, mk) {
    const cur = curMk(), now = mk === cur, charges = limitCharges(l, mk), lim = limitFor(l, mk);
    const spent = charges.reduce((s, t) => s + t.amount, 0), open = S.open.has(l.id + mk);
    // what's already set for next month, when it differs
    const nx = mkAdd(cur, 1), nxLim = limitFor(l, nx), ahead = now && nxLim !== lim ? `<span class="pill">${esc(mkName(nx))}: ${nxLim ? esc(fmtShort(nxLim)) : 'no limit'}</span>` : '';
    const foot = `<div class="l-foot">
        ${charges.length ? `<button type="button" class="link" data-act="fin-toggle" data-id="${esc(l.id + mk)}" aria-expanded="${open}">${open ? 'Hide' : 'Show'} ${charges.length} ${charges.length === 1 ? 'charge' : 'charges'}</button>` : `<span>No charges ${now ? 'this month' : 'in ' + esc(mkName(mk))}</span>`}
        ${now && canSave() ? `<button type="button" class="link" data-act="fin-form" data-form="limit" data-id="${esc(l.id)}" data-mk="${mk}">Edit</button>` : ''}${ahead}
      </div>
      ${open && charges.length ? `<div class="mini">${charges.map(t => `<div><span>${esc(t.merchant)} · ${esc(shortDay.format(t.at))}</span><span class="num">${fmt(t.amount)}</span></div>`).join('')}</div>` : ''}`;
    if (!lim) return `<div class="row limit tracking">
        <div class="l-head"><div><span class="name">${esc(l.name)}${exTag(l)}</span><span class="meta">${now ? 'This month' : esc(mkName(mk))} · no limit set</span></div><span class="fig lg">${fmt(spent)}</span></div>
        ${spendChart(l, charges, mk)}${foot}
      </div>`;
    const left = lim - spent, ratio = spent / lim, state = left < 0 ? 'over' : ratio >= 0.85 ? 'near' : '';
    return `<div class="row limit ${state}">
      <div class="l-head">
        <div><span class="name">${esc(l.name)}${exTag(l)} ${state === 'over' ? '<span class="pill over">Over</span>' : state === 'near' && now ? '<span class="pill near">Almost out</span>' : ''}</span>
        <span class="meta num">${fmt(spent)} of ${fmt(lim)}</span></div>
        <span class="fig lg"${left < 0 ? ' style="color:var(--bad)"' : ''}>${left < 0 ? '−' + fmt(-left) : fmt(left)}${now ? '' : `<small class="l-was">${left < 0 ? 'over' : 'under'}</small>`}</span>
      </div>
      <div class="meter" role="img" aria-label="${esc(fmt(spent) + ' spent of ' + fmt(lim))}"><span style="width:${Math.min(100, ratio * 100).toFixed(2)}%"></span></div>
      ${spendChart(l, charges, mk)}${foot}
    </div>`;
  }
  // back and forth through the months: the ones gone by, this one, and ones ahead to plan
  function monthNav(which, mk) {
    const cur = curMk(), prev = mkAdd(mk, -1), next = mkAdd(mk, 1), max = mkAdd(cur, 12);
    const tag = mk === cur ? 'This month' : mk > cur ? 'Planning ahead' : 'Gone by';
    return `<div class="mo-nav" role="group" aria-label="Pick a month">
      <button type="button" class="circle mo-prev" data-act="fin-month" data-for="${which}" data-mk="${prev}"${prev < START ? ' disabled' : ''} aria-label="${esc(mkLong(prev))}">${ICON.back}</button>
      <span class="mo-name"><b>${esc(mkLong(mk))}</b><small>${esc(tag)}</small></span>
      <button type="button" class="circle mo-next" data-act="fin-month" data-for="${which}" data-mk="${next}"${next > max ? ' disabled' : ''} aria-label="${esc(mkLong(next))}">${ICON.chev}</button>
      ${mk !== cur ? `<button type="button" class="link mo-back" data-act="fin-month" data-for="${which}" data-mk="${cur}">Back to ${esc(mkName(cur))}</button>` : ''}
    </div>`;
  }
  // a month ahead: each category's limit for it, ready to lower (or raise) before the month starts
  function planView(mk, limits) {
    const prev = mkAdd(mk, -1), total = limits.reduce((t, l) => t + (limitFor(l, mk) || 0), 0), was = limits.reduce((t, l) => t + (limitFor(l, prev) || 0), 0);
    const diff = total - was, inAll = monthTotals(monthModel(mk)).inAll;
    const rows = limits.map(l => {
      const v = limitFor(l, mk), p = limitFor(l, prev);
      const change = v === p ? `Same as ${mkName(prev)}` : !v ? `No limit (${fmtShort(p)} in ${mkName(prev)})` : !p ? 'A limit starts this month' : `${v < p ? '−' : '+'}${fmtShort(Math.abs(v - p))} from ${mkName(prev)}`;
      return `<button type="button" class="pl-row${v !== p ? ' changed' : ''}" data-act="fin-form" data-form="limit" data-id="${esc(l.id)}" data-mk="${mk}"${canSave() ? '' : ' disabled'} aria-label="${esc(`${l.name}: ${v ? fmt(v) : 'no limit'} in ${mkName(mk)}, ${change}. Change it`)}">
        <span class="pl-n"><b>${esc(l.name)}</b><small>${esc(change)}</small></span>
        <span class="fig md">${v ? esc(fmt(v)) : '<span class="b-none">No limit</span>'}</span>${ICON.edit}</button>`;
    }).join('');
    return `<div class="fin-page">${monthNav('sp', mk)}
      <div class="hero"><div class="s-top"><span class="lab">Limits for ${esc(mkName(mk))}</span><span class="fig xl">${big(total)}</span>
        <span class="meta">${diff ? `${esc(fmt(Math.abs(diff)))} ${diff < 0 ? 'less' : 'more'} than ${esc(mkName(prev))}` : `The same as ${esc(mkName(prev))}`}${inAll ? ` · ${pctText(total / inAll)} of the ${esc(fmt(inAll))} coming in` : ''}</span></div></div>
      <section class="sec"><span class="lab">Tap one to change it for ${esc(mkName(mk))}</span><div class="float list pl-list">${rows || '<p class="empty">No spending categories yet.</p>'}</div>
        <p class="meta pl-how">A change carries on into the months after it, until you change it again. ${esc(mkName(mkAdd(mk, 1)))} starts from ${esc(mkName(mk))}’s limits.</p></section></div>`;
  }
  function vSpending() {
    const cur = curMk(), mk = S.spMk && S.spMk >= START ? S.spMk : cur, limits = kind('limit');
    if (mk > cur) return planView(mk, limits);
    const [y, m] = mkParts(mk), end = mkRange(mk)[1];
    const shown = limits.filter(l => (l.createdAt || 0) < end || limitSpent(l, mk));
    const daysLeft = new Date(y, m + 1, 0).getDate() - new Date().getDate();
    const head = mk === cur ? `${mkName(mk)} · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left` : `${mkLong(mk)} · how it went`;
    // each category is its own card
    return `<div class="fin-page wide">${monthNav('sp', mk)}${spendSplit(shown, mk)}<section class="sec"><span class="lab">${esc(head)}</span>
      <div class="s-cards">${shown.map(l => `<div class="float s-card" data-card="${esc(l.id)}">${limitRow(l, mk)}</div>`).join('')}${mk === cur && canSave() ? `<button type="button" class="float s-card s-add" data-act="fin-form" data-form="limit">${ICON.plus}<span>New category</span></button>` : ''}</div></section>
      ${mk === cur && limits.length ? `<div class="plan-next"><span class="meta">Want to spend less next month? Set ${esc(mkName(mkAdd(cur, 1)))}’s limits now.</span><button type="button" class="btn" data-act="fin-month" data-for="sp" data-mk="${mkAdd(cur, 1)}">Plan ${esc(mkName(mkAdd(cur, 1)))}</button></div>` : ''}</div>`;
  }

  function vActivity() {
    const all = S.txns.slice().sort((a, b) => b.at - a.at), accounts = sorted(S.accounts);
    // the accounts, each with its balance over the last few weeks
    const accts = `<section class="sec"><div class="sec-head"><span class="lab">Accounts</span>${canSave() ? `<button type="button" class="circle" data-act="fin-form" data-form="account" aria-label="Add account">${ICON.plus}</button>` : ''}</div>
      ${accounts.length ? `<div class="acct-grid">${accounts.map(accountCard).join('')}</div>` : '<p class="empty">No accounts yet. Add checking, savings and your credit card with today’s balance from Regions.</p>'}${mailLine()}</section>`;
    if (!all.length) return `<div class="fin-page">${accts}<p class="empty">No charges or deposits yet. Tap + to add one.</p></div>`;
    let h = accts, day = '', rows = '';
    const flush = () => { if (rows) h += `<section class="sec"><span class="lab">${esc(day)}</span><div class="float list">${rows}</div></section>`; rows = ''; };
    for (const t of all) {
      const d = dayFmt.format(t.at);
      if (d !== day) { flush(); day = d; }
      const label = bucketLabel(t);
      const pill = !isOut(t) ? `<span class="pill">${t.payId ? 'Paycheck' : isTransfer(t) ? 'Transfer' : 'Deposit'}</span>` : label ? `<span class="pill">${esc(label)}</span>` : '<span class="pill todo">Needs approval</span>';
      rows += `<button type="button" class="tx" data-act="fin-form" data-form="charge" data-id="${esc(t.id)}">
        <span class="name">${esc(t.merchant)}${exTag(t)}</span>
        <span class="fig md t-amt ${isOut(t) ? '' : 'in'}">${isOut(t) ? '' : '+'}${fmt(t.amount)}</span>
        <span class="t-sub meta">${esc(timeFmt.format(t.at))} · ${esc(acctLabel(acct(t.accountId)))} ${pill}</span>
      </button>`;
    }
    flush();
    return `<div class="fin-page">${h}</div>`;
  }

  const views = { home: vHome, bills: vBills, loans: vLoans, savings: vSavings, lists: vLists, spending: vSpending, activity: vActivity };
  const counts = () => { const nSav = savingsToSort().length, nBills = billAlerts().length; return { home: inbox().length + nSav + nBills, savings: nSav, bills: nBills }; };

  // the sections, for POS's sidebar
  const SIDE_IC = {
    home: '<path d="M4.5 5.5h6v6h-6zM13.5 5.5h6v3.5h-6zM13.5 12h6v6.5h-6zM4.5 14.5h6v4h-6z"/>',
    bills: '<path d="M6.5 3.5h11v17l-2.75-1.6-2.75 1.6-2.75-1.6-2.75 1.6z"/><path d="M9.5 8h5M9.5 11.5h5M9.5 15h3"/>',
    loans: '<circle cx="8" cy="8" r="2.3"/><circle cx="16" cy="16" r="2.3"/><path d="M17.5 6.5l-11 11"/>',
    savings: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V8M12 16v-.8M7 19v1.5M17 19v1.5"/>',
    lists: '<path d="M10 7h9.5M10 12h9.5M10 17h9.5"/><path d="M4.5 7l1.2 1.2L7.5 6M4.5 12l1.2 1.2 1.8-2.2M4.5 17l1.2 1.2 1.8-2.2"/>',
    spending: '<path d="M4.5 8A2 2 0 0 1 6.5 6h10v2.5"/><rect x="4.5" y="8.5" width="15" height="10" rx="2"/><path d="M15.5 13.5h2"/>',
    activity: '<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>',
  };
  function side() {
    const n = S.loaded ? counts() : {};
    return { label: 'Finance', act: 'fin-sub', current: S.sub,
      items: Object.entries(SUBS).map(([key, label]) => ({ key, label, badge: n[key] || 0, icon: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${SIDE_IC[key] || ''}</svg>` })) };
  }

  function view() {
    charts.clear();
    let body;
    if (S.failed) body = '<p class="empty">Your finances did not load. Check the connection; ' + posName() + ' tries again when you come back to it.</p>';
    else if (!S.loaded) body = '<p class="empty">Loading your accounts and categories…</p>';
    else {
      // the Overview follows a layout row when this device has one (layout.js); otherwise it's built in
      const L = S.sub === 'home' && ctx.layout && ctx.layout();
      body = (L && L.render('finance', widgets())) || views[S.sub]();
    }
    return `<div class="fin"><div class="fin-scroll" id="finScroll" data-keep>${body}</div></div>`;
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
    if (!g || !key || GENERIC.test(key) || !/[a-z]{3,}/.test(key)) return;
    // remembered only to suggest it next time ("usual"; the older "merchants" list sorted on its own and is no longer read)
  // one place belongs to one category: take it off any other
    for (const o of S.buckets.filter(x => x.id !== g.id && (x.usual || []).includes(key))) await save(refs.buckets.doc(o.id).update({ usual: o.usual.filter(k => k !== key) }));
    if (!(g.usual || []).includes(key)) await save(refs.buckets.doc(g.id).update({ usual: [...(g.usual || []), key] }));
  }
  // the category you put this place in last time (a name with letters in it, never a bare card or phone number)
  const usualFor = t => { const key = merchantKey(t.merchant); return key && /[a-z]{3,}/.test(key) && !GENERIC.test(key) ? S.buckets.find(b => (b.usual || []).includes(key)) || null : null; };
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
    const tm = new Date(t.at), mk = yearly(b) && dueOn(b, tm.getFullYear(), tm.getMonth()) == null ? monthKeyOf(tm.getFullYear(), tm.getMonth()) : nearestMonth(b, t.at), day = tm.getDate(), learned = [];
    const patch = { paid: { ...(b.paid || {}), [mk]: { at: t.at, txnId: t.id, auto: !!auto } } };
    if (yearly(b) && b.month !== +mk.slice(5)) { patch.month = +mk.slice(5); learned.push(`${monthFmt.format(tm)} each year`); }
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
  // checks a bill off for a month (this one, unless the overview is showing another)
  async function togglePaid(id, forMk) {
    const b = billById(id);
    if (!b) return;
    const mk = /^\d{4}-\d{2}$/.test(forMk || '') ? forMk : curMk(), [y, m] = mkParts(mk), month = mkName(mk);
    if (yearly(b) && dueOn(b, y, m) == null) { const d = dueAfter(b, y, m); toast(`${b.name} renews ${d ? shortDay.format(d) + ', ' + new Date(d).getFullYear() : 'once a year'}`); return; }
    const before = { ...(b.paid || {}) }, paid = { ...before };
    const was = !!paid[mk];
    if (was) delete paid[mk]; else paid[mk] = { at: Date.now() };
    if (await save(refs.bills.doc(id).update({ paid })))
      toast(was ? `${b.name} is no longer checked off for ${month}` : `${b.name} checked off for ${month}`, () => save(refs.bills.doc(id).update({ paid: before })));
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
  // what a deposit is: one of your paychecks, other money in, or a move between your own accounts
  function inKindOptions(t) {
    const sel = !t ? 'other' : payOf(t) ? 'pay:' + payOf(t) : isTransfer(t) ? 'transfer' : 'other';
    return S.income.map(inc => opt('pay:' + inc.id, S.income.length > 1 ? `Paycheck · ${inc.name}` : 'Paycheck', sel === 'pay:' + inc.id)).join('')
      + opt('other', 'Other money in (a refund, a sale)', sel === 'other') + opt('transfer', 'A move between my accounts', sel === 'transfer');
  }
  // the payday a deposit made by hand belongs to: the nearest one
  function nearestPayday(inc, at) {
    const d = new Date(at), list = [-1, 0, 1].flatMap(o => paydays(inc, monthKeyOf(d.getFullYear(), d.getMonth() + o)));
    return list.length ? list.sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0].key : dkey(at);
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
      const accounts = sorted(S.accounts.filter(a => !isThing(a) || (t && t.accountId === a.id)));
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
          + `<div id="ff_bucket_wrap"${dir === 'in' ? ' hidden' : ''}>${field('Where it goes', `<select id="ff_bucket">${bucketOptions(accountId, t ? t.bucketId : null)}</select>`)}</div>`
          + `<div id="ff_in_wrap"${dir === 'out' ? ' hidden' : ''}>${field('What it is', `<select id="ff_inkind">${inKindOptions(t)}</select>`, 'A paycheck counts once, on its payday. A move between your own accounts isn’t income.')}</div>`,
      };
    },
    income(id) {
      const inc = id ? incById(id) : null, every = !!(inc && inc.every === 14), days = (inc && inc.days) || [15, 30];
      const dayOpts = (sel, none) => (none ? opt('', 'None', !sel) : '') + Array.from({ length: 31 }, (_, i) => opt(String(i + 1), `The ${ordinal(i + 1)}${i + 1 >= 29 ? ' (or the last day)' : ''}`, sel === i + 1)).join('');
      const accts = [opt('', 'Any account', !(inc && inc.accountId))].concat(sorted(S.accounts.filter(a => a.type !== 'credit' && !isThing(a))).map(a => opt(a.id, acctLabel(a), !!inc && inc.accountId === a.id))).join('');
      return {
        title: inc ? 'Paycheck' : 'Add your paycheck', del: !!inc,
        body: field('From', `<input id="ff_name" autocomplete="off" maxlength="60" placeholder="Employer" value="${inc ? esc(inc.name) : ''}">`)
          + field('Take-home each paycheck', `<input id="ff_amount" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${inc && inc.amount ? plain(inc.amount) : ''}">`, 'What lands in the bank, after taxes.')
          + field('Yearly salary, before taxes', `<input id="ff_salary" class="amount" inputmode="decimal" autocomplete="off" placeholder="Optional" value="${inc && inc.salary ? plain(inc.salary) : ''}">`, 'With it, the overview shows what comes out for taxes.')
          + `<div class="seg-ctl" role="radiogroup" aria-label="How often">
              <label><input type="radio" name="ff_sched" id="ff_sched_twice" value="twice"${every ? '' : ' checked'}><span>Twice a month</span></label>
              <label><input type="radio" name="ff_sched" id="ff_sched_every" value="every"${every ? ' checked' : ''}><span>Every two weeks</span></label>
            </div>`
          + `<div id="ff_twice" class="f-two"${every ? ' hidden' : ''}>${field('Payday', `<select id="ff_day1">${dayOpts(days[0])}</select>`)}${field('And', `<select id="ff_day2">${dayOpts(days[1], true)}</select>`)}</div>`
          + `<div id="ff_every"${every ? '' : ' hidden'}>${field('A recent payday', `<input type="hidden" id="ff_anchor" value="${inc && inc.anchor ? esc(inc.anchor) : ''}"><div data-wheel="date" data-for="ff_anchor"></div>`, 'From there, every other week.')}</div>`
          + field('Lands in', `<select id="ff_acct">${accts}</select>`)
          + field('Shows on the bank as', `<input id="ff_match" autocomplete="off" maxlength="120" placeholder="Optional" value="${inc && inc.match ? esc(inc.match) : ''}">`, 'Words from the deposit, separated by commas, so it’s known as your paycheck.')
          + '<p class="where">A payday on a Saturday or Sunday comes the Friday before. When the deposit shows up, it checks that payday off instead of counting twice.</p>',
      };
    },
    account(id, extra) {
      const a = id ? acct(id) : null;
      const type = a ? a.type : (extra.type || 'checking'), thing = type === 'asset';
      return {
        title: a ? a.name : thing ? 'Something you own' : 'Add account', del: !!a,
        body: field('Name', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="${thing ? 'CR-V' : 'Checking'}" value="${a ? esc(a.name) : extra.name ? esc(extra.name) : ''}">`)
          + field('Type', `<select id="ff_type">${opt('checking', 'Checking', type === 'checking')}${opt('savings', 'Savings', type === 'savings')}${opt('credit', 'Credit card', type === 'credit')}${opt('asset', 'Something you own (car, cash)', thing)}</select>`)
          + `<div id="ff_l4wrap"${thing ? ' hidden' : ''}>${field('Card or account ending', `<input id="ff_last4" inputmode="numeric" autocomplete="off" placeholder="1234" value="${a ? esc((a.last4 || []).join(', ')) : ''}">`, 'Last 4 digits. Two cards on one account: separate with a comma.')}</div>`
          + field(thing ? 'What it’s worth today' : 'Balance right now', `<input id="ff_balance" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${a ? plain(acctBalance(a)) : ''}">`,
            `<span id="ff_balhint">${thing ? 'About what it would sell for. For a car, a private-party value from Kelley Blue Book. Update it now and then.' : 'Copy it from Regions. For a credit card, enter what you owe.'}</span>`),
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
      const g = bucket(id), i = g && extra.item ? (g.items || []).find(x => x.id === extra.item) : null, sell = g && g.mode === 'sell';
      return {
        title: i ? i.name : `Add to ${g ? g.name : 'the list'}`, del: !!i,
        body: field('Item', `<input id="ff_name" autocomplete="off" maxlength="80" placeholder="${sell ? 'Old guitar' : 'Couch'}" value="${i ? esc(i.name) : ''}">`)
          + field(sell ? 'Asking price' : 'Price', `<input id="ff_price" class="amount" inputmode="decimal" autocomplete="off" placeholder="Add it later" value="${i && i.price ? plain(i.price) : ''}">`, sell ? 'Leave it blank to give it away, or until you decide.' : 'Leave it blank until you know it; the list total adds it in then.')
          + (i ? `<label class="f-check"><input type="checkbox" id="ff_got"${i.got ? ' checked' : ''}><span>${sell ? 'Sold or given away' : 'Bought'}</span></label>` : ''),
      };
    },
    list(id) {
      const g = id ? bucket(id) : null, mode = g ? g.mode || 'buy' : 'buy';
      return {
        title: g ? g.name : 'New list', del: !!g,
        body: field('Name', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="To buy" value="${g ? esc(g.name) : ''}">`)
          + field('Kind', `<select id="ff_mode">${opt('buy', 'Things to buy', mode === 'buy')}${opt('sell', 'Things to sell or give away', mode === 'sell')}</select>`)
          + '<p class="where">Lists sit apart from your savings and spending; they only keep track of what things cost.</p>',
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
      const accts = [opt('', 'Not set', !(b && b.accountId))].concat(sorted(S.accounts.filter(a => !isThing(a) || (b && b.accountId === a.id))).map(a => opt(a.id, acctLabel(a), !!b && b.accountId === a.id))).join('');
      return {
        title: b ? b.name : group === 'sub' ? 'New subscription' : 'New bill', del: !!b,
        body: `<div class="seg-ctl" role="radiogroup" aria-label="Kind">
            <label><input type="radio" name="ff_group" id="ff_group_bill" value="bill"${group === 'bill' ? ' checked' : ''}><span>Bill</span></label>
            <label><input type="radio" name="ff_group" id="ff_group_sub" value="sub"${group === 'sub' ? ' checked' : ''}><span>Subscription</span></label>
          </div>`
          + field('Name', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="${group === 'sub' ? 'Spotify' : 'Rent'}" value="${b ? esc(b.name) : ''}">`)
          + field('Price', `<input id="ff_amount" class="amount" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${b && b.amount ? plain(b.amount) : ''}">`)
          + field('How often', `<select id="ff_every">${opt('', 'Every month', !(b && yearly(b)))}${opt('year', 'Every year', !!(b && yearly(b)))}</select>`)
          + `<div class="ff-yr"${b && yearly(b) ? '' : ' hidden'}>${field('Renews in', `<select id="ff_month">${Array.from({ length: 12 }, (_, i) => opt(String(i + 1), monthFmt.format(new Date(2000, i, 1)), (b && yearly(b) ? b.month : new Date().getMonth() + 1) === i + 1)).join('')}</select>`)}</div>`
          + field('Charged on', `<select id="ff_day">${days}</select>`, 'The day of the month. The 31st lands on the last day of shorter months.')
          + field('Comes out of', `<select id="ff_acct">${accts}</select>`)
          + field('Shows on the bank as', `<input id="ff_match" autocomplete="off" maxlength="120" placeholder="Optional" value="${b && b.match ? esc(b.match) : ''}">`, 'Words from the charge, separated by commas. The name is already looked for; these help check it off on its own.')
          + (b && !(yearly(b) && dueOn(b, now.getFullYear(), now.getMonth()) == null) ? `<label class="f-check"><input type="checkbox" id="ff_paid"${paidNow ? ' checked' : ''}><span>Paid for ${esc(month)}</span></label>` : ''),
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
    limit(id, extra) {
      const l = id ? bucket(id) : null, cur = curMk(), mk = extra.mk && extra.mk > cur ? extra.mk : cur;
      if (!l) return {
        title: 'New spending category', del: false,
        body: field('Spending on', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="Gas">`)
          + field('Limit each month', `<input id="ff_monthly" class="amount" inputmode="decimal" autocomplete="off" placeholder="No limit">`, 'Leave it blank to just track what goes here.')
          + `<label class="f-check"><input type="checkbox" id="ff_need"><span>A need, like groceries or gas. Leave it off for a want, like eating out or fun money.</span></label>`,
      };
      const prev = mkAdd(mk, -1), lim = limitFor(l, mk);
      // the changes already planned for the months after this one
      const later = Object.keys(l.months || {}).filter(k => k > mk).sort().map(k => `${mkName(k)} ${l.months[k] ? fmtShort(l.months[k]) : 'no limit'}`);
      const plans = later.length ? `<p class="where">Already planned: ${esc(later.join(', '))}. Those stay as they are.</p>` : '';
      if (mk > cur) {
        const own = l.months && mk in l.months;
        return {
          title: `${l.name} · ${mkName(mk)}`, del: false,
          body: field(`Limit for ${mkName(mk)}`, `<input id="ff_monthly" class="amount" inputmode="decimal" autocomplete="off" placeholder="Same as ${esc(mkName(prev))}${limitFor(l, prev) ? ' (' + esc(fmtShort(limitFor(l, prev))) + ')' : ''}" value="${own && lim ? plain(lim) : ''}">`,
            `Leave it blank to keep ${esc(mkName(prev))}’s. A change carries on into the months after, until you change it again.`) + plans,
        };
      }
      return {
        title: l.name, del: true,
        body: field('Spending on', `<input id="ff_name" autocomplete="off" maxlength="40" placeholder="Gas" value="${esc(l.name)}">`)
          + field(`Limit for ${mkName(mk)}`, `<input id="ff_monthly" class="amount" inputmode="decimal" autocomplete="off" placeholder="No limit" value="${lim ? plain(lim) : ''}">`, `Leave it blank to just track what goes here. It carries on into the months after; to lower it later instead, plan ${esc(mkName(mkAdd(cur, 1)))} on the Spending page.`)
          + `<label class="f-check"><input type="checkbox" id="ff_need"${isNeed(l) ? ' checked' : ''}><span>A need, like groceries or gas. Leave it off for a want, like eating out or fun money.</span></label>`
          + plans
          + ((l.usual || []).length ? `<p class="where">Charges from <b>${esc(l.usual.join(', '))}</b> are suggested here first. You still approve each one.</p>` : ''),
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
    if (window.POSWheels && $('#finBody [data-wheel]')) { POSWheels.mount($('#finBody')); POSWheels.sync(); }
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
      if (dir === 'in') {
        const k = val('ff_inkind');
        if (k.startsWith('pay:')) { const inc = incById(k.slice(4)); Object.assign(data, { payId: inc ? inc.id : null, payDay: inc ? nearestPayday(inc, at) : null, transfer: false }); }
        else Object.assign(data, { payId: '_no', payDay: null, transfer: k === 'transfer' });
      }
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
      const tokens = val('ff_type') === 'asset' ? [] : val('ff_last4').split(/[,\s]+/).filter(Boolean);
      if (tokens.some(x => !/^\d{4}$/.test(x))) return fail('Use the last 4 digits. Separate two cards with a comma.');
      const balance = parseMoney(val('ff_balance'), true);
      if (balance === null) return fail(val('ff_type') === 'asset' ? 'Enter what it’s worth, like 15000.' : 'Enter the balance, like 1250.00.');
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
    async list() {
      const name = val('ff_name').trim(), mode = val('ff_mode') === 'sell' ? 'sell' : 'buy';
      if (!name) return fail('Name the list.');
      if (F.id) return save(refs.buckets.doc(F.id).update({ name, mode }));
      return save(refs.buckets.doc().set({ kind: 'list', name, mode, items: [], createdAt: Date.now(), example: false }));
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
      const every = val('ff_every') === 'year' ? 'year' : null, month = every ? parseInt(val('ff_month'), 10) || null : null;
      const data = { name, amount, day, accountId, group, match, every, month };
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
      const monthlyText = val('ff_monthly').trim(), monthly = monthlyText ? parseMoney(monthlyText) : null;
      if (monthlyText && !monthly) return fail('Enter the limit, like 200, or leave it blank.');
      if (!F.id) {
        const name = val('ff_name').trim();
        if (!name) return fail('Say what the limit is for.');
        return save(refs.buckets.doc().set({ kind: 'limit', name, monthly, need: !!($('#ff_need') && $('#ff_need').checked), createdAt: Date.now(), example: false }));
      }
      const l = bucket(F.id), cur = curMk(), mk = F.extra.mk && F.extra.mk > cur ? F.extra.mk : cur;
      if (!l) return fail('That category no longer exists.');
      const months = { ...(l.months || {}) };
      // a month ahead: blank goes back to carrying on the month before's
      if (mk > cur) {
        if (monthly) months[mk] = monthly; else delete months[mk];
        return save(refs.buckets.doc(l.id).update({ months }));
      }
      // this month: the months before keep the limit they had
      const name = val('ff_name').trim();
      if (!name) return fail('Say what the limit is for.');
      const patch = { name, example: false };
      if ($('#ff_need')) patch.need = $('#ff_need').checked;
      if ((monthly || null) !== limitFor(l, cur)) { months[cur] = monthly || null; patch.months = months; }
      return save(refs.buckets.doc(l.id).update(patch));
    },
    async income() {
      const amount = parseMoney(val('ff_amount'));
      if (!amount) return fail('Enter what lands each payday, like 1649.18.');
      const every = $('#ff_sched_every').checked;
      let days = null, anchor = null;
      if (every) { anchor = val('ff_anchor'); if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return fail('Pick a recent payday.'); }
      else { days = [...new Set([val('ff_day1'), val('ff_day2')].map(Number).filter(Boolean))].sort((a, b) => a - b); if (!days.length) return fail('Pick the payday.'); }
      const salary = val('ff_salary').trim() ? parseMoney(val('ff_salary')) : null;
      if (salary != null && !(salary > 0)) return fail('Enter the yearly salary, like 48000, or leave it empty.');
      if (salary && salary < amount) return fail('The yearly salary is less than one paycheck. Check the numbers.');
      const data = { name: val('ff_name').trim() || 'Paycheck', amount, salary: salary || null, every: every ? 14 : null, anchor, days, accountId: val('ff_acct') || null, match: val('ff_match').trim().slice(0, 120) };
      if (!F.id) return save(refs.income.doc().set({ ...data, got: {}, createdAt: Date.now(), example: false }));
      return save(refs.income.doc(F.id).update(data));
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
    if (k === 'income') return save(refs.income.doc(id).delete());
    if (k === 'loan') return save(refs.loans.doc(id).delete());
    if (k === 'item') { const g = bucket(id); return !!g && save(refs.buckets.doc(id).update({ items: (g.items || []).filter(x => x.id !== F.extra.item) })); }
    if (k === 'goal' || k === 'limit' || k === 'list') return save(refs.buckets.doc(id).delete());
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
    if (e.target.name === 'ff_dir') { const w = $('#ff_bucket_wrap'), w2 = $('#ff_in_wrap'); if (w) w.hidden = $('#ff_dir_in').checked; if (w2) w2.hidden = !$('#ff_dir_in').checked; }
    if (e.target.name === 'ff_sched') { const ev = $('#ff_sched_every').checked; $('#ff_twice').hidden = ev; $('#ff_every').hidden = !ev; if (ev && window.POSWheels) POSWheels.sync(); }
    if (e.target.id === 'ff_account' && $('#ff_bucket')) $('#ff_bucket').innerHTML = bucketOptions(e.target.value, null);
    if (e.target.id === 'ff_type' && $('#ff_l4wrap')) {
      const thing = e.target.value === 'asset';
      $('#ff_l4wrap').hidden = thing;
      $('#ff_balhint').textContent = thing ? 'About what it would sell for. For a car, a private-party value from Kelley Blue Book. Update it now and then.' : 'Copy it from Regions. For a credit card, enter what you owe.';
    }
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

  // the net worth chart: the day under the finger (or pointer), and what it was that day
  let nwTimer = null, nwOn = false;
  function nwHide() { if (!nwOn) return; nwOn = false; for (const el of document.querySelectorAll('.fin .nw-xh, .fin .nw-dot, .fin .nw-tip')) el.hidden = true; }
  function nwScrub(e) {
    const c = e.target.closest && e.target.closest('.fin .nw-plot');
    if (!c || !worthPts || !worthPts.pts.length) { if (e.type === 'pointermove') nwHide(); return; }
    nwOn = true;
    const r = c.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 1);
    let best = worthPts.pts[0];
    for (const q of worthPts.pts) if (Math.abs(q.x - f) < Math.abs(best.x - f)) best = q;
    const v = best.p[worthPts.sel], xh = $('.nw-xh', c), dot = $('.nw-dot', c), tip = $('.nw-tip', c);
    xh.style.left = dot.style.left = (best.x * 100) + '%';
    dot.style.top = (best.y * 100) + '%';
    tip.innerHTML = `<b>${esc(signed(v))}</b><small>${esc(dayFmt.format(best.p.at))}${best.p.est ? ' · worked out from charges' : ''}</small>`;
    tip.style.left = clamp(best.x * 100, 16, 84) + '%';
    xh.hidden = dot.hidden = tip.hidden = false;
    clearTimeout(nwTimer);
  }
  document.addEventListener('pointerdown', nwScrub);
  document.addEventListener('pointermove', nwScrub);
  document.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') { clearTimeout(nwTimer); nwTimer = setTimeout(nwHide, 1800); } });
  document.addEventListener('pointerleave', nwHide);
  document.addEventListener('pointercancel', nwHide);

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
    if (e.target && e.target.id === 'ff_every') { const y = document.querySelector('.ff-yr'); if (y) y.hidden = e.target.value !== 'year'; return; }
    const r = e.target.closest && e.target.closest('[data-loan-extra]');
    if (!r || !canSave()) return;
    const l = loanById(r.dataset.loanExtra), extra = Math.round(Number(r.value) * 100);
    if (l && extra !== (l.extra || 0)) save(refs.loans.doc(l.id).update({ extra }));
  });


  /* ---------- taps routed here by POS (data-act="fin-…") ---------- */
  function act(name, b) {
    if (name === 'fin-month') {
      const mk = b.dataset.mk, key = b.dataset.for === 'sp' ? 'spMk' : 'ovMk';
      if (!/^\d{4}-\d{2}$/.test(mk || '') || mk < START) return;
      S[key] = mk === curMk() ? null : mk;
      if (key === 'ovMk') S.day = null;
      rerender();
      return;
    }
    if (name === 'fin-nw') {
      if (!NW[b.dataset.nw]) return;
      S.nw = b.dataset.nw;
      try { localStorage.setItem('pos.fin.nw', S.nw); } catch (e) {}
      rerender();
      return;
    }
    if (name === 'fin-day') {
      const k = b.dataset.day;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k || '')) return;
      S.day = S.day === k ? null : k;
      rerender();
      if (S.day) { const c = document.querySelector('.fin .hc-day'); if (c && c.getBoundingClientRect().bottom > innerHeight) c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      return;
    }
    if (name === 'fin-todo') {
      const el = $('#finTodo'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (name === 'fin-card') {
      const el = document.querySelector(`.fin [data-card="${CSS.escape(b.dataset.id || '')}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (name === 'fin-sub') {
      if (!SUBS[b.dataset.sub]) return;
      if (b.dataset.mk) S.spMk = b.dataset.mk === curMk() ? null : b.dataset.mk;
      S.sub = b.dataset.sub;
      try { localStorage.setItem('pos.fin.sub', S.sub); } catch (e) {}
      const sc = $('#finScroll'); if (sc) sc.scrollTop = 0;
      rerender();
      const sc2 = $('#finScroll'); if (sc2) sc2.scrollTop = 0;
      return;
    }
    if (!canSave()) return;
    if (name === 'fin-sort') sortTxn(b.dataset.txn, b.dataset.bucket);
    else if (name === 'fin-form') openForm(b.dataset.form, b.dataset.id, { account: b.dataset.account, type: b.dataset.type, group: b.dataset.group, item: b.dataset.item, mk: b.dataset.mk, name: b.dataset.name });
    else if (name === 'fin-pay') togglePay(b.dataset.id, b.dataset.key);
    else if (name === 'fin-item-got') {
      const g = bucket(b.dataset.id);
      if (!g) return;
      const items = (g.items || []).map(x => (x.id === b.dataset.item ? { ...x, got: !x.got } : x));
      save(refs.buckets.doc(g.id).update({ items }));
    }
    else if (name === 'fin-bill-paid') togglePaid(b.dataset.id, b.dataset.mk);
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

  // the car's money, for the Car page: its loan, its insurance and gas this month (found by name)
  function carMoney() {
    if (!S.loaded) return null;
    const loan = S.loans.find(l => /cr-?v|car|auto|exeter/i.test(`${l.name} ${l.lender || ''}`));
    const insurance = S.bills.find(b => /progressive|geico|state farm|allstate|insurance/i.test(b.name));
    const gas = kind('limit').find(l => /gas|fuel/i.test(l.name) && !/snack/i.test(l.name));
    const payBill = loan && loan.billId ? billById(loan.billId) : null;
    return {
      loan: loan ? { name: loan.name, lender: loan.lender, left: loanNow(loan), payment: loan.payment || null, day: payBill ? payBill.day : null } : null,
      insurance: insurance ? { name: insurance.name, amount: insurance.amount || null, day: insurance.day || null } : null,
      gas: gas ? { spent: limitSpent(gas), monthly: limitFor(gas), count: limitCharges(gas).length } : null,
    };
  }
  // savings categories whose name matches, for other pages (the Pets page shows what's saved for the cat)
  function goals(re) {
    if (!S.loaded) return [];
    return kind('goal').filter(g => !g.example && re.test(g.name)).map(g => ({ id: g.id, name: g.name, saved: catLeft(g), target: goalTarget(g) }));
  }
  function listMatches(re) {
    if (!S.loaded) return [];
    return [...kind('list').filter(g => g.mode !== 'sell'), ...kind('goal').filter(isList)].flatMap(g => (g.items || []).filter(i => !i.got && re.test(i.name)).map(i => ({ name: i.name, price: i.price || null, list: g.name })));
  }
  // for the quiet Home: a bill on the day it's due (not paid yet), or late
  const homeBills = () => (S.loaded ? S.bills.map(b => ({ b, s: billState(b) })).filter(x => x.s.st === 'late' || (x.s.st === 'waiting' && x.s.days === 0))
    .map(x => ({ id: x.b.id, name: x.b.name, short: x.b.amount ? fmtShort(x.b.amount) : '', late: x.s.st === 'late', days: x.s.days || 0 })) : []);
  return { view, side, act, add, badge, start, stop, sheetOpen, billsOn, moveBill, carMoney, goals, listMatches, homeBills };
};
