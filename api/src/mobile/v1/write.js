const { getActualClient } = require('../../actual-client');
const { MAX_BUDGETED, badRequest, notFound, clip, isHidden, isIncome, monthWithinWindow } = require('./common');
const { readTransactionRow, budgetCategory, budgetTotals } = require('./read');
const { appendAudit } = require('./audit');

// The write side of /api/mobile/v1. These change a real budget, so every
// operation: runs alone (one write at a time, server-wide), validates
// everything against fresh data before touching anything, appends one audit
// line, syncs to the Actual server at once (not throttled), and answers with
// what the budget looks like now.

// One write at a time. A failed write doesn't wedge the chain for the next.
let tail = Promise.resolve();
function exclusive(task) {
  const run = tail.then(task);
  tail = run.catch(() => {});
  return run;
}

// Push the change to the Actual server now so the other devices see it. The
// write is already saved locally and audited, so a failed sync is logged (code
// only) and the next sync retries; it must not turn a success into an error,
// which a client might retry (a move is not idempotent).
async function syncNow(client) {
  try {
    await client.sync();
  } catch (err) {
    console.error('mobile write: sync failed:', err && err.code ? err.code : 'unexpected error');
  }
}

async function findCategory(client, categoryId) {
  for (const group of (await client.getCategoryGroups()) || []) {
    for (const category of group.categories || []) {
      if (category.id === categoryId) return { group, category };
    }
  }
  return null;
}

// An expense category the phone may point money at: it exists, is visible and
// is not an income category.
async function requireExpenseCategory(client, categoryId) {
  const found = await findCategory(client, categoryId);
  if (!found) throw notFound();
  if (isHidden(found.group, found.category) || isIncome(found.group, found.category)) throw badRequest();
  return found;
}

// Set or clear the category of one transaction.
async function categorizeTransaction({ tokenId, transactionId, categoryId }) {
  return exclusive(async () => {
    const client = await getActualClient();

    const row = await readTransactionRow(client, transactionId);
    if (!row) throw notFound();
    if (row.transaction.transfer || row.transaction.split || row.accountClosed) throw badRequest();

    let categoryName = null;
    if (categoryId !== null) {
      const { category } = await requireExpenseCategory(client, categoryId);
      categoryName = clip(category.name);
    }

    const before = row.transaction.category ? row.transaction.category.id : null;
    await client.updateTransaction(transactionId, { category: categoryId });
    await appendAudit({ tokenId, op: 'transaction.categorize', ids: { transaction: transactionId }, before: { category: before }, after: { category: categoryId } });
    await syncNow(client);

    const after = await readTransactionRow(client, transactionId);
    const transaction = after
      ? after.transaction
      : { ...row.transaction, category: categoryId === null ? null : { id: categoryId, name: categoryName } };
    return { schema: 1, transaction };
  });
}

function findLine(budgetMonth, categoryId) {
  for (const group of budgetMonth.categoryGroups || []) {
    for (const category of group.categories || []) if (category.id === categoryId) return category;
  }
  return null;
}

function assertMonth(month) {
  if (!monthWithinWindow(month)) throw badRequest();
}

// Set one category's budgeted amount for a month.
async function setBudgetedAmount({ tokenId, month, categoryId, budgeted }) {
  return exclusive(async () => {
    assertMonth(month);
    const client = await getActualClient();
    await requireExpenseCategory(client, categoryId);

    const current = findLine(await client.getBudgetMonth(month), categoryId);
    if (!current) throw notFound();

    await client.setBudgetAmount(month, categoryId, budgeted);
    await appendAudit({
      tokenId,
      op: 'budget.set',
      ids: { month, category: categoryId },
      before: { budgeted: current.budgeted },
      after: { budgeted },
    });
    await syncNow(client);

    const fresh = await client.getBudgetMonth(month);
    const line = findLine(fresh, categoryId);
    return { schema: 1, month, categories: [budgetCategory(line || { ...current, budgeted })], totals: budgetTotals(fresh) };
  });
}

// Move budgeted money from one category to another in a month. Both current
// amounts are read here, inside the lock, so a stale screen can't overdraw.
async function moveBudget({ tokenId, month, from, to, amount }) {
  return exclusive(async () => {
    assertMonth(month);
    if (from === to) throw badRequest();
    const client = await getActualClient();
    await requireExpenseCategory(client, from);
    await requireExpenseCategory(client, to);

    const budgetMonth = await client.getBudgetMonth(month);
    const fromLine = findLine(budgetMonth, from);
    const toLine = findLine(budgetMonth, to);
    if (!fromLine || !toLine) throw notFound();

    const fromBefore = fromLine.budgeted;
    const toBefore = toLine.budgeted;
    if (!Number.isInteger(fromBefore) || !Number.isInteger(toBefore)) throw badRequest();
    const fromAfter = fromBefore - amount;
    const toAfter = toBefore + amount;
    // Never take a category below zero, and keep the result inside the range
    // a budgeted amount may have.
    if (fromAfter < 0 || toAfter > MAX_BUDGETED) throw badRequest();

    await client.batchBudgetUpdates(async () => {
      await client.setBudgetAmount(month, from, fromAfter);
      await client.setBudgetAmount(month, to, toAfter);
    });
    await appendAudit({
      tokenId,
      op: 'budget.move',
      ids: { month, from, to },
      amount,
      before: { from: fromBefore, to: toBefore },
      after: { from: fromAfter, to: toAfter },
    });
    await syncNow(client);

    const fresh = await client.getBudgetMonth(month);
    const lines = [from, to].map((id, i) => findLine(fresh, id) || { ...(i === 0 ? fromLine : toLine), budgeted: i === 0 ? fromAfter : toAfter });
    return { schema: 1, month, categories: lines.map(budgetCategory), totals: budgetTotals(fresh) };
  });
}

module.exports = { categorizeTransaction, setBudgetedAmount, moveBudget };
