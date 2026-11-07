const { getActualClient } = require('../../actual-client');
const { MAX_BUDGETED, badRequest, notFound, isHidden, isIncome, monthWithinWindow } = require('./common');
const { readTransactionRow, buildTransactionDetail, budgetCategory, budgetTotals } = require('./read');
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

const clipLog = (value) => (typeof value === 'string' ? value.slice(0, 80) : value);

// Change any of a transaction's category, notes and cleared flag (`changes`
// holds exactly the keys the caller sent). Everything is validated before
// anything is touched; one updateTransaction carries the fields that really
// change, and the answer is the transaction detail as it is afterwards.
async function updateTransactionFields({ tokenId, transactionId, changes }) {
  return exclusive(async () => {
    const client = await getActualClient();

    const row = await readTransactionRow(client, transactionId);
    if (!row) throw notFound();
    const current = row.transaction;

    if ('category' in changes) {
      if (current.transfer || current.split || row.accountClosed) throw badRequest();
      if (changes.category !== null) await requireExpenseCategory(client, changes.category);
    }
    // A reconciliation locks the cleared flag; notes and category stay editable.
    if ('cleared' in changes && row.reconciled && changes.cleared !== current.cleared) throw badRequest();

    const before = {};
    const after = {};
    const fields = {};
    if ('category' in changes) {
      const was = current.category ? current.category.id : null;
      if (changes.category !== was) {
        fields.category = changes.category;
        before.category = was;
        after.category = changes.category;
      }
    }
    if ('notes' in changes) {
      const next = changes.notes === '' ? null : changes.notes;
      if (next !== current.notes) {
        fields.notes = next;
        before.notes = clipLog(current.notes);
        after.notes = clipLog(next);
      }
    }
    if ('cleared' in changes && changes.cleared !== current.cleared) {
      fields.cleared = changes.cleared;
      before.cleared = current.cleared;
      after.cleared = changes.cleared;
    }

    if (Object.keys(fields).length > 0) {
      await client.updateTransaction(transactionId, fields);
      await appendAudit({ tokenId, op: 'transaction.update', ids: { transaction: transactionId }, before, after });
      await syncNow(client);
    }

    const detail = await buildTransactionDetail(client, transactionId);
    if (!detail) throw notFound();
    return { schema: 1, transaction: detail };
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

module.exports = { updateTransactionFields, setBudgetedAmount, moveBudget };
