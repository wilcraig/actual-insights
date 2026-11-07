const { q } = require('@actual-app/api');

const { readInvestmentIds, setInvestment } = require('../../mobile-account-settings-store');
const { scopedClient } = require('./hidden');
const { appendAudit } = require('./audit');
const { badRequest, notFound, money } = require('./common');
const { dailySums, txFilter } = require('./reports-query');

// Investment flag, 30-day trend and balance history of one account, for the
// native Accounts screens. Balances in the past are rebuilt from transactions
// (the balance on day D is the sum of the account's amounts dated <= D), so
// nothing needs snapshotting. Everything goes through the scoped client, so a
// hidden account's rows are never read.

const TREND_DAYS = 30;
const FLAT_FRACTION = 0.005;
const MAX_POINTS = 400;
const DAILY_DAYS = 60;
const RANGES = ['3m', '6m', '1y', 'all'];

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// today minus n months, clamped to the target month's last day.
function monthsBefore(d, n) {
  const last = new Date(d.getFullYear(), d.getMonth() - n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() - n, Math.min(d.getDate(), last));
}
const parseDay = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));

// Direction, change, whole-percent change of one balance move.
function makeTrend(now, then) {
  const change = money(now - then);
  const percent = then === 0 ? null : Math.max(-100000, Math.min(100000, Math.round(((now - then) / Math.abs(then)) * 1000) / 10));
  const flat = now === then || Math.abs(now - then) <= Math.abs(then) * FLAT_FRACTION;
  return { direction: flat ? 'flat' : now > then ? 'up' : 'down', change, percent, days: TREND_DAYS };
}

// accountId -> balance on `date` (sum of amounts dated <= date), one AQL
// query for all the ids; an account with no row then has balance 0.
async function balancesOn(client, ids, date) {
  const result = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return result;
  const { data } = await client.aqlQuery(
    q('transactions')
      .filter(txFilter({ end: date, extra: [{ account: { $oneof: ids } }] }))
      .groupBy('account')
      .select([{ account: 'account' }, { amount: { $sum: '$amount' } }])
  );
  for (const row of data || []) if (result.has(row.account)) result.set(row.account, Number(row.amount) || 0);
  return result;
}

// Adds `investment` and `trend` to the account rows buildAccounts made.
async function withInvestment(client, accounts, now) {
  const marked = new Set(await readInvestmentIds());
  const investing = accounts.filter((a) => marked.has(a.id));
  let then = new Map();
  if (investing.some((a) => a.balance !== null)) {
    try {
      then = await balancesOn(client, investing.map((a) => a.id), fmt(addDays(startOfDay(now), -TREND_DAYS)));
    } catch {
      then = new Map();
    }
  }
  return accounts.map((a) => ({
    ...a,
    investment: marked.has(a.id),
    trend: marked.has(a.id) && a.balance !== null && then.has(a.id) ? makeTrend(a.balance, then.get(a.id)) : null,
  }));
}

// The dates to plot: daily for the last 60 days, weekly out to a year, then
// monthly, never before `start`; `start` and today always included.
function sampleDates(start, today) {
  const dates = new Set([fmt(start), fmt(today)]);
  const inWindow = (d) => d >= start;
  for (let i = 0; i < DAILY_DAYS; i += 1) {
    const d = addDays(today, -i);
    if (inWindow(d)) dates.add(fmt(d));
  }
  for (let age = DAILY_DAYS; age <= 365; age += 7) {
    const d = addDays(today, -age);
    if (inWindow(d)) dates.add(fmt(d));
  }
  for (let m = 13; ; m += 1) {
    const d = monthsBefore(today, m);
    if (!inWindow(d)) break;
    dates.add(fmt(d));
  }
  return [...dates].sort();
}

// Chronological { date, balance } points, at most MAX_POINTS, ending with today.
function buildHistory(daily, range, now) {
  const today = startOfDay(now);
  const entries = [...daily].filter(([date]) => date <= fmt(today)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let start;
  if (range === '3m') start = monthsBefore(today, 3);
  else if (range === '6m') start = monthsBefore(today, 6);
  else if (range === '1y') start = monthsBefore(today, 12);
  else start = entries.length > 0 ? parseDay(entries[0][0]) : today;
  if (start > today) start = today;

  let dates = sampleDates(start, today);
  if (dates.length > MAX_POINTS) {
    // Very long histories: keep an even spread, the first and the last.
    const step = Math.ceil((dates.length - 1) / (MAX_POINTS - 1));
    const thinned = dates.filter((_, i) => i % step === 0);
    if (thinned[thinned.length - 1] !== dates[dates.length - 1]) thinned.push(dates[dates.length - 1]);
    dates = thinned.slice(-MAX_POINTS);
  }
  let i = 0;
  let running = 0;
  return dates.map((date) => {
    while (i < entries.length && entries[i][0] <= date) {
      running += entries[i][1].amount;
      i += 1;
    }
    return { date, balance: money(running) };
  });
}

// GET /accounts/<id>?range=...: the account (as in /accounts) and its history.
async function buildAccountDetail(client, id, range, now = new Date()) {
  const { buildAccounts } = require('./read');
  const body = await buildAccounts(client, now);
  const account = body.accounts.find((a) => a.id === id);
  if (!account) throw notFound();
  const daily = await dailySums(client, txFilter({ extra: [{ account: id }] }));
  return { schema: 1, generatedAt: now.toISOString(), range, account, history: buildHistory(daily, range, now) };
}

// PUT /accounts/<id>/settings.
async function putAccountSettings({ tokenId, id, investment }) {
  const client = await scopedClient();
  if (!((await client.getAccounts()) || []).some((a) => a.id === id)) throw notFound();
  const { before, ok } = await setInvestment(id, investment);
  if (!ok) throw badRequest();
  await appendAudit({ tokenId, op: 'account.settings', ids: { account: id }, before: { investment: before }, after: { investment } });
  return { schema: 1, ok: true };
}

module.exports = { RANGES, withInvestment, buildAccountDetail, buildHistory, putAccountSettings, makeTrend, sampleDates };
