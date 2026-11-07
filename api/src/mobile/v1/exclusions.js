const { q } = require('@actual-app/api');

const { readFlags } = require('../../mobile-transaction-flags-store');
const { isIncome } = require('./common');

// Excluded and hidden transactions (Insights flags, see
// mobile-transaction-flags-store.js), applied to category and spending figures
// in ONE place. An excluded transaction is left out of what the budget says
// was spent: Budget Config spent/balance (the amounts are added back), pacing
// rows, spending drills and breakdowns, the Sankey and the other spending
// cards. It is NOT left out of anything that is real money (account balances,
// net worth, cash flow, account history). A split's flags apply to every line.

const CHUNK = 400; // ids per AQL lookup
const NOT_IN_CHUNK = 100; // ids per nested $and (AQL caps expression depth at 1000)
const MAX_FILTER_IDS = 5000;

const ROW_FIELDS = ['id', 'date', 'amount', 'category', 'is_parent', 'parent_id', 'transfer_id', 'account.offbudget'];

const EMPTY = Object.freeze({
  empty: true,
  rows: [],
  ids: new Set(),
  idsBetween: () => [],
  addBack: () => new Map(),
});

// Everything the flags exclude (the flagged rows and, for split parents, their
// lines), read once. Cheap when nothing is flagged: no Actual call at all.
async function loadExclusions(client, dir) {
  const flags = dir ? await readFlags(dir) : await readFlags();
  const flagged = Object.keys(flags).filter((id) => flags[id].excluded);
  if (flagged.length === 0) return EMPTY;

  const rows = new Map();
  const fetch = async (filter) => {
    const { data } = await client.aqlQuery(q('transactions').options({ splits: 'all' }).filter(filter).select(ROW_FIELDS));
    for (const row of data || []) if (row && typeof row.id === 'string') rows.set(row.id, row);
  };
  for (let i = 0; i < flagged.length; i += CHUNK) {
    const chunk = flagged.slice(i, i + CHUNK);
    await Promise.all([fetch({ id: { $oneof: chunk } }), fetch({ parent_id: { $oneof: chunk } })]);
  }
  const list = [...rows.values()];
  return {
    empty: list.length === 0,
    rows: list,
    ids: new Set(list.map((r) => r.id)),
    // Ids of excluded rows dated within [start, end] (YYYY-MM-DD, inclusive;
    // either bound optional): what a date-ranged query has to leave out.
    idsBetween(start, end) {
      return list.filter((r) => (!start || r.date >= start) && (!end || r.date <= end)).map((r) => r.id);
    },
    // category id -> sum of the excluded amounts of that category in `month`
    // (YYYY-MM): split lines count by their own category, split parents (no
    // category of their own) and off-budget accounts do not count, as in
    // Actual's own spent.
    addBack(month) {
      const sums = new Map();
      for (const r of list) {
        if (r.is_parent || !r.category || r['account.offbudget'] || typeof r.date !== 'string' || !r.date.startsWith(month)) continue;
        sums.set(r.category, (sums.get(r.category) || 0) + (Number.isInteger(r.amount) ? r.amount : 0));
      }
      return sums;
    },
  };
}

// An AQL clause: the id is none of `ids` (nested so no $and gets deeper than
// AQL allows), or null when there is nothing to leave out.
function notInClause(ids) {
  const list = [...new Set(ids)].slice(0, MAX_FILTER_IDS);
  if (list.length === 0) return null;
  const chunks = [];
  for (let i = 0; i < list.length; i += NOT_IN_CHUNK) chunks.push({ $and: list.slice(i, i + NOT_IN_CHUNK).map((id) => ({ id: { $ne: id } })) });
  return { $and: chunks };
}

// `filter` without the excluded rows dated in [start, end].
function withoutExcluded(filter, exclusions, start, end) {
  const clause = notInClause(exclusions.idsBetween(start, end));
  return clause ? { $and: [filter, clause] } : filter;
}

// The month's budget with excluded transactions added back: per expense
// category spent_adj = spent - sum(excluded amounts) and balance_adj =
// balance - sum(...), the totals by the same amounts. Income groups are left
// alone (as is the rollover from earlier months). Returns the input itself
// when nothing is excluded in that month.
function adjustBudgetMonth(budgetMonth, exclusions, month) {
  if (!budgetMonth || exclusions.empty) return budgetMonth;
  const add = exclusions.addBack(month);
  if (add.size === 0) return budgetMonth;
  let total = 0;
  const categoryGroups = (budgetMonth.categoryGroups || []).map((group) => {
    if (isIncome(group)) return group;
    return {
      ...group,
      categories: (group.categories || []).map((c) => {
        const sum = !isIncome(group, c) && add.get(c.id);
        if (!sum) return c;
        total += sum;
        return { ...c, spent: (c.spent ?? 0) - sum, balance: (c.balance ?? 0) - sum };
      }),
    };
  });
  const bump = (v) => (Number.isInteger(v) ? v - total : v);
  return { ...budgetMonth, categoryGroups, totalSpent: bump(budgetMonth.totalSpent), totalBalance: bump(budgetMonth.totalBalance) };
}

// getBudgetMonth(month) with the exclusions applied.
async function adjustedBudgetMonth(client, month) {
  const [budgetMonth, exclusions] = await Promise.all([client.getBudgetMonth(month), loadExclusions(client)]);
  return adjustBudgetMonth(budgetMonth, exclusions, month);
}

module.exports = { loadExclusions, notInClause, withoutExcluded, adjustBudgetMonth, adjustedBudgetMonth, EMPTY };
