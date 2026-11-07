const { q } = require('@actual-app/api');

const { dateRange } = require('./aql-date-range');
const { daysInMonthFor } = require('./month-days');

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

// First and last calendar day of `month` (YYYY-MM), as AQL date-range
// bounds. Same simple string-math approach as spending-breakdown.js's own
// monthBounds() -- `transactions.date` is a plain YYYY-MM-DD string field in
// the AQL schema, not a Date object, so this just needs to produce the right
// strings. Duplicated locally rather than imported since monthBounds isn't
// exported from spending-breakdown.js, matching this codebase's established
// convention of small duplicated date-math helpers across route files (see
// account-balances.js's and spending-breakdown.js's own parseDateOnly/
// formatDate-equivalents).
function monthBounds(month) {
  const [yearStr, monthStr] = month.split('-');
  const lastDay = daysInMonthFor(Number(yearStr), Number(monthStr));
  const pad = (n) => String(n).padStart(2, '0');
  return {
    monthStart: `${yearStr}-${monthStr}-01`,
    monthEnd: `${yearStr}-${monthStr}-${pad(lastDay)}`,
  };
}

// Midnight of `date`'s own local calendar day (same stable-boundary pattern
// as account-balances.js's startOfLocalDay).
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateOnly(dateStr) {
  const [yearStr, monthStr, dayStr] = dateStr.split('-');
  return new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr));
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

// Every calendar day from `start` to `end`, inclusive, as YYYY-MM-DD strings
// -- same day-walking approach as account-balances.js's enumerateDays().
function enumerateDays(start, end) {
  const days = [];
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addDays(cursor, 1)) {
    days.push(formatDate(cursor));
  }
  return days;
}

// Buckets grouped-by-date AQL rows into { dateStr: totalRawAmountCents },
// mirroring account-balances.js's sumAmountsByDate (there it buckets a raw
// transaction list; here the AQL query has already summed same-day rows, so
// this is just indexing, but it keeps the same lookup shape).
function sumAmountsByDate(rows) {
  const totals = new Map();
  for (const row of rows || []) {
    totals.set(row.date, row.amountCents || 0);
  }
  return totals;
}

// Walks every day in `days`, carrying the running cumulative spend total
// forward on days with no transactions -- the same "walk every calendar day,
// carry totals forward" approach as account-balances.js's buildDailySeries,
// specialized here for a cumulative-from-day-one total (no pre-range
// starting balance to fold in, since day one of the series is always day one
// of the month, i.e. the running total always starts at 0) and for positive
// spending cents rather than a signed balance (Actual stores outflows as
// negative amounts internally, so the summed amountCents per day is negated
// here, once, at this boundary -- same convention as spending-breakdown.js's
// toPositiveSpendingCents).
function buildCumulativeSeries(rows, days) {
  const totalsByDate = sumAmountsByDate(rows);
  const sortedDates = [...totalsByDate.keys()].sort();

  let runningSpendCents = 0;
  let cursor = 0;

  const points = [];
  for (const day of days) {
    while (cursor < sortedDates.length && sortedDates[cursor] <= day) {
      runningSpendCents += -(totalsByDate.get(sortedDates[cursor]) ?? 0);
      cursor += 1;
    }
    points.push({ date: day, cumulativeSpendCents: runningSpendCents });
  }

  return points;
}

// Sums `budgeted` across every non-hidden category in a non-hidden,
// non-income group, from getBudgetMonth(month)'s categoryGroups shape --
// same double hidden-group/hidden-category skip categories.js already
// applies to getCategoryGroups()'s shape (a hidden group's categories are
// dropped entirely, even when a given category itself isn't hidden), and the
// same group.is_income skip month-end-projection.js already applies to this
// same getBudgetMonth() shape.
function sumBudgetedCents(categoryGroups) {
  let total = 0;
  for (const group of categoryGroups || []) {
    if (group.is_income) continue;
    if (group.hidden) continue;
    for (const category of group.categories || []) {
      if (category.hidden) continue;
      total += category.budgeted ?? 0;
    }
  }
  return total;
}

// The month's cumulative spend by day (through today for the current month)
// and the month's budgeted total. Shared by /api/burn-rate and the native
// reports so the web chart and the phone show the same numbers.
async function loadBurnRate(client, month, now = new Date()) {
  const budgetMonth = await client.getBudgetMonth(month);
  const budgetedCents = sumBudgetedCents(budgetMonth.categoryGroups);

  const { monthStart, monthEnd } = monthBounds(month);
  const today = startOfLocalDay(now);
  const todayStr = formatDate(today);
  const currentMonthStr = todayStr.slice(0, 7);

  let days;
  if (month > currentMonthStr) {
    days = enumerateDays(parseDateOnly(monthStart), parseDateOnly(monthEnd)).map((date) => ({
      date,
      cumulativeSpendCents: 0,
    }));
  } else {
    const queryEndStr = month === currentMonthStr ? todayStr : monthEnd;
    const rangeEnd = month === currentMonthStr ? today : parseDateOnly(monthEnd);
    const baseFilter = {
      ...dateRange(monthStart, queryEndStr),
      tombstone: false,
      transfer_id: null,
      'category.group.is_income': false,
    };
    const { data: rows } = await client.aqlQuery(
      q('transactions')
        .filter(baseFilter)
        .groupBy('date')
        .select([{ date: 'date' }, { amountCents: { $sum: '$amount' } }])
    );
    days = buildCumulativeSeries(rows, enumerateDays(parseDateOnly(monthStart), rangeEnd));
  }
  return { budgetedCents, days };
}

module.exports = { loadBurnRate, monthBounds, enumerateDays, parseDateOnly, formatDate };
