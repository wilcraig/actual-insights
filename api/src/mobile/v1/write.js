const { scopedClient: getActualClient } = require('./hidden');
const { getActualClient: getRealActualClient } = require('../../actual-client');
const { MAX_BUDGETED, MAX_MONEY, MAX_NOTE, HttpError, badRequest, notFound, isHidden, isIncome, monthWithinWindow, clip } = require('./common');
const { getFlags, setFlags } = require('../../mobile-transaction-flags-store');
const { adjustedBudgetMonth } = require('./exclusions');
const { readTransactionRow, buildTransactionDetail, budgetCategory, budgetTotals } = require('./read');
const { appendAudit } = require('./audit');
const { loadColorResolver, createColorResolver } = require('./colors');
const { readColors } = require('../../mobile-colors-store');

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

// The flags a PATCH leaves a transaction with (`changes` may hold excluded
// and/or hidden). hidden implies excluded: hidden true makes it excluded,
// hidden false leaves excluded as it was, and excluded false on a hidden
// transaction (now or after this PATCH) is a 400.
function nextFlags(current, changes) {
  const hidden = 'hidden' in changes ? changes.hidden : current.hidden;
  let excluded = 'excluded' in changes ? changes.excluded : current.excluded;
  if (hidden) {
    if ('excluded' in changes && changes.excluded === false) throw badRequest();
    excluded = true;
  }
  return { excluded, hidden };
}

// Change any of a transaction's category, notes and cleared flag, and its
// Insights flags excluded and hidden (`changes` holds exactly the keys the
// caller sent). Everything is validated before anything is touched; one
// updateTransaction carries the Actual fields that really change (none for a
// flag-only change: no Actual call, no sync), the flags are written AFTER that
// succeeded (they live in Insights, not in Actual), and the answer is the
// transaction detail as it is afterwards.
async function updateTransactionFields({ tokenId, transactionId, changes }) {
  return exclusive(async () => {
    const client = await getActualClient();
    const plan = await planTransactionChange(client, transactionId, changes);
    await applyTransactionPlan({ client, tokenId, transactionId, plan, sync: true });

    const detail = await buildTransactionDetail(client, transactionId);
    if (!detail) throw notFound();
    return { schema: 1, transaction: detail };
  });
}

// Validates one transaction's change against fresh data and works out exactly
// what would be written, without writing anything. Throws 404 (no such
// transaction) or 400 (this change is not allowed on it).
async function planTransactionChange(client, transactionId, changes) {
  const row = await readTransactionRow(client, transactionId);
  if (!row) throw notFound();
  const current = row.transaction;

  if ('category' in changes) {
    if (current.transfer || current.split || row.accountClosed) throw badRequest();
    if (changes.category !== null) await requireExpenseCategory(client, changes.category);
  }
  // A reconciliation locks the cleared flag; notes and category stay editable.
  if ('cleared' in changes && row.reconciled && changes.cleared !== current.cleared) throw badRequest();

  const flagsBefore = await getFlags(transactionId);
  const flagsAfter = 'excluded' in changes || 'hidden' in changes ? nextFlags(flagsBefore, changes) : flagsBefore;

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
  return { fields, before, after, flagsBefore, flagsAfter };
}

// Writes a plan from planTransactionChange: the Actual fields first (audited,
// and synced at once when `sync`), then the Insights flags (they live here, not
// in Actual). Returns whether anything changed.
async function applyTransactionPlan({ client, tokenId, transactionId, plan, sync }) {
  const { fields, before, after, flagsBefore, flagsAfter } = plan;
  let changed = false;
  if (Object.keys(fields).length > 0) {
    await client.updateTransaction(transactionId, fields);
    await appendAudit({ tokenId, op: 'transaction.update', ids: { transaction: transactionId }, before, after });
    if (sync) await syncNow(client);
    changed = true;
  }
  if (flagsAfter.excluded !== flagsBefore.excluded || flagsAfter.hidden !== flagsBefore.hidden) {
    try {
      await setFlags(transactionId, flagsAfter);
    } catch (err) {
      if (err && err.code === 'FULL') throw badRequest();
      throw err;
    }
    await appendAudit({ tokenId, op: 'transaction.update', ids: { transaction: transactionId }, before: { ...flagsBefore }, after: { ...flagsAfter } });
    changed = true;
  }
  return changed;
}

// The web's bulk edit (category, cleared, excluded, hidden on up to MAX_BULK
// transactions). One pass under the write lock: every id is planned against
// fresh data first (an unknown id is a 404 and nothing is written); rows the
// change is not allowed on (transfer, split, reconciled, closed account...) are
// skipped and reported, the rest are written, and Actual is synced ONCE at the
// end. The owner's web view is not scoped to the phone's hidden accounts.
const MAX_BULK = 50;
async function updateTransactionsBulk({ tokenId, ids, changes }) {
  return exclusive(async () => {
    const client = await getRealActualClient();
    const plans = [];
    const skipped = [];
    for (const id of ids) {
      try {
        plans.push({ id, plan: await planTransactionChange(client, id, changes) });
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) skipped.push({ id, reason: 'not_allowed' });
        else throw err;
      }
    }
    const updated = [];
    const unchanged = [];
    let wroteActual = false;
    for (const { id, plan } of plans) {
      try {
        const changed = await applyTransactionPlan({ client, tokenId, transactionId: id, plan, sync: false });
        if (changed) {
          updated.push(id);
          if (Object.keys(plan.fields).length > 0) wroteActual = true;
        } else unchanged.push(id);
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) skipped.push({ id, reason: 'not_allowed' });
        else throw err;
      }
    }
    if (wroteActual) await syncNow(client);
    return { schema: 1, updated, unchanged, skipped };
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

    const fresh = await adjustedBudgetMonth(client, month);
    const line = findLine(fresh, categoryId);
    const colors = await loadColorResolver(client);
    return { schema: 1, month, categories: [budgetCategory(line || { ...current, budgeted }, colors)], totals: budgetTotals(fresh) };
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

    const fresh = await adjustedBudgetMonth(client, month);
    const lines = [from, to].map((id, i) => findLine(fresh, id) || { ...(i === 0 ? fromLine : toLine), budgeted: i === 0 ? fromAfter : toAfter });
    const colors = await loadColorResolver(client);
    return { schema: 1, month, categories: lines.map((l) => budgetCategory(l, colors)), totals: budgetTotals(fresh) };
  });
}

const currentMonth = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const conflict = () => new HttpError(409, 'conflict');

// New expense category group. A name already used by a visible group (any
// case) is a 409.
async function createGroup({ tokenId, name }) {
  return exclusive(async () => {
    const client = await getActualClient();
    const groups = (await client.getCategoryGroups()) || [];
    if (groups.some((g) => !g.hidden && sameName(g.name, name))) throw conflict();

    const id = await client.createCategoryGroup({ name, is_income: false });
    await appendAudit({ tokenId, op: 'category-group.create', ids: { group: id }, after: { name: clipLog(name) } });
    await syncNow(client);

    const fresh = (await client.getCategoryGroups()) || [];
    const colors = createColorResolver(fresh, await readColors());
    return { schema: 1, group: { id, name: clip(name), isIncome: false, categories: [], color: colors.group(id) } };
  });
}

// New category in a visible expense group; a name already in that group (any
// case, hidden categories too) is a 409. `budgeted`, when given, is set for
// the CURRENT month inside the same locked section, with one sync at the end.
async function createCategory({ tokenId, groupId, name, budgeted }) {
  return exclusive(async () => {
    const client = await getActualClient();
    const group = ((await client.getCategoryGroups()) || []).find((g) => g.id === groupId);
    if (!group) throw notFound();
    if (isHidden(group) || isIncome(group)) throw badRequest();
    if ((group.categories || []).some((c) => sameName(c.name, name))) throw conflict();

    const id = await client.createCategory({ name, group_id: groupId });
    await appendAudit({ tokenId, op: 'category.create', ids: { group: groupId, category: id }, after: { name: clipLog(name) } });
    if (budgeted !== undefined) {
      const month = currentMonth();
      await client.setBudgetAmount(month, id, budgeted);
      await appendAudit({ tokenId, op: 'budget.set', ids: { month, category: id }, before: { budgeted: 0 }, after: { budgeted } });
    }
    await syncNow(client);

    const colors = await loadColorResolver(client);
    return { schema: 1, groupId, category: { id, name: clip(name), color: colors.category(id) } };
  });
}

// Account groups (Actual's sidebar groups). Names are unique ignoring case; a
// deleted group leaves its accounts ungrouped (Actual does that itself).
async function accountGroupsOf(client) {
  if (typeof client.getAccountGroups !== 'function') throw notFound();
  return (await client.getAccountGroups()) || [];
}

async function createAccountGroup({ tokenId, name }) {
  return exclusive(async () => {
    const client = await getActualClient();
    const groups = await accountGroupsOf(client);
    if (groups.some((g) => sameName(g.name, name))) throw conflict();
    const id = await client.createAccountGroup({ name });
    await appendAudit({ tokenId, op: 'account-group.create', ids: { group: id }, after: { name: clipLog(name) } });
    await syncNow(client);
    return { schema: 1, group: { id, name: clip(name) } };
  });
}

async function renameAccountGroup({ tokenId, id, name }) {
  return exclusive(async () => {
    const client = await getActualClient();
    const groups = await accountGroupsOf(client);
    const group = groups.find((g) => g.id === id);
    if (!group) throw notFound();
    if (groups.some((g) => g.id !== id && sameName(g.name, name))) throw conflict();
    await client.updateAccountGroup(id, { name });
    await appendAudit({ tokenId, op: 'account-group.rename', ids: { group: id }, before: { name: clipLog(group.name) }, after: { name: clipLog(name) } });
    await syncNow(client);
    return { schema: 1, ok: true };
  });
}

async function deleteAccountGroup({ tokenId, id }) {
  return exclusive(async () => {
    const client = await getActualClient();
    const group = (await accountGroupsOf(client)).find((g) => g.id === id);
    if (!group) throw notFound();
    await client.deleteAccountGroup(id);
    await appendAudit({ tokenId, op: 'account-group.delete', ids: { group: id }, before: { name: clipLog(group.name) } });
    await syncNow(client);
    return { schema: 1, ok: true };
  });
}

// Puts one account into a group, or (groupId null) into none.
async function setAccountGroup({ tokenId, id, groupId }) {
  return exclusive(async () => {
    const client = await getActualClient();
    const account = ((await client.getAccounts()) || []).find((a) => a.id === id);
    if (!account) throw notFound();
    if (groupId !== null && !(await accountGroupsOf(client)).some((g) => g.id === groupId)) throw notFound();
    await client.updateAccount(id, { account_group_id: groupId });
    await appendAudit({ tokenId, op: 'account.group', ids: { account: id }, before: { group: account.account_group_id || null }, after: { group: groupId } });
    await syncNow(client);
    return { schema: 1, ok: true };
  });
}

module.exports = { MAX_BULK, updateTransactionsBulk, createGroup, createCategory, updateTransactionFields, splitTransactionLines, removeSplit, setBudgetedAmount, moveBudget, exclusive, syncNow, findCategory, createAccountGroup, renameAccountGroup, deleteAccountGroup, setAccountGroup };
