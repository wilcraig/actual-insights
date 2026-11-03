const { computeDays } = require('./month-days');
const { resolveScheduledAmount, expandOccurrences, parseDate } = require('./recurrence');

// Midnight of `date`'s own local calendar day, with any wall-clock
// time-of-day component zeroed out. Used as a stable range boundary that
// doesn't change behavior depending on what time of day a request happens to
// arrive (final-review Fix 2).
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function firstDayOfMonth(month) {
  const [yearStr, monthStr] = month.split('-');
  return new Date(Number(yearStr), Number(monthStr) - 1, 1);
}

function monthEndDate(month) {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthNum = Number(monthStr);
  // The LAST MOMENT of the last calendar day of `month`, not local midnight.
  // recurrence.js generates recurring occurrences at local noon
  // (byHourOfDay: [12]), so a midnight boundary silently dropped any
  // recurring occurrence on the last day of the month, while a one-time
  // schedule due that same day (compared as date-only) was still counted —
  // the two code paths disagreed (final-review Fix 1, Critical).
  return new Date(year, monthNum, 0, 23, 59, 59, 999);
}

// Builds the set of payee ids that represent transfers between the
// household's own accounts (e.g. a checking account paying off a credit
// card). Actual always writes a transfer's own-account leg with a positive
// amount regardless of direction, so without this exclusion a transfer
// schedule like cc-helper's checking->card autopay would be misclassified
// as income.
function transferPayeeIds(payees) {
  return new Set((payees || []).filter((p) => p.transfer_acct).map((p) => p.id));
}

// Sums the scheduled income expected between `rangeStart` and `monthEnd`
// (inclusive), excluding completed schedules, non-positive amounts, and
// transfers to/from the household's own accounts.
function sumRemainingScheduledIncome(schedules, transferIds, rangeStart, monthEnd) {
  let total = 0;

  for (const schedule of schedules || []) {
    if (schedule.completed) continue;

    const amount = resolveScheduledAmount(schedule.amount);
    if (amount <= 0) continue;

    if (transferIds.has(schedule.payee)) continue;

    if (typeof schedule.date === 'string') {
      // One-time schedule: count it once if its next occurrence falls in range.
      const nextDate = parseDate(schedule.next_date);
      if (nextDate >= rangeStart && nextDate <= monthEnd) {
        total += amount;
      }
    } else {
      const occurrences = expandOccurrences(schedule.date, { start: rangeStart, end: monthEnd });
      total += occurrences.length * amount;
    }
  }

  return total;
}

// Projects each non-income category's spending to month end using its
// current daily run rate, capping an at/under-budget category's projection
// at its budgeted amount (an already-over-budget category keeps trending
// uncapped).
function sumTrendedRemainingSpending(categoryGroups, daysElapsed, daysInMonth) {
  if (daysElapsed === 0) return 0;

  const remainingDays = daysInMonth - daysElapsed;
  let total = 0;

  for (const group of categoryGroups || []) {
    if (group.is_income) continue;

    for (const category of group.categories || []) {
      const spent = -(category.spent ?? 0);
      const budgeted = category.budgeted ?? 0;

      const dailyRate = spent / daysElapsed;
      // Round the trended (not-yet-spent) portion before it's folded into the
      // total: dailyRate * remainingDays is a fractional-cents estimate, and
      // leaving it unrounded could put a fraction of a cent into the final
      // response (final-review Fix 6, Minor).
      const trendedRemaining = Math.round(dailyRate * remainingDays);
      let projectedTotal = spent + trendedRemaining;
      if (spent <= budgeted) {
        projectedTotal = Math.min(projectedTotal, budgeted);
      }

      total += Math.max(0, projectedTotal - spent);
    }
  }

  return total;
}


// The month-end net projection for `month` ('YYYY-MM'), read-only: income so
// far, plus scheduled income still to come, minus spending so far and the
// trended remainder. Shared by GET /api/month-end-projection and the mobile
// summary so both report the same number.
async function computeMonthEndProjection(client, month) {
  const { daysElapsed, daysInMonth } = computeDays(month);

  const [budgetMonth, schedules, payees] = await Promise.all([
    client.getBudgetMonth(month),
    client.getSchedules(),
    client.getPayees(),
  ]);

  const incomeSoFarCents = budgetMonth.totalIncome ?? 0;
  const spentSoFarCents = -(budgetMonth.totalSpent ?? 0);

  const today = startOfLocalDay(new Date());
  const monthEnd = monthEndDate(month);
  // Clamp the range start to the later of "today" and the first day of the
  // requested month: for a future month, "today" is still in an earlier
  // month, and without this clamp the range would incorrectly span the
  // rest of the CURRENT month's remaining days too (final-review Fix 8,
  // Minor). For the current or a past month this is a no-op (today is
  // already >= the first of the month).
  const rangeStart = new Date(Math.max(today.getTime(), firstDayOfMonth(month).getTime()));
  const transferIds = transferPayeeIds(payees);
  const remainingScheduledIncomeCents = sumRemainingScheduledIncome(schedules, transferIds, rangeStart, monthEnd);

  const trendedRemainingSpendingCents = sumTrendedRemainingSpending(budgetMonth.categoryGroups, daysElapsed, daysInMonth);

  const projectedNetCents =
    incomeSoFarCents + remainingScheduledIncomeCents - spentSoFarCents - trendedRemainingSpendingCents;

  return {
    month,
    projectedNetCents,
    components: {
      incomeSoFarCents,
      remainingScheduledIncomeCents,
      spentSoFarCents,
      trendedRemainingSpendingCents,
    },
  };
}

module.exports = { computeMonthEndProjection };
