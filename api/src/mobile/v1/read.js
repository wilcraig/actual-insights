const { q } = require('@actual-app/api');

const { DATE_PATTERN, ID_PATTERN, MAX_NOTE, badRequest, notFound, clip, isValidId, money, isHidden, isIncome } = require('./common');

// The read side of /api/mobile/v1: pure builders from the Actual client to the
// schema's response bodies (native-v1.schema.json). Nothing here writes.

const MAX_ACCOUNTS = 100;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const CURSOR_PATTERN = /^c_([0-9]{4}-[0-9]{2}-[0-9]{2})_([A-Za-z0-9_-]{1,64})$/;

// Every field a transaction row needs, with names and flags resolved by AQL's
// joins. `tombstone` is selected only to double-check the "never a deleted
// row" rule: AQL already hides tombstoned rows (withDead is off).
const TX_FIELDS = [
  'id',
  'date',
  'account',
  'account.name',
  'account.closed',
  'payee.name',
  'payee.transfer_acct',
  'category',
  'category.name',
  'category.group.name',
  'amount',
  'notes',
  'cleared',
  'transfer_id',
  'is_parent',
  'tombstone',
];

async function readCurrency(client) {
  const rows = await client.aqlQuery(q('preferences').filter({ id: 'defaultCurrencyCode' }).select('*'));
  const value = rows && rows.data && rows.data[0] && rows.data[0].value;
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : 'USD';
}

async function buildCurrency(client) {
  return { currency: await readCurrency(client) };
}

async function buildAccounts(client, now = new Date()) {
  const open = ((await client.getAccounts()) || [])
    .filter((account) => !account.closed && isValidId(account.id))
    // On-budget first, then off-budget, each by name; sorted before the cap so a
    // long off-budget list can never push an on-budget account out.
    .sort((a, b) => Boolean(a.offbudget) - Boolean(b.offbudget) || String(a.name).localeCompare(String(b.name)))
    .slice(0, MAX_ACCOUNTS);
  const accounts = await Promise.all(
    open.map(async (account) => {
      let balance = null;
      try {
        balance = await client.getAccountBalance(account.id);
        if (!Number.isInteger(balance)) balance = null;
      } catch {
        balance = null;
      }
      return { id: account.id, name: clip(account.name), balance: balance === null ? null : money(balance), onBudget: !account.offbudget };
    })
  );
  return { schema: 1, generatedAt: now.toISOString(), accounts };
}

// One AQL row -> the schema's transaction. Null when the row can't be shown
// (a deleted row, or an id the schema would not accept).
function mapTransaction(row) {
  if (!row || row.tombstone) return null;
  if (!isValidId(row.id) || !isValidId(row.account) || !DATE_PATTERN.test(String(row.date))) return null;
  const transfer = row.transfer_id != null;
  let payee = row['payee.name'] == null ? null : clip(row['payee.name']);
  // A transfer's payee is the other account's name; say so.
  if (payee !== null && (transfer || row['payee.transfer_acct'] != null)) payee = clip(`Transfer: ${row['payee.name']}`);
  const category = isValidId(row.category) ? { id: row.category, name: clip(row['category.name']) } : null;
  const notes = row.notes == null || row.notes === '' ? null : clip(row.notes, MAX_NOTE);
  return {
    id: row.id,
    date: row.date,
    accountId: row.account,
    accountName: clip(row['account.name']),
    payee,
    amount: money(row.amount),
    category,
    categoryGroup: category && row['category.group.name'] != null ? clip(row['category.group.name']) : null,
    notes,
    cleared: Boolean(row.cleared),
    transfer,
    split: Boolean(row.is_parent),
  };
}

const MAX_IMPORTED_ID = 200;
const MAX_TAGS = 20;
const MAX_TAG = 50;
const MAX_SPLITS = 50;

// #tags in a note: unique, without the '#', each at most 50 characters, at
// most 20 of them (a longer one is not a tag, it is a ramble).
function parseTags(notes) {
  const tags = [];
  for (const match of String(notes ?? '').matchAll(/(?<![#\w])#([^\s#]+)/g)) {
    const tag = match[1];
    if (tag.length <= MAX_TAG && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

// The same row plus what the write side needs to judge it.
function mapTransactionForWrite(row) {
  const transaction = mapTransaction(row);
  return transaction && { transaction, accountClosed: Boolean(row['account.closed']) };
}

function decodeCursor(cursor) {
  const match = CURSOR_PATTERN.exec(cursor);
  if (!match || !DATE_PATTERN.test(match[1])) throw badRequest();
  return { date: match[1], id: match[2] };
}

// Rows the uncategorized view keeps: spending or income rows with no
// category, not transfers, not split parents, on-budget and open accounts.
const UNCATEGORIZED_FILTER = [
  { category: null },
  { transfer_id: null },
  { is_parent: false },
  { 'account.offbudget': false },
  { 'account.closed': false },
];

function transactionFilters({ account, uncategorized, group, category }) {
  const filters = [];
  // Without an account, only open accounts' rows: a closed account can't be
  // edited and is not in /accounts either.
  if (account) filters.push({ account });
  else filters.push({ 'account.closed': false });
  if (uncategorized) filters.push(...UNCATEGORIZED_FILTER);
  // Where the money went: a group matches every category in it.
  if (group) filters.push({ 'category.group': group });
  if (category) filters.push({ category });
  return filters;
}

// Splits 'none' keeps split parents (flagged) and drops their children, which
// are never shown on their own.
const baseTransactionQuery = () => q('transactions').options({ splits: 'none' });

async function assertAccountExists(client, accountId) {
  const accounts = (await client.getAccounts()) || [];
  if (!accounts.some((a) => a.id === accountId)) throw notFound();
}

// params: { account?, uncategorized: boolean, group?, category?, limit, cursor? } (already validated).
async function buildTransactions(client, params, now = new Date()) {
  const { account, uncategorized = false, group, category, limit = DEFAULT_LIMIT, cursor } = params;
  if (account) await assertAccountExists(client, account);

  const filters = transactionFilters({ account, uncategorized, group, category });
  const pageFilters = [...filters];
  if (cursor) {
    const after = decodeCursor(cursor);
    pageFilters.push({ $or: [{ date: { $lt: after.date } }, { $and: [{ date: after.date }, { id: { $lt: after.id } }] }] });
  }

  const { data } = await client.aqlQuery(
    baseTransactionQuery()
      .filter({ $and: pageFilters })
      .orderBy([{ date: 'desc' }, { id: 'desc' }])
      .select(TX_FIELDS)
      // One extra row says whether there is another page.
      .limit(limit + 1)
  );

  const rows = data || [];
  const hasMore = rows.length > limit;
  const transactions = rows.slice(0, limit).map(mapTransaction).filter(Boolean);
  // The cursor is the last row of the page as fetched (not of the rows that
  // could be shown), so an unshowable trailing row can't repeat or skip anything.
  const lastRow = rows[limit - 1];
  const nextCursor = hasMore && lastRow && isValidId(lastRow.id) && DATE_PATTERN.test(String(lastRow.date)) ? `c_${lastRow.date}_${lastRow.id}` : null;

  const body = { schema: 1, generatedAt: now.toISOString(), transactions, nextCursor };

  if (!cursor) {
    const count = await client.aqlQuery(
      baseTransactionQuery()
        .filter({ $and: transactionFilters({ account, uncategorized: true }) })
        .calculate({ $count: '$id' })
    );
    const value = count && count.data;
    body.uncategorizedCount = Math.max(0, Math.min(1000000, Number.isInteger(value) ? value : 0));
  }
  return body;
}

const DETAIL_FIELDS = [...TX_FIELDS, 'imported_payee', 'imported_id', 'reconciled', 'schedule', 'schedule.name'];

// The detail screen's transaction, or null when there is no such addressable
// row (unknown, deleted, or a split line, which is never addressable).
async function buildTransactionDetail(client, id) {
  const { data } = await client.aqlQuery(baseTransactionQuery().filter({ id }).select(DETAIL_FIELDS).limit(1));
  const row = data && data[0];
  const base = mapTransaction(row);
  if (!base) return null;

  let splits = [];
  if (row.is_parent) {
    const children = await client.aqlQuery(
      q('transactions')
        .options({ splits: 'all' })
        .filter({ parent_id: id })
        .select(['id', 'category', 'category.name', 'amount', 'notes', 'sort_order', 'tombstone'])
        .orderBy([{ sort_order: 'desc' }, { id: 'asc' }])
    );
    splits = ((children && children.data) || [])
      .filter((c) => c && !c.tombstone)
      .slice(0, MAX_SPLITS)
      .map((c) => ({
        category: isValidId(c.category) ? { id: c.category, name: clip(c['category.name']) } : null,
        amount: money(c.amount),
        notes: c.notes == null || c.notes === '' ? null : clip(c.notes, MAX_NOTE),
      }));
  }

  let transferAccountName = null;
  if (row.transfer_id != null) {
    const paired = await client.aqlQuery(baseTransactionQuery().filter({ id: row.transfer_id }).select(['id', 'account.name']).limit(1));
    const other = paired && paired.data && paired.data[0];
    if (other && other['account.name'] != null) transferAccountName = clip(other['account.name']);
  }

  return {
    ...base,
    reconciled: Boolean(row.reconciled),
    importedPayee: row.imported_payee == null || row.imported_payee === '' ? null : clip(row.imported_payee),
    importedId: row.imported_id == null || row.imported_id === '' ? null : clip(row.imported_id, MAX_IMPORTED_ID),
    recurring: row.schedule != null && row['schedule.name'] != null && row['schedule.name'] !== '' ? clip(row['schedule.name']) : null,
    tags: parseTags(base.notes),
    splits,
    transferAccountName,
  };
}

async function readTransactionRow(client, id) {
  const { data } = await client.aqlQuery(baseTransactionQuery().filter({ id }).select([...TX_FIELDS, 'reconciled']).limit(1));
  if (!data || !data[0]) return null;
  const result = mapTransactionForWrite(data[0]);
  return result && { ...result, reconciled: Boolean(data[0].reconciled) };
}

async function buildCategories(client, now = new Date()) {
  const groups = [];
  for (const group of (await client.getCategoryGroups()) || []) {
    if (group.hidden || !isValidId(group.id)) continue;
    groups.push({
      id: group.id,
      name: clip(group.name),
      isIncome: Boolean(group.is_income),
      categories: (group.categories || [])
        .filter((c) => !c.hidden && isValidId(c.id))
        .map((c) => ({ id: c.id, name: clip(c.name) })),
    });
  }
  return { schema: 1, generatedAt: now.toISOString(), groups: groups.slice(0, 100) };
}

function budgetCategory(category) {
  return {
    id: category.id,
    name: clip(category.name),
    budgeted: money(category.budgeted),
    spent: money(category.spent),
    balance: money(category.balance),
    carryover: Boolean(category.carryover),
  };
}

// Actual reports the month's total budgeted as a negative number (it is the
// sum taken out of "to budget"); the schema's is the plain positive sum.
function budgetTotals(budgetMonth) {
  const toBudget = Number.isInteger(budgetMonth.toBudget) ? money(budgetMonth.toBudget) : null;
  const totalBudgeted = Number.isInteger(budgetMonth.totalBudgeted) ? -budgetMonth.totalBudgeted : 0;
  return {
    toBudget,
    budgeted: money(totalBudgeted),
    spent: money(budgetMonth.totalSpent),
    balance: money(budgetMonth.totalBalance),
    income: money(budgetMonth.totalIncome),
  };
}

// Expense groups only, hidden ones left out; each group's sums come from the
// categories shown, so the numbers on screen always add up.
async function buildBudgetMonth(client, month, now = new Date()) {
  const budgetMonth = await client.getBudgetMonth(month);
  const groups = [];
  for (const group of (budgetMonth && budgetMonth.categoryGroups) || []) {
    if (isIncome(group) || isHidden(group) || !isValidId(group.id)) continue;
    const categories = (group.categories || []).filter((c) => !isIncome(group, c) && !isHidden(group, c) && isValidId(c.id)).map(budgetCategory);
    if (categories.length === 0) continue;
    groups.push({
      id: group.id,
      name: clip(group.name),
      budgeted: money(categories.reduce((sum, c) => sum + c.budgeted, 0)),
      spent: money(categories.reduce((sum, c) => sum + c.spent, 0)),
      balance: money(categories.reduce((sum, c) => sum + c.balance, 0)),
      categories,
    });
  }
  return { schema: 1, generatedAt: now.toISOString(), month, totals: budgetTotals(budgetMonth || {}), groups: groups.slice(0, 100) };
}

module.exports = {
  MAX_LIMIT,
  DEFAULT_LIMIT,
  CURSOR_PATTERN,
  ID_PATTERN,
  buildCurrency,
  buildAccounts,
  buildTransactions,
  buildCategories,
  buildBudgetMonth,
  readTransactionRow,
  buildTransactionDetail,
  parseTags,
  budgetCategory,
  budgetTotals,
  mapTransaction,
};
