const { q } = require('@actual-app/api');

const { daysInMonthFor } = require('./month-days');

// Spending-breakdown queries shared by routes/spending-breakdown.js (the web
// widgets) and mobile/v1/spending.js (the native drill-down).

// First and last calendar day of `month` (YYYY-MM), as AQL date-range
// bounds. Deliberately simple string math (not a Date object, and not a
// loot-core import) — `transactions.date` is a plain `YYYY-MM-DD` string
// field in the AQL schema, so this just needs to produce the right strings,
// the same reasoning behind month-days.js's daysInMonthFor() helper, reused
// here for the "last day" calculation.
function monthBounds(month) {
  const [yearStr, monthStr] = month.split('-');
  const lastDay = daysInMonthFor(Number(yearStr), Number(monthStr));
  const pad = (n) => String(n).padStart(2, '0');
  return {
    monthStart: `${yearStr}-${monthStr}-01`,
    monthEnd: `${yearStr}-${monthStr}-${pad(lastDay)}`,
  };
}

// Indexes a `select('*')` row array by id — the same "fetch once, index by
// id, join in JS" pattern budget-pacing.js's indexCategoriesById()
// establishes, generalized here for whichever lookup table a given level
// needs (category_groups / categories / payees).
function indexById(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    byId.set(row.id, row);
  }
  return byId;
}

// Actual stores outflows (spending) as *negative* amounts internally (same
// convention documented in budget-pacing.js's indexCategoriesById()), so an
// AQL $sum over `amount` for a slice of spending-heavy transactions comes
// back negative. This API's contract is "amountCents is positive spending",
// so we negate once here, at the boundary.
function toPositiveSpendingCents(rawAmountCents) {
  return -(rawAmountCents ?? 0);
}

// Builds the final slice list from raw grouped AQL rows: negates each row's
// amount into positive spending cents, resolves its id/label via
// `resolveIdentity` (level-specific — joins against the right lookup
// table), and omits zero-activity and net-inflow slices (amountCents <= 0
// after negation) — the donut shows spending, not net flow. A row whose
// identity can't be resolved (e.g. an uncategorized transaction with no
// group/category) is also omitted, since it has nothing to label.
function buildSlices(rows, resolveIdentity) {
  const slices = [];
  for (const row of rows || []) {
    const amountCents = toPositiveSpendingCents(row.amountCents);
    if (amountCents <= 0) continue;

    const identity = resolveIdentity(row);
    if (!identity) continue;

    slices.push({ id: identity.id, label: identity.label, amountCents });
  }
  return slices;
}

// `groupIds`, when non-empty, restricts the breakdown to exactly that list
// of groups (a user-curated subset, e.g. a standalone donut widget
// configured to show only a few groups) instead of every expense group.
async function breakdownByGroups(client, baseFilter, groupIds) {
  const filter = { ...baseFilter, 'category.group.is_income': false };
  if (groupIds.length > 0) {
    filter['category.group'] = { $oneof: groupIds };
  }

  const [{ data: rows }, { data: groupRows }] = await Promise.all([
    client.aqlQuery(
      q('transactions')
        .filter(filter)
        .groupBy('category.group')
        .select([{ groupId: 'category.group' }, { amountCents: { $sum: '$amount' } }])
    ),
    client.aqlQuery(q('category_groups').select('*')),
  ]);

  const groupsById = indexById(groupRows);

  return buildSlices(rows, (row) => {
    const group = groupsById.get(row.groupId);
    return group ? { id: row.groupId, label: group.name } : null;
  });
}

async function breakdownByCategories(client, baseFilter, groupId) {
  const [{ data: rows }, { data: categoryRows }] = await Promise.all([
    client.aqlQuery(
      q('transactions')
        .filter({ ...baseFilter, 'category.group': groupId })
        .groupBy('category')
        .select([{ categoryId: 'category' }, { amountCents: { $sum: '$amount' } }])
    ),
    client.aqlQuery(q('categories').select('*')),
  ]);

  const categoriesById = indexById(categoryRows);

  return buildSlices(rows, (row) => {
    const category = categoriesById.get(row.categoryId);
    return category ? { id: row.categoryId, label: category.name } : null;
  });
}

// A rollup's member categories are an arbitrary, user-curated list that
// doesn't necessarily correspond to any single real Actual group (that's
// the whole point of a rollup), so this groups by `category` directly and
// restricts to exactly that id list, rather than filtering by group
// membership the way breakdownByCategories does.
async function breakdownByCategoryIds(client, baseFilter, categoryIds) {
  const [{ data: rows }, { data: categoryRows }] = await Promise.all([
    client.aqlQuery(
      q('transactions')
        .filter({ ...baseFilter, category: { $oneof: categoryIds } })
        .groupBy('category')
        .select([{ categoryId: 'category' }, { amountCents: { $sum: '$amount' } }])
    ),
    client.aqlQuery(q('categories').select('*')),
  ]);

  const categoriesById = indexById(categoryRows);

  return buildSlices(rows, (row) => {
    const category = categoriesById.get(row.categoryId);
    return category ? { id: row.categoryId, label: category.name } : null;
  });
}

async function breakdownByPayees(client, baseFilter, categoryId) {
  const [{ data: rows }, { data: payeeRows }] = await Promise.all([
    client.aqlQuery(
      q('transactions')
        .filter({ ...baseFilter, category: categoryId })
        .groupBy('payee')
        .select([{ payeeId: 'payee' }, { amountCents: { $sum: '$amount' } }])
    ),
    client.aqlQuery(q('payees').select('*')),
  ]);

  const payeesById = indexById(payeeRows);

  return buildSlices(rows, (row) => {
    // A transaction with no payee (e.g. a starting-balance entry) groups
    // under a null payee id; surface it as its own labeled slice rather than
    // dropping it or crashing on a missing lookup.
    if (row.payeeId == null) {
      return { id: null, label: '(No payee)' };
    }
    const payee = payeesById.get(row.payeeId);
    return payee ? { id: row.payeeId, label: payee.name } : null;
  });
}

// Individual transaction line items for one (categoryId, payeeId) pair --
// the leaf level, one step past the payees donut. `payeeId === null` means
// the NO_PAYEE_SENTINEL bucket (see its own comment above). Unlike the
// other three levels, this never calls buildSlices: a transaction list
// isn't donut-slice data, so the route returns it under its own
// `transactions` key instead of `{ total, slices }`.
async function transactionsForCategoryAndPayee(client, baseFilter, categoryId, payeeId) {
  const filter = { ...baseFilter, category: categoryId, payee: payeeId };
  const { data: rows } = await client.aqlQuery(
    q('transactions')
      .filter(filter)
      .select(['id', 'date', 'amount', 'notes', 'imported_payee'])
      .options({ splits: 'inline' })
  );

  return rows
    .map((row) => ({
      id: row.id,
      date: row.date,
      amountCents: toPositiveSpendingCents(row.amount),
      notes: row.notes ?? null,
      importedPayee: row.imported_payee ?? null,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// The filter every level starts from: a month or one day, no deleted rows,
// and transfers between accounts left out (see the route for why).
function baseFilterFor(dateFilter) {
  return { ...dateFilter, tombstone: false, transfer_id: null };
}

module.exports = {
  monthBounds,
  indexById,
  buildSlices,
  baseFilterFor,
  breakdownByGroups,
  breakdownByCategories,
  breakdownByCategoryIds,
  breakdownByPayees,
  transactionsForCategoryAndPayee,
};
