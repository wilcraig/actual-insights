const express = require('express');
const { getActualClient, syncIfDue } = require('../actual-client');
const { assertTimezoneConfigured } = require('../month-days');
const { loadScheduleData, buildOccurrences } = require('../bills-data');

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

// Midnight of `date`'s own local calendar day (same stable-boundary pattern
// as month-end-projection.js / paycheck-alerts.js's identical helper).
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseMonth(month) {
  const [yearStr, monthStr] = month.split('-');
  return { year: Number(yearStr), month: Number(monthStr) };
}

function firstDayOfMonth(month) {
  const { year, month: m } = parseMonth(month);
  return new Date(year, m - 1, 1);
}

// The LAST MOMENT of the last calendar day of `month`, not local midnight —
// recurrence.js generates recurring occurrences at local noon (byHourOfDay:
// [12]), so a midnight boundary would silently drop any recurring occurrence
// on the last day of the month (same fix as month-end-projection.js's
// monthEndDate() / paycheck-alerts.js's lastDayOfMonth()).
function lastDayOfMonth(month) {
  const { year, month: m } = parseMonth(month);
  return new Date(year, m, 0, 23, 59, 59, 999);
}

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { month } = req.query;

    if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
      res.status(400).json({ error: 'month query parameter must be in YYYY-MM format' });
      return;
    }

    assertTimezoneConfigured();

    const today = startOfLocalDay(new Date());
    const monthEnd = lastDayOfMonth(month);
    // Clamp the range start to the later of "today" and the first day of the
    // requested month: for a future month, "today" is still in an earlier
    // month, and without this clamp the range would incorrectly span the
    // rest of the CURRENT month's remaining days too (same fix as
    // month-end-projection.js's rangeStart / final-review Fix 1). For the
    // current or a past month this is a no-op (today is already >= the
    // first of the month).
    const rangeStart = new Date(Math.max(today.getTime(), firstDayOfMonth(month).getTime()));

    // An entirely past month has nothing "upcoming" left in it — a
    // legitimate empty answer, not an error, so skip fetching data entirely.
    if (monthEnd < today) {
      res.status(200).json({ items: [] });
      return;
    }

    const client = await getActualClient();
    await syncIfDue(client);

    // Occurrence building lives in bills-data.js, shared with the budget
    // summary's Upcoming section.
    const data = await loadScheduleData(client);
    const items = buildOccurrences(data, rangeStart, monthEnd).map(({ scheduleId, payeeName, date, amountCents, groupName, categoryId }) => ({
      scheduleId,
      payeeName,
      date,
      amountCents,
      groupName,
      categoryId: categoryId ?? null,
    }));

    res.status(200).json({ items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
