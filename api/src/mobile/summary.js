const { q } = require('@actual-app/api');

const { loadScheduleData, buildOccurrences } = require('../bills-data');
const { isIncomeGroup, isTransferGroup } = require('../cash-flow-data');
const { computeForecast } = require('../forecast/compute');
const forecastSettings = require('../forecast/settings-store');
const { readGoals } = require('../goals-store');
const { computeMonthEndProjection } = require('../month-end-data');
const { assertTimezoneConfigured, computeDays } = require('../month-days');
const { statusFor } = require('../summary/sections/pacing-lines');

// The payload behind GET /api/mobile/summary (schema 1, published as
// docs/mobile-summary.schema.json). Every number here is computed by the same
// code the web widgets and summaries use; this file only picks and reshapes.
// A section that can't be computed becomes null or [] instead of failing the
// whole response, so a widget always has something to draw.

const MAX_ACCOUNTS = 25;
const MAX_UPCOMING = 10;
const MAX_GOALS = 5;
const UPCOMING_DAYS = 7;
const MAX_TEXT = 64;
// Same tolerance as the pacing widget and the budget summary's default.
const PACE_TOLERANCE_PCT = 10;

const clip = (value) => String(value ?? '').slice(0, MAX_TEXT);

function pad(n) {
  return String(n).padStart(2, '0');
}

const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// Runs one section; a failure is logged by code only (never the message,
// which could echo budget data) and answered with `fallback`.
async function section(name, fallback, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`mobile summary: ${name} unavailable:`, err && err.code ? err.code : 'unexpected error');
    return fallback;
  }
}

async function readCurrency(client) {
  const rows = await client.aqlQuery(q('preferences').filter({ id: 'defaultCurrencyCode' }).select('*'));
  const value = rows && rows.data && rows.data[0] && rows.data[0].value;
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : 'USD';
}

// Spending categories only: the income and Transfers groups are never
// counted, the same rule the charts and summaries use.
function spendingCategories(budgetMonth) {
  const categories = [];
  for (const group of budgetMonth.categoryGroups || []) {
    if (isIncomeGroup(group) || isTransferGroup(group)) continue;
    for (const category of group.categories || []) categories.push(category);
  }
  return categories;
}

// pace follows the pacing widget: spent against the share of the month gone,
// with available = balance + spent so carryover counts. "off track" and "over
// budget" both read as over for a glanceable widget.
function monthSection(budgetMonth, month) {
  const { daysElapsed, daysInMonth } = computeDays(month);
  let budgeted = 0;
  let spent = 0;
  let balance = 0;
  for (const category of spendingCategories(budgetMonth)) {
    const categorySpent = -(category.spent ?? 0);
    budgeted += category.budgeted ?? 0;
    spent += categorySpent;
    balance += category.balance ?? 0;
  }
  const available = balance + spent;
  const fraction = daysInMonth > 0 ? daysElapsed / daysInMonth : 0;
  const status = statusFor(spent, available, available * fraction, PACE_TOLERANCE_PCT);
  return {
    label: month,
    budgeted,
    spent,
    remaining: balance,
    daysLeft: Math.max(0, daysInMonth - daysElapsed),
    pace: status === 'under' ? 'under' : status === 'on-pace' ? 'on' : 'over',
  };
}

async function accountsSection(client) {
  const open = ((await client.getAccounts()) || [])
    .filter((account) => !account.closed)
    // On-budget accounts first, then off-budget (investments, loans), each by name. Sorting before the cap
    // means a long off-budget list can never push an on-budget account out.
    .sort((a, b) => Boolean(a.offbudget) - Boolean(b.offbudget) || String(a.name).localeCompare(String(b.name)))
    .slice(0, MAX_ACCOUNTS);
  return Promise.all(
    open.map(async (account) => {
      let balance = null;
      try {
        balance = await client.getAccountBalance(account.id);
        if (!Number.isInteger(balance)) balance = null;
      } catch {
        balance = null;
      }
      return { id: clip(account.id), name: clip(account.name), balance, onBudget: !account.offbudget };
    })
  );
}

// Bills and paychecks from Actual's schedules over the next week. A positive
// schedule to one of your own accounts (a transfer in) isn't a paycheck; a
// negative one (a card payment) is a bill. Zero-amount occurrences (a card
// payment cc-helper has not filled in yet) say nothing, so they are dropped.
async function upcomingSection(client, now) {
  const data = await loadScheduleData(client);
  const transferPayees = new Set((data.payees || []).filter((p) => p.transfer_acct).map((p) => p.id));
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + UPCOMING_DAYS, 23, 59, 59, 999);
  return buildOccurrences(data, start, end)
    .filter((o) => o.amountCents !== 0 && !(o.amountCents > 0 && transferPayees.has(o.payeeId)))
    .map((o) => ({ date: o.date, payee: clip(o.payeeName), amount: Math.abs(o.amountCents), kind: o.amountCents < 0 ? 'bill' : 'paycheck' }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount))
    .slice(0, MAX_UPCOMING);
}

// The headline of the cash-flow forecast: low when any watched account falls
// below its level (naming the one furthest below), else ok with the lowest
// balance seen. Null when nothing is switched on or nothing could be computed.
async function forecastSection(client, now, dataDir) {
  const settings = await forecastSettings.readSettings(dataDir);
  if (!Object.values(settings.accounts).some((a) => a && a.enabled)) return null;
  const { results } = await computeForecast({ client, now, settings });
  if (!results || results.length === 0) return null;

  const breached = results.filter((r) => r.breach);
  const pick = breached.length > 0
    ? breached.reduce((worst, r) => (r.breach.shortfallCents > worst.breach.shortfallCents ? r : worst))
    : results.reduce((lowest, r) => (r.lowest.balanceCents < lowest.lowest.balanceCents ? r : lowest));
  return {
    status: breached.length > 0 ? 'low' : 'ok',
    lowestBalance: pick.lowest.balanceCents,
    lowestDate: pick.lowest.date,
    accountName: clip(pick.accountName),
  };
}

// Saved = an account goal's balance, or a category goal's carryover balance
// this month (what the thermometer widget shows). The goal has no name of its
// own; it takes the account's or category's.
async function goalsSection(client, budgetMonthPromise, dataDir) {
  const stored = (await readGoals(dataDir)).slice();
  const goals = [];
  let accounts = null;
  let categories = null;
  for (const goal of stored) {
    if (goals.length >= MAX_GOALS) break;
    if (goal.entityType === 'account') {
      accounts = accounts || (await client.getAccounts()) || [];
      const account = accounts.find((a) => a.id === goal.entityId);
      if (!account) continue;
      goals.push({ id: clip(goal.id), name: clip(account.name), saved: await client.getAccountBalance(account.id), target: goal.targetAmountCents });
    } else if (goal.entityType === 'category') {
      if (!categories) {
        categories = new Map();
        for (const group of (await budgetMonthPromise).categoryGroups || []) {
          for (const category of group.categories || []) categories.set(category.id, category);
        }
      }
      const category = categories.get(goal.entityId);
      if (!category) continue;
      goals.push({ id: clip(goal.id), name: clip(category.name), saved: category.balance ?? 0, target: goal.targetAmountCents });
    }
  }
  return goals;
}

async function buildMobileSummary({ client, now = new Date(), dataDir } = {}) {
  // A server without TZ would compute the wrong day: fail loudly, like every
  // other day-of-month route.
  assertTimezoneConfigured();

  const month = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  // One read of the budget month feeds the month section and category goals.
  const budgetMonthPromise = Promise.resolve().then(() => client.getBudgetMonth(month));
  budgetMonthPromise.catch(() => {});

  const [currency, monthPart, projection, accounts, upcoming, forecast, goals] = await Promise.all([
    section('currency', 'USD', () => readCurrency(client)),
    section('month', null, async () => monthSection(await budgetMonthPromise, month)),
    section('projection', null, async () => ({ monthEndNet: (await computeMonthEndProjection(client, month)).projectedNetCents })),
    section('accounts', [], () => accountsSection(client)),
    section('upcoming', [], () => upcomingSection(client, now)),
    section('forecast', null, () => forecastSection(client, now, dataDir)),
    section('goals', [], () => goalsSection(client, budgetMonthPromise, dataDir)),
  ]);

  return {
    schema: 1,
    generatedAt: now.toISOString(),
    currency,
    month: monthPart,
    projection,
    accounts,
    upcoming,
    forecast,
    goals,
  };
}

module.exports = { buildMobileSummary, MAX_ACCOUNTS, MAX_UPCOMING, MAX_GOALS };
