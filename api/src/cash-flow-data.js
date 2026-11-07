const { q } = require('@actual-app/api');

const { dateRange } = require('./aql-date-range');
const { daysInMonthFor } = require('./month-days');

function monthBounds(month) {
  const [yearStr, monthStr] = month.split('-');
  const lastDay = daysInMonthFor(Number(yearStr), Number(monthStr));
  const pad = (n) => String(n).padStart(2, '0');
  return {
    monthStart: `${yearStr}-${monthStr}-01`,
    monthEnd: `${yearStr}-${monthStr}-${pad(lastDay)}`,
  };
}

// The filter, and (when given) the clause leaving some rows out. dateRange()
// already uses $and, so the two are combined in a new one.
const withExclusion = (filter, exclude) => (exclude ? { $and: [filter, exclude] } : filter);

const byAmountDesc = (a, b) => b.amountCents - a.amountCents;

// Actual only flags its single built-in "Income" group as is_income, but
// this budget keeps paychecks in a regular group named "Personal Income".
const isIncomeGroup = (group) => group.is_income || /\bincome\b/i.test(group.name);
// A user-made "Transfers" group holds categorized-but-unlinked moves between
// accounts. That's not spending; leaving it out lets it fall into savings.
const isTransferGroup = (group) => /^transfers?$/i.test(group.name.trim());

// One month's money flow: income by income category, and spending by expense
// group with each group's categories nested. Amounts are positive in both
// directions. A category whose net is a refund (spending side) or a
// clawback (income side) is dropped rather than shown negative, and a
// group's total is the sum of its kept categories so totals always add up.
// Shared by /api/cash-flow (the Sankey) and /api/savings-rate (the gauge)
// so the two always agree.
// `exclude` (optional) is an extra AQL clause leaving some rows out (the native
// spending views pass the excluded/hidden transactions; cash flow proper never does).
async function loadMonthCashFlow(client, month, { exclude } = {}) {
  const { monthStart, monthEnd } = monthBounds(month);
  const [{ data: rows }, categoryGroups] = await Promise.all([
    client.aqlQuery(
      q('transactions')
        // Opening balances land in the "Starting Balances" income category
        // when an account is added; they're not earnings.
        .filter(
          withExclusion(
            {
              ...dateRange(monthStart, monthEnd),
              tombstone: false,
              transfer_id: null,
              starting_balance_flag: false,
            },
            exclude
          )
        )
        .groupBy('category')
        .select([{ categoryId: 'category' }, { amountCents: { $sum: '$amount' } }])
    ),
    client.getCategoryGroups(),
  ]);

  const categoryInfo = new Map();
  for (const group of categoryGroups || []) {
    for (const category of group.categories || []) {
      categoryInfo.set(category.id, { category, group });
    }
  }

  const income = [];
  const groupsById = new Map();
  for (const row of rows || []) {
    const info = categoryInfo.get(row.categoryId);
    if (!info) continue;
    const { category, group } = info;
    if (isTransferGroup(group)) continue;

    if (isIncomeGroup(group)) {
      if (row.amountCents > 0) {
        income.push({ id: category.id, label: category.name, amountCents: row.amountCents });
      }
      continue;
    }

    const spentCents = -row.amountCents;
    if (spentCents <= 0) continue;
    let entry = groupsById.get(group.id);
    if (!entry) {
      entry = { id: group.id, label: group.name, amountCents: 0, categories: [] };
      groupsById.set(group.id, entry);
    }
    entry.amountCents += spentCents;
    entry.categories.push({ id: category.id, label: category.name, amountCents: spentCents });
  }

  const groups = [...groupsById.values()].sort(byAmountDesc);
  for (const group of groups) group.categories.sort(byAmountDesc);
  income.sort(byAmountDesc);

  return {
    incomeCents: income.reduce((sum, item) => sum + item.amountCents, 0),
    spendingCents: groups.reduce((sum, group) => sum + group.amountCents, 0),
    income,
    groups,
  };
}

// The savings rate: (income - spending + investment) / income, or null with no
// income. Shared by /api/savings-rate (the web gauge) and the native reports.
function savingsRateFromFlow(flow, investmentGroupIds) {
  const investmentIds = new Set(investmentGroupIds || []);
  const investmentCents = flow.groups.filter((group) => investmentIds.has(group.id)).reduce((sum, group) => sum + group.amountCents, 0);
  const rate = flow.incomeCents === 0 ? null : (flow.incomeCents - flow.spendingCents + investmentCents) / flow.incomeCents;
  return { incomeCents: flow.incomeCents, outflowCents: flow.spendingCents, investmentCents, rate };
}

module.exports = { loadMonthCashFlow, isIncomeGroup, isTransferGroup, savingsRateFromFlow };
