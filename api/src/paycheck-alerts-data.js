const { resolveScheduledAmount, expandOccurrences, parseDate } = require('./recurrence');

// Midnight of `date`'s own local calendar day (see month-end-projection.js's
// identical helper for why: a stable boundary that doesn't shift behavior
// depending on what time of day a request happens to arrive).
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function monthToStr(year, month) {
  // Normalize `month` (1-indexed, but may be <1 or >12 from month arithmetic)
  // back into a real 1-12 month plus a carried/borrowed year.
  let y = year;
  let m = month;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function parseMonth(month) {
  const [yearStr, monthStr] = month.split('-');
  return { year: Number(yearStr), month: Number(monthStr) };
}

// Shifts `month` (a 'YYYY-MM' string) by `delta` calendar months, correctly
// rolling the year over in either direction (e.g. December + 1 -> next
// January; January - 1 -> previous December).
function addMonths(month, delta) {
  const { year, month: m } = parseMonth(month);
  return monthToStr(year, m + delta);
}

function firstDayOfMonth(month) {
  const { year, month: m } = parseMonth(month);
  return new Date(year, m - 1, 1);
}

// The LAST MOMENT of the last calendar day of `month`, not local midnight.
// recurrence.js generates recurring occurrences at local noon
// (byHourOfDay: [12]), so a midnight boundary would silently drop any
// recurring occurrence on the last day of the month (same fix as
// month-end-projection.js's monthEndDate()).
function lastDayOfMonth(month) {
  const { year, month: m } = parseMonth(month);
  return new Date(year, m, 0, 23, 59, 59, 999);
}

// Builds the set of payee ids that represent transfers between the
// household's own accounts, same pattern as month-end-projection.js: Actual
// always writes a transfer's own-account leg with a positive amount
// regardless of direction, so without this exclusion a transfer schedule
// (e.g. a checking->card autopay) would be misclassified as income.
function transferPayeeIds(payees) {
  return new Set((payees || []).filter((p) => p.transfer_acct).map((p) => p.id));
}

function payeesById(payees) {
  return new Map((payees || []).map((p) => [p.id, p]));
}

// `schedule.name` is optional in Actual: a schedule set up without an
// explicit name has name undefined/null, and Actual's own UI falls back to
// showing the payee's name. Mirror that so the banner never shows an alert
// with no identifying name at all.
function resolveScheduleName(schedule, payeesIndex) {
  if (schedule.name) return schedule.name;
  const payee = payeesIndex.get(schedule.payee);
  if (payee && payee.name) return payee.name;
  return '(Unnamed schedule)';
}

// The first calendar month that is entirely on or after `startDateStr`
// ('YYYY-MM-DD'). A schedule that starts mid-month only has a *partial*
// first month, which would skew an average computed over it, so the
// averaging window should begin at the next full month in that case.
function firstFullCalendarMonthOnOrAfter(startDateStr) {
  const start = parseDate(startDateStr);
  const year = start.getFullYear();
  const month = start.getMonth() + 1; // 1-indexed
  if (start.getDate() === 1) {
    return monthToStr(year, month);
  }
  return monthToStr(year, month + 1);
}

// The 12-calendar-month window used to compute a schedule's "normal" cadence
// for comparison against `month`'s actual occurrence count.
//
// A fixed trailing-12-months-from-today window (the original, buggy
// approach) divides by a fixed 12 regardless of how much of that window the
// schedule actually existed for, which produces an artificially low average
// for any schedule less than a year old. Instead, the window runs FORWARD 12
// full calendar months starting from whichever is LATER: the normal trailing
// start (`month` - 11 months), or the first full calendar month the
// schedule's own cadence was active in. `expandOccurrences` is pure
// recurrence math (not historical data), so projecting forward from a recent
// start is just as valid as looking backward from today.
function averagingWindowFor(config, month) {
  const trailingStartMonth = addMonths(month, -11);
  const scheduleFirstFullMonth = firstFullCalendarMonthOnOrAfter(config.start);
  // 'YYYY-MM' strings compare correctly lexically.
  const windowStartMonth = scheduleFirstFullMonth > trailingStartMonth ? scheduleFirstFullMonth : trailingStartMonth;
  const windowEndMonth = addMonths(windowStartMonth, 11);

  return {
    start: firstDayOfMonth(windowStartMonth),
    end: lastDayOfMonth(windowEndMonth),
  };
}

// The date the schedule's own cadence stops generating occurrences, or null
// if it has no end (recurs forever as far as this is concerned).
function scheduleEffectiveEndDate(config) {
  if (config.endMode === 'on_date') {
    return parseDate(config.endDate);
  }
  if (config.endMode === 'after_n_occurrences') {
    // `expandOccurrences` already caps the total count generated at
    // config.endOccurrences (via recurConfigToRules' base.count), so a
    // generous far-future bound just lets us see where it actually stops.
    const farFuture = new Date(parseDate(config.start).getFullYear() + 100, 0, 1);
    const occurrences = expandOccurrences(config, { start: parseDate(config.start), end: farFuture });
    return occurrences.length > 0 ? occurrences[occurrences.length - 1] : parseDate(config.start);
  }
  return null;
}

// Schedules whose current or next month holds more paychecks than their
// 12-month average. Shared by /api/paycheck-alerts and the native reports.
async function loadPaycheckAlerts(client, now = new Date()) {
  const [schedules, payees] = await Promise.all([client.getSchedules(), client.getPayees()]);
  const transferIds = transferPayeeIds(payees);
  const payeesIndex = payeesById(payees);

  const today = startOfLocalDay(now);
  const currentMonth = monthToStr(today.getFullYear(), today.getMonth() + 1);
  const nextMonth = addMonths(currentMonth, 1);

  const alerts = [];

  for (const schedule of schedules || []) {
    if (schedule.completed) continue;
    if (typeof schedule.date === 'string') continue;

    const amountPerOccurrenceCents = resolveScheduledAmount(schedule.amount);
    if (amountPerOccurrenceCents <= 0) continue;

    if (transferIds.has(schedule.payee)) continue;

    for (const month of [currentMonth, nextMonth]) {
      const occurrencesThisMonth = expandOccurrences(schedule.date, {
        start: firstDayOfMonth(month),
        end: lastDayOfMonth(month),
      }).length;

      const yearWindow = averagingWindowFor(schedule.date, month);

      const effectiveEnd = scheduleEffectiveEndDate(schedule.date);
      if (effectiveEnd !== null && effectiveEnd < yearWindow.end) continue;

      const occurrencesInYear = expandOccurrences(schedule.date, yearWindow).length;
      const averagePerMonth = occurrencesInYear / 12;

      if (occurrencesThisMonth > averagePerMonth) {
        alerts.push({
          scheduleId: schedule.id,
          scheduleName: resolveScheduleName(schedule, payeesIndex),
          month,
          occurrences: occurrencesThisMonth,
          averagePerMonth,
          amountPerOccurrenceCents,
        });
      }
    }
  }

  return { alerts, currentMonth };
}

module.exports = { loadPaycheckAlerts };
