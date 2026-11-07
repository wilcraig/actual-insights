const { scopedClient: getActualClient } = require('./hidden');
const { MAX_BUDGETED, MAX_MONEY, MAX_NOTE, badRequest, notFound, isHidden, isIncome, monthWithinWindow } = require('./common');
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

const MIN_SPLITS = 2;
const MAX_SPLIT_LINES = 50;

// Category ids and amounts only (notes by length), so the audit line can
// rebuild what was split without carrying anyone's words.
const summariseLines = (lines) =>
  lines.map((line) => ({
    category: line.category && typeof line.category === 'object' ? line.category.id : line.category,
    amount: line.amount,
    notesLength: typeof line.notes === 'string' ? line.notes.length : 0,
  }));

// Both split operations refuse the same rows: transfers, reconciled
// transactions and closed accounts. (A split line is never addressable, so it
// is already a 404 before this.)
function assertSplittable(row) {
  if (row.transaction.transfer || row.reconciled || row.accountClosed) throw badRequest();
}

// Replace the split lines of a transaction (splitting it first when it is a
// normal one). Findings from the feasibility test against @actual-app/api
// 26.10: ONE updateTransaction(parentId, { subtransactions }) is atomic (a
// single diff in one batch) and works for both a plain and an already split
// parent: the old children are deleted and the new ones created with the
// parent's account, date, payee and cleared flag, the parent's category reads
// as null and its amount is untouched. sort_order must be given per line,
// otherwise every new line inherits the parent's and the order is lost.
async function splitTransactionLines({ tokenId, transactionId, splits }) {
  return exclusive(async () => {
    const client = await getActualClient();

    const row = await readTransactionRow(client, transactionId);
    if (!row) throw notFound();
    assertSplittable(row);
    const current = row.transaction;

    if (!Array.isArray(splits) || splits.length < MIN_SPLITS || splits.length > MAX_SPLIT_LINES) throw badRequest();
    const parentAmount = current.amount;
    if (!Number.isInteger(parentAmount) || parentAmount === 0 || Math.abs(parentAmount) >= MAX_MONEY) throw badRequest();
    const sign = Math.sign(parentAmount);
    let total = 0;
    for (const line of splits) {
      if (!Number.isSafeInteger(line.amount) || line.amount === 0 || Math.sign(line.amount) !== sign) throw badRequest();
      if (line.notes !== null && (typeof line.notes !== 'string' || line.notes.length > MAX_NOTE)) throw badRequest();
      total += line.amount;
    }
    if (total !== parentAmount) throw badRequest();

    // Every category must exist, be visible and not be income. An unknown or
    // unusable category is the caller's mistake: a 400, like the rest.
    const checked = new Map();
    for (const line of splits) {
      if (checked.has(line.category)) continue;
      const found = await findCategory(client, line.category);
      if (!found || isHidden(found.group, found.category) || isIncome(found.group, found.category)) throw badRequest();
      checked.set(line.category, true);
    }

    const detail = await buildTransactionDetail(client, transactionId);
    if (!detail) throw notFound();
    const before = current.split ? { splits: summariseLines(detail.splits) } : { category: current.category ? current.category.id : null, splits: [] };

    await client.updateTransaction(transactionId, {
      subtransactions: splits.map((line, index) => ({
        category: line.category,
        amount: line.amount,
        notes: line.notes === '' ? null : line.notes,
        sort_order: -(index + 1),
      })),
    });
    await appendAudit({
      tokenId,
      op: 'transaction.split',
      ids: { transaction: transactionId },
      amount: parentAmount,
      before,
      after: { splits: summariseLines(splits) },
    });
    await syncNow(client);

    const fresh = await buildTransactionDetail(client, transactionId);
    if (!fresh) throw notFound();
    return { schema: 1, transaction: fresh };
  });
}

// Remove the split: the transaction becomes a normal one with no category.
// Two calls are needed. The first (is_parent false, no lines) removes every
// line and un-splits the parent in one atomic change, but Actual keeps the
// category the transaction had BEFORE it was split on the parent row (hidden
// while split), and the diff cannot clear it in the same call because the
// grouped view already says null. So after a sync the category is cleared in
// a second call. Failure window: if that second call fails, the transaction is
// an ordinary unsplit one that shows its old pre-split category (consistent,
// nothing lost, the audit line is already written); the caller sees a 500 and
// can PATCH the category.
async function removeSplit({ tokenId, transactionId }) {
  return exclusive(async () => {
    const client = await getActualClient();

    const row = await readTransactionRow(client, transactionId);
    if (!row) throw notFound();
    assertSplittable(row);
    if (!row.transaction.split) throw badRequest();

    const detail = await buildTransactionDetail(client, transactionId);
    if (!detail) throw notFound();
    const before = { splits: summariseLines(detail.splits) };

    await client.updateTransaction(transactionId, { is_parent: false, subtransactions: [] });
    await appendAudit({
      tokenId,
      op: 'transaction.unsplit',
      ids: { transaction: transactionId },
      amount: row.transaction.amount,
      before,
      after: { category: null, splits: [] },
    });
    await syncNow(client);

    // Actual may hand back the pre-split category once the parent is a normal row again.
    const reread = await readTransactionRow(client, transactionId);
    if (reread && !reread.transaction.split && reread.transaction.category) {
      await client.updateTransaction(transactionId, { category: null });
      await syncNow(client);
    }

    const fresh = await buildTransactionDetail(client, transactionId);
    if (!fresh) throw notFound();
    return { schema: 1, transaction: fresh };
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

module.exports = { updateTransactionFields, splitTransactionLines, removeSplit, setBudgetedAmount, moveBudget, exclusive, syncNow, findCategory };
