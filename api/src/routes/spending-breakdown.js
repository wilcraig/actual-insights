const express = require('express');
const { q } = require('@actual-app/api');

const { getActualClient, syncIfDue } = require('../actual-client');
const { dateRange } = require('../aql-date-range');
const {
  monthBounds,
  baseFilterFor,
  breakdownByGroups,
  breakdownByCategories,
  breakdownByCategoryIds,
  breakdownByPayees,
  transactionsForCategoryAndPayee,
} = require('../spending-data');

const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VALID_LEVELS = new Set(['groups', 'categories', 'payees', 'transactions']);
// Sentinel for "the no-payee bucket" (see breakdownByPayees' null-payee
// handling below) as a literal query-param value, since a real payeeId is
// always a non-empty string and an actually-absent payeeId already means
// something else (the param wasn't given at all).
const NO_PAYEE_SENTINEL = '__none__';

// Same comma-separated-ids convention as budget-pacing.js's `categories`
// query parameter.
function parseIdList(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return [];
  }
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

// The first month (YYYY-MM) with any transaction in the endpoint's usual
// transaction scope (non-deleted, non-transfer), never later than `month`, so
// the web widget's month arrows know how far back they may go. One
// limit-1 ordered query; any failure just omits the field (the client then
// falls back to a fixed look-back window).
async function earliestMonthFor(client, month) {
  try {
    const { monthEnd } = monthBounds(month);
    const result = await client.aqlQuery(
      q('transactions')
        .filter(baseFilterFor({ date: { $lte: monthEnd } }))
        .orderBy('date')
        .select('date')
        .limit(1)
    );
    const first = result && Array.isArray(result.data) ? result.data[0] : null;
    const earliest = first && typeof first.date === 'string' ? first.date.slice(0, 7) : null;
    if (!earliest || !MONTH_PATTERN.test(earliest)) return null;
    return earliest < month ? earliest : month;
  } catch (err) {
    return null;
  }
}

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { month, date, level, groupId, categoryId, groupIds, categoryIds, payeeId } = req.query;

    // Either a whole month or one single day (the calendar heatmap's drill-down).
    const hasMonth = typeof month === 'string' && MONTH_PATTERN.test(month);
    const hasDate = typeof date === 'string' && DATE_PATTERN.test(date);
    if (hasMonth === hasDate || (month !== undefined && date !== undefined)) {
      res.status(400).json({ error: 'exactly one of month (YYYY-MM) or date (YYYY-MM-DD) is required' });
      return;
    }

    if (typeof level !== 'string' || !VALID_LEVELS.has(level)) {
      res.status(400).json({ error: "level query parameter must be one of 'groups', 'categories', 'payees', 'transactions'" });
      return;
    }

    // Express's default query parser turns `?groupId[$ne]=x` into an object
    // rather than a string. Reject that here instead of letting it reach
    // the AQL query builder, where it would compile as an operator object
    // rather than a literal filter value.
    //
    // level=categories accepts EITHER groupId (a real Actual group -- the
    // normal drill-down-from-a-single-category path) OR categoryIds (an
    // arbitrary user-curated list -- the rollup-widget path); exactly one
    // of the two is required.
    const categoryIdList = parseIdList(categoryIds);
    if (level === 'categories') {
      const hasGroupId = typeof groupId === 'string' && groupId.length > 0;
      const hasCategoryIds = categoryIdList.length > 0;
      if (hasGroupId === hasCategoryIds) {
        res.status(400).json({ error: 'level=categories requires exactly one of groupId or categoryIds' });
        return;
      }
    }

    if (level === 'payees' && (!categoryId || typeof categoryId !== 'string')) {
      res.status(400).json({ error: 'categoryId is required for level=payees' });
      return;
    }

    if (level === 'transactions') {
      if (!categoryId || typeof categoryId !== 'string') {
        res.status(400).json({ error: 'categoryId is required for level=transactions' });
        return;
      }
      if (!payeeId || typeof payeeId !== 'string') {
        res.status(400).json({ error: 'payeeId is required for level=transactions (use "__none__" for the no-payee bucket)' });
        return;
      }
    }

    const client = await getActualClient();
    await syncIfDue(client);

    const dateFilter = hasDate ? { date } : dateRange(monthBounds(month).monthStart, monthBounds(month).monthEnd);
    // transfer_id: null excludes transfers between accounts at every level
    // of this drill-down -- a transfer isn't spending, and left in, one
    // routinely dominates the donut (a single reconciliation/rebalancing
    // transfer can dwarf real spending categories; this budget's own
    // "Transfers" category group was 58% of the groups-level total before
    // this filter).
    const baseFilter = baseFilterFor(dateFilter);

    if (level === 'transactions') {
      const transactions = await transactionsForCategoryAndPayee(
        client,
        baseFilter,
        categoryId,
        payeeId === NO_PAYEE_SENTINEL ? null : payeeId
      );
      const earliestMonth = hasMonth ? await earliestMonthFor(client, month) : null;
      res.status(200).json(earliestMonth ? { transactions, earliestMonth } : { transactions });
      return;
    }

    let slices;
    if (level === 'groups') {
      slices = await breakdownByGroups(client, baseFilter, parseIdList(groupIds));
    } else if (level === 'categories') {
      slices = categoryIdList.length > 0
        ? await breakdownByCategoryIds(client, baseFilter, categoryIdList)
        : await breakdownByCategories(client, baseFilter, groupId);
    } else {
      slices = await breakdownByPayees(client, baseFilter, categoryId);
    }

    const total = slices.reduce((sum, slice) => sum + slice.amountCents, 0);

    const earliestMonth = hasMonth ? await earliestMonthFor(client, month) : null;
    res.status(200).json(earliestMonth ? { total, slices, earliestMonth } : { total, slices });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
