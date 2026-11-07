
// Same comma-separated-ids convention as budget-pacing.js's `categories`
// query parameter.
function parseAccountIds(accounts) {
  if (typeof accounts !== 'string' || accounts.length === 0) {
    return [];
  }
  return accounts
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

// A floor date safely before any real bank data. Querying from here (rather
// than from rangeStart) is what lets a single getTransactions call also
// yield the correct starting balance for the display range: every
// transaction between this floor and rangeStart gets folded into day one's
// cumulative balance instead of being invisible.
const FLOOR_DATE = '1900-01-01';

// Midnight of `date`'s own local calendar day (same stable-boundary pattern
// as month-end-projection.js's startOfLocalDay / accounts.js).
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

// The last valid day-of-month for `year`/`month` (0-indexed month, matching
// Date's own convention) — day 0 of the *next* month is the last day of
// `month`.
function lastDayOfMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// today minus N months, landing on the same day-of-month when that day
// exists in the target month, otherwise clamped to the target month's last
// day. JS Date's own month-overflow behavior rolls FORWARD instead of
// clamping (e.g. new Date(2026, 1, 31) for "Feb 31" overflows to March 3
// rather than landing on Feb 28), so the clamp has to be computed explicitly
// here rather than left to the platform.
function monthsBefore(date, months) {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() - months;
  // Normalize targetMonth into a real year/month pair before computing its
  // last day — new Date(year, month, 0) already handles negative/overflowing
  // month values correctly, so lastDayOfMonth works even with a raw targetMonth.
  const day = Math.min(date.getDate(), lastDayOfMonth(targetYear, targetMonth));
  return new Date(targetYear, targetMonth, day);
}

function yearsBefore(date, years) {
  const targetYear = date.getFullYear() - years;
  const targetMonth = date.getMonth();
  const day = Math.min(date.getDate(), lastDayOfMonth(targetYear, targetMonth));
  return new Date(targetYear, targetMonth, day);
}

// Every calendar day from `start` to `end`, inclusive, as YYYY-MM-DD strings.
function enumerateDays(start, end) {
  const days = [];
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addDays(cursor, 1)) {
    days.push(formatDate(cursor));
  }
  return days;
}

// Buckets a flat transaction list into { dateStr: totalAmountCents }, summing
// same-day transactions together. Grouping (rather than relying on
// getTransactions's own ordering, which `api/transactions-get`'s handler
// does not sort — confirmed by reading
// node_modules/@actual-app/api/dist/index.js) means the per-day totals this
// route computes never depend on what order the API happens to return rows
// in; the dates are re-sorted explicitly below.
function sumAmountsByDate(transactions) {
  const totals = new Map();
  for (const txn of transactions || []) {
    const prior = totals.get(txn.date) || 0;
    totals.set(txn.date, prior + (txn.amount || 0));
  }
  return totals;
}

// Builds the daily balance series for one account's transactions across
// `days` (every calendar day from rangeStart to rangeEnd, inclusive).
// Transactions dated before rangeStart (back to the FLOOR_DATE query) are
// folded into the running balance before the first day is emitted, so day
// one already reflects the correct cumulative starting balance rather than
// starting from zero. A day with no transactions carries the previous day's
// balance forward.
function buildDailySeries(transactions, days, rangeStartStr) {
  const totalsByDate = sumAmountsByDate(transactions);
  const sortedDates = [...totalsByDate.keys()].sort();

  let runningBalance = 0;
  let cursor = 0;

  // Fold in everything strictly before rangeStart.
  while (cursor < sortedDates.length && sortedDates[cursor] < rangeStartStr) {
    runningBalance += totalsByDate.get(sortedDates[cursor]);
    cursor += 1;
  }

  const points = [];
  for (const day of days) {
    while (cursor < sortedDates.length && sortedDates[cursor] <= day) {
      runningBalance += totalsByDate.get(sortedDates[cursor]);
      cursor += 1;
    }
    points.push({ date: day, balanceCents: runningBalance });
  }

  return points;
}

function earliestTransactionDate(transactionsByAccount) {
  let earliest = null;
  for (const transactions of transactionsByAccount) {
    for (const txn of transactions) {
      if (earliest === null || txn.date < earliest) {
        earliest = txn.date;
      }
    }
  }
  return earliest;
}

function computeRangeStart(range, rangeEnd, transactionsByAccount) {
  if (range === '1M') return monthsBefore(rangeEnd, 1);
  if (range === '3M') return monthsBefore(rangeEnd, 3);
  if (range === '6M') return monthsBefore(rangeEnd, 6);
  if (range === '1Y') return yearsBefore(rangeEnd, 1);

  // range === 'all'
  const earliest = earliestTransactionDate(transactionsByAccount);
  return earliest ? parseDateOnly(earliest) : rangeEnd;
}

// Daily balance per open account over the range, plus the net-worth line.
// `requestedAccountIds` empty = every open account. Shared by
// /api/account-balances and the native reports.
async function loadAccountBalances(client, range, requestedAccountIds = [], now = new Date()) {
  const rangeEnd = startOfLocalDay(now);
  const rangeEndStr = formatDate(rangeEnd);

  const allAccounts = await client.getAccounts();
  let openAccounts = (allAccounts || []).filter((account) => !account.closed);
  if (requestedAccountIds.length > 0) {
    const openById = new Map(openAccounts.map((account) => [account.id, account]));
    openAccounts = requestedAccountIds.map((id) => openById.get(id)).filter(Boolean);
  }

  const transactionsByAccountId = new Map();
  await Promise.all(
    openAccounts.map(async (account) => {
      const transactions = await client.getTransactions(account.id, FLOOR_DATE, rangeEndStr);
      transactionsByAccountId.set(account.id, transactions || []);
    })
  );

  const rangeStart = computeRangeStart(range, rangeEnd, transactionsByAccountId.values());
  const rangeStartStr = formatDate(rangeStart);
  const days = enumerateDays(rangeStart, rangeEnd);

  const accounts = openAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    points: buildDailySeries(transactionsByAccountId.get(account.id), days, rangeStartStr),
  }));

  const netWorth = days.map((day, index) => ({
    date: day,
    balanceCents: accounts.reduce((sum, account) => sum + account.points[index].balanceCents, 0),
  }));

  return { range, rangeStart: rangeStartStr, rangeEnd: rangeEndStr, accounts, netWorth };
}

module.exports = { loadAccountBalances };
