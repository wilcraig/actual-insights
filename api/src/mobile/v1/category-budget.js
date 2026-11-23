const { scopedClient } = require('./hidden');
const { HttpError, badRequest, notFound, isHidden, isIncome, money, MONTH_PATTERN } = require('./common');
const { exclusive, syncNow, findCategory } = require('./write');
const { adjustedBudgetMonth } = require('./exclusions');
const { appendAudit } = require('./audit');

// Per-category history (the budget edit sheet's averages) and the rollover
// reset. Both stay within the months Actual really has (getBudgetMonths), so
// a month outside the budget is never read or written.

const MAX_HISTORY_MONTHS = 12;
const DEFAULT_HISTORY_MONTHS = 6;

const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOf = (index) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
const currentMonthOf = (now) => monthOf(now.getFullYear() * 12 + now.getMonth());
const previousMonth = (m) => monthOf(monthIndex(m) - 1);

const lineOf = (budgetMonth, categoryId) => {
  for (const group of (budgetMonth && budgetMonth.categoryGroups) || []) {
    for (const category of group.categories || []) if (category.id === categoryId) return category;
  }
  return null;
};

// Months Actual has a budget for, sorted. null when the client can't say.
async function availableMonths(client) {
  if (typeof client.getBudgetMonths !== 'function') return null;
  const months = (await client.getBudgetMonths()) || [];
  return months.filter((m) => typeof m === 'string' && MONTH_PATTERN.test(m)).sort();
}

// Parse the `months` query value: a plain integer 1..12, default 6.
function parseHistoryMonths(value) {
  if (value === undefined) return DEFAULT_HISTORY_MONTHS;
  if (!/^[1-9][0-9]?$/.test(value) || Number(value) > MAX_HISTORY_MONTHS) throw badRequest();
  return Number(value);
}

async function buildCategoryHistory(client, categoryId, months, now = new Date()) {
  const found = await findCategory(client, categoryId);
  if (!found || isHidden(found.group, found.category) || isIncome(found.group, found.category)) throw notFound();

  const current = currentMonthOf(now);
  const have = await availableMonths(client);
  const completed = (have || []).filter((m) => m < current).slice(-months);
  const out = [];
  for (const month of completed) {
    const line = lineOf(await adjustedBudgetMonth(client, month), categoryId);
    if (!line) continue;
    out.push({ month, budgeted: money(line.budgeted), spent: money(line.spent) });
  }
  return { schema: 1, categoryId, months: out };
}

// Start the category's rollover afresh as of `month` (the current month): the
// previous month's carryover flag goes off, so its balance stops flowing into
// `month`. Actual's rule: carryover ON for month M means M's balance rolls
// into M+1. Nothing else is touched.
async function resetRollover({ tokenId, month, categoryId, now = new Date() }) {
  return exclusive(async () => {
    if (!MONTH_PATTERN.test(month) || month !== currentMonthOf(now)) throw badRequest();
    const client = await scopedClient();
    const found = await findCategory(client, categoryId);
    if (!found) throw notFound();
    if (isHidden(found.group, found.category) || isIncome(found.group, found.category)) throw badRequest();

    const none = { schema: 1, ok: true, month, carriedOver: 0 };
    const have = await availableMonths(client);
    const prev = previousMonth(month);
    if (have && !have.includes(prev)) return none;
    if (have && !have.includes(month)) return none;

    const thisLine = lineOf(await client.getBudgetMonth(month), categoryId);
    if (!thisLine || !thisLine.carryover) return none;
    const prevLine = lineOf(await client.getBudgetMonth(prev), categoryId);
    if (!prevLine || !prevLine.carryover) return none;
    const carriedOver = money(prevLine.balance);
    if (carriedOver === 0) return none;

    await client.setBudgetCarryover(prev, categoryId, false);
    await appendAudit({ tokenId, op: 'budget.rollover.reset', ids: { category: categoryId }, before: { carriedOver } });
    await syncNow(client);
    return { ...none, carriedOver };
  });
}

module.exports = { buildCategoryHistory, parseHistoryMonths, resetRollover, currentMonthOf, HttpError };
