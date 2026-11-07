const { q } = require('@actual-app/api');

const { dateRange } = require('../../aql-date-range');
const {
  monthBounds,
  baseFilterFor,
  indexById,
  breakdownByCategoryIds,
  breakdownByPayees,
  transactionsForCategoryAndPayee,
} = require('../../spending-data');
const { loadColorResolver } = require('./colors');
const { loadExclusions, withoutExcluded } = require('./exclusions');
const { ID_PATTERN, MAX_NAME, MAX_NOTE, clip, money } = require('./common');

// GET /spending: the native drill-down behind a pacing row. It reuses the
// queries behind the web breakdown route (spending-data.js), so both agree on
// what counts as spending: transfers and deleted rows are out, and a slice
// with net inflow is left out. Amounts are positive cents.

const NO_PAYEE_ID = '__none__';
const MAX_TRANSACTIONS = 100;
const MAX_ITEMS = 200;
const PAYEE_ID_PATTERN = /^([A-Za-z0-9_-]{1,64}|__none__)$/;

const sumOf = (rows) => rows.reduce((total, row) => total + row.amount, 0);

// The month's spending rows, minus excluded and hidden transactions.
function monthFilter(month, exclusions) {
  const { monthStart, monthEnd } = monthBounds(month);
  return withoutExcluded(baseFilterFor(dateRange(monthStart, monthEnd)), exclusions, monthStart, monthEnd);
}

// A generic title for a rollup: the group's name when every category is in
// the same group, else 'Selected categories'. Never a category's own name.
async function rollupTitle(client, categoryIds) {
  const groups = (await client.getCategoryGroups()) || [];
  const groupOf = new Map();
  for (const group of groups) for (const category of group.categories || []) groupOf.set(category.id, group);
  const found = categoryIds.map((id) => groupOf.get(id));
  const first = found[0];
  if (first && first.name && found.every((g) => g === first)) return clip(first.name);
  return 'Selected categories';
}

async function categoriesLevel(client, month, categoryIds, exclusions) {
  const [slices, title, colors] = await Promise.all([
    breakdownByCategoryIds(client, monthFilter(month, exclusions), categoryIds),
    rollupTitle(client, categoryIds),
    loadColorResolver(client),
  ]);
  const items = slices
    .filter((s) => ID_PATTERN.test(String(s.id)))
    .slice(0, MAX_ITEMS)
    .map((s) => ({
      id: s.id,
      label: clip(s.label),
      amount: money(s.amountCents),
      drill: { level: 'payees', categoryId: s.id },
      ...colors.categoryField(s.id),
    }));
  return { title, total: sumOf(items), items, transactions: [] };
}

async function categoryName(client, categoryId) {
  const { data } = await client.aqlQuery(q('categories').select('*'));
  const category = indexById(data).get(categoryId);
  return category && category.name ? clip(category.name) : 'Category';
}

async function payeesLevel(client, month, categoryId, exclusions) {
  const [slices, title] = await Promise.all([
    breakdownByPayees(client, monthFilter(month, exclusions), categoryId),
    categoryName(client, categoryId),
  ]);
  const items = slices
    .map((s) => ({ ...s, id: s.id == null ? NO_PAYEE_ID : s.id }))
    .filter((s) => PAYEE_ID_PATTERN.test(String(s.id)))
    .slice(0, MAX_ITEMS)
    .map((s) => ({
      id: s.id,
      label: s.id === NO_PAYEE_ID ? 'No payee' : clip(s.label),
      amount: money(s.amountCents),
      drill: { level: 'transactions', categoryId, payeeId: s.id },
    }));
  return { title, total: sumOf(items), items, transactions: [] };
}

async function transactionsLevel(client, month, categoryId, payeeId, exclusions) {
  const none = payeeId === NO_PAYEE_ID;
  const [rows, payees] = await Promise.all([
    transactionsForCategoryAndPayee(client, monthFilter(month, exclusions), categoryId, none ? null : payeeId),
    none ? Promise.resolve(null) : client.aqlQuery(q('payees').select('*')).then((r) => r.data),
  ]);
  const payeeName = none ? null : (() => {
    const payee = indexById(payees).get(payeeId);
    return payee && payee.name ? clip(payee.name) : null;
  })();
  const transactions = rows
    .filter((r) => ID_PATTERN.test(String(r.id)) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)))
    .slice(0, MAX_TRANSACTIONS)
    .map((r) => ({
      id: r.id,
      date: r.date,
      payee: payeeName,
      amount: money(r.amountCents),
      notes: r.notes ? clip(r.notes, MAX_NOTE) : null,
    }));
  return { title: payeeName || (none ? 'No payee' : 'Payee'), total: sumOf(transactions), items: [], transactions };
}

// `scope`: { level, categoryIds | categoryId | categoryId + payeeId }, already validated.
async function buildSpending(client, month, scope, now = new Date()) {
  let body;
  const exclusions = await loadExclusions(client);
  if (scope.level === 'categories') body = await categoriesLevel(client, month, scope.categoryIds, exclusions);
  else if (scope.level === 'payees') body = await payeesLevel(client, month, scope.categoryId, exclusions);
  else body = await transactionsLevel(client, month, scope.categoryId, scope.payeeId, exclusions);
  return {
    schema: 1,
    generatedAt: now.toISOString(),
    month,
    level: scope.level,
    title: clip(body.title, MAX_NAME),
    total: money(body.total),
    items: body.items,
    transactions: body.transactions,
  };
}

module.exports = { buildSpending, NO_PAYEE_ID };
