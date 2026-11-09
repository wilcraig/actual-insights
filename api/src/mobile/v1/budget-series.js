const { scopedClient } = require('./hidden');
const { MAX_BUDGETED, HttpError, badRequest, notFound, isHidden, isIncome, clip, money, MONTH_PATTERN, MONTH_WINDOW } = require('./common');
const { exclusive, syncNow, findCategory } = require('./write');
const { appendAudit } = require('./audit');
const seriesStore = require('../../mobile-budget-series-store');

const { readSeries, newSeriesId, MAX_SERIES } = seriesStore;

// Budget series: one category's budgeted amount repeated over months.
// Actual never copies a budget forward, so a series writes the covered months
// itself, ONCE each (appliedThrough marks the last month written); only
// create/update overwrite, and the apps preview that first (dryRun).

const MAX_SPAN = 120; // most months a bounded series may cover
const HORIZON = 12; // an indefinite series keeps current month + 12 filled

const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOf = (index) => `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
const addMonths = (m, n) => monthOf(monthIndex(m) + n);
const currentMonthOf = (now) => monthOf(now.getFullYear() * 12 + now.getMonth());
const maxMonth = (a, b) => (monthIndex(a) >= monthIndex(b) ? a : b);

const endMonthOf = (s) => (s.mode === 'months' ? addMonths(s.startMonth, s.months - 1) : s.mode === 'until' ? s.untilMonth : null);

// The last month the series covers as of `current` (indefinite: current + 12).
// `last` is the latest month Actual will let us read or write (null if unknown);
// an indefinite series stops there and is extended by the scheduler as it moves.
const coverageEnd = (s, current, last = null) => {
  const end = endMonthOf(s);
  if (end) return end;
  const horizon = addMonths(current, HORIZON);
  return last && monthIndex(last) < monthIndex(horizon) ? last : horizon;
};

// Actual only has budget months up to a bound a little under a year ahead.
// Asking for one past it fails, so find the last real month first.
async function lastAvailableMonth(client) {
  if (typeof client.getBudgetMonths !== 'function') return null;
  try {
    const months = (await client.getBudgetMonths()) || [];
    const valid = months.filter((m) => MONTH_PATTERN.test(m)).sort();
    return valid.length ? valid[valid.length - 1] : null;
  } catch {
    return null;
  }
}

function monthRange(from, to) {
  const out = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i += 1) out.push(monthOf(i));
  return out;
}

const publicSeries = (s, name) => ({
  id: s.id,
  categoryId: s.categoryId,
  categoryName: clip(name || s.categoryName),
  amount: s.amount,
  startMonth: s.startMonth,
  mode: s.mode,
  months: s.mode === 'months' ? s.months : null,
  untilMonth: s.mode === 'until' ? s.untilMonth : null,
  endMonth: endMonthOf(s),
  appliedThrough: s.appliedThrough,
});

// Validate a request body (create has categoryId, update does not). Strict:
// only known keys, exact types, cross-field rules. Throws bad_request.
function parseSeriesBody(body, { withCategory }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  const required = withCategory ? ['categoryId', 'amount', 'startMonth', 'mode'] : ['amount', 'startMonth', 'mode'];
  const allowed = [...required, 'months', 'untilMonth', 'dryRun'];
  const keys = Object.keys(body);
  if (!keys.every((k) => allowed.includes(k)) || !required.every((k) => keys.includes(k))) throw badRequest();
  const { categoryId, amount, startMonth, mode, months, untilMonth, dryRun } = body;
  if (withCategory && !(typeof categoryId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(categoryId))) throw badRequest();
  if (!(typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_BUDGETED)) throw badRequest();
  if (typeof startMonth !== 'string' || !MONTH_PATTERN.test(startMonth)) throw badRequest();
  if (!['months', 'until', 'indefinite'].includes(mode)) throw badRequest();
  if ('dryRun' in body && typeof dryRun !== 'boolean') throw badRequest();
  if ('months' in body && !(typeof months === 'number' && Number.isInteger(months) && months >= 1 && months <= MAX_SPAN)) throw badRequest();
  if ('untilMonth' in body && !(typeof untilMonth === 'string' && MONTH_PATTERN.test(untilMonth))) throw badRequest();
  if (mode === 'months' && (!('months' in body) || 'untilMonth' in body)) throw badRequest();
  if (mode === 'until') {
    if (!('untilMonth' in body) || 'months' in body) throw badRequest();
    const span = monthIndex(untilMonth) - monthIndex(startMonth);
    if (span < 0 || span > MAX_SPAN) throw badRequest();
  }
  if (mode === 'indefinite' && ('months' in body || 'untilMonth' in body)) throw badRequest();
  return {
    categoryId,
    amount,
    startMonth,
    mode,
    months: mode === 'months' ? months : null,
    untilMonth: mode === 'until' ? untilMonth : null,
    dryRun: dryRun === true,
  };
}

function budgetLine(budgetMonth, categoryId) {
  for (const group of budgetMonth.categoryGroups || []) {
    for (const category of group.categories || []) if (category.id === categoryId) return category;
  }
  return null;
}

// Current budgeted amount of the category for each month, read (never written).
async function readBefore(client, categoryId, months) {
  const out = [];
  for (const month of months) {
    const line = budgetLine(await client.getBudgetMonth(month), categoryId);
    if (!line) throw badRequest();
    out.push({ month, before: money(line.budgeted) });
  }
  return out;
}

const total = (rows, key) => rows.reduce((sum, r) => sum + r[key], 0);
const summarise = (rows, key) => ({ months: rows.length, first: rows.length ? rows[0].month : null, last: rows.length ? rows[rows.length - 1].month : null, total: total(rows, key) });

// Write `amount` to every month in `months` in ONE batch, then sync at once.
// Returns [{month, before, after}]. Nothing is written for an empty list.
async function writeMonths(client, categoryId, months, amount) {
  if (months.length === 0) return [];
  const rows = await readBefore(client, categoryId, months);
  await client.batchBudgetUpdates(async () => {
    for (const { month } of rows) await client.setBudgetAmount(month, categoryId, amount);
  });
  await syncNow(client);
  return rows.map((r) => ({ month: r.month, before: r.before, after: amount }));
}

async function expenseCategoryOrBadRequest(client, categoryId) {
  const found = await findCategory(client, categoryId);
  if (!found || isHidden(found.group, found.category) || isIncome(found.group, found.category)) throw badRequest();
  return found;
}

// First month a (re)definition writes: never before the current month.
const writeFrom = (startMonth, current) => maxMonth(startMonth, current);

function plannedMonths(def, current, last = null) {
  const from = writeFrom(def.startMonth, current);
  const to = coverageEnd(def, current, last);
  return monthIndex(from) > monthIndex(to) ? [] : monthRange(from, to);
}

function checkWindow(def, current, { isCreate }) {
  const cur = monthIndex(current);
  const start = monthIndex(def.startMonth);
  if (isCreate && start < cur) throw badRequest();
  if (Math.abs(start - cur) > MONTH_WINDOW) throw badRequest();
}

async function persist(list) {
  await seriesStore.writeSeries(list);
}

// Preview or apply a create (id null) or an update (id given).
async function saveSeries({ tokenId, id, body, now = new Date() }) {
  return exclusive(async () => {
    const client = await scopedClient();
    const current = currentMonthOf(now);
    const list = await readSeries();
    const existing = id ? list.find((s) => s.id === id) : null;
    if (id && !existing) throw notFound();

    const def = parseSeriesBody(body, { withCategory: !id });
    const categoryId = id ? existing.categoryId : def.categoryId;
    checkWindow(def, current, { isCreate: !id });
    const { category } = await expenseCategoryOrBadRequest(client, categoryId);
    if (!id) {
      if (list.some((s) => s.categoryId === categoryId)) throw new HttpError(409, 'conflict');
      if (list.length >= MAX_SERIES && !def.dryRun) throw badRequest();
    }

    const last = await lastAvailableMonth(client);
    const end = endMonthOf(def);
    if (end && last && monthIndex(end) > monthIndex(last)) throw badRequest();
    const months = plannedMonths(def, current, last);

    if (def.dryRun) {
      const rows = await readBefore(client, categoryId, months);
      return { dryRun: true, body: { schema: 1, dryRun: true, categoryId, categoryName: clip(category.name), changes: rows.map((r) => ({ month: r.month, before: r.before, after: def.amount })) } };
    }

    const changes = await writeMonths(client, categoryId, months, def.amount);
    const stored = {
      id: id || newSeriesId(),
      categoryId,
      categoryName: clip(category.name),
      amount: def.amount,
      startMonth: def.startMonth,
      mode: def.mode,
      months: def.months,
      untilMonth: def.untilMonth,
      appliedThrough: months.length ? months[months.length - 1] : null,
    };
    await appendAudit({
      tokenId,
      op: id ? 'budget.series.update' : 'budget.series.create',
      ids: { series: stored.id, category: categoryId },
      amount: def.amount,
      before: id ? { amount: existing.amount, startMonth: existing.startMonth, mode: existing.mode, appliedThrough: existing.appliedThrough } : null,
      after: { mode: def.mode, startMonth: def.startMonth, endMonth: endMonthOf(stored), written: { months: changes.length, first: months[0] || null, last: months[months.length - 1] || null, totalBefore: total(changes, 'before'), totalAfter: total(changes, 'after') } },
    });
    // The budget is already changed: a failure here is a 500 for the caller,
    // and the next scheduler pass only writes months after the stored
    // appliedThrough, so it cannot make the budget worse.
    try {
      await persist(id ? list.map((s) => (s.id === id ? stored : s)) : [...list, stored]);
    } catch (err) {
      console.error('budget series: could not save the series file after writing the budget:', err && err.code ? err.code : 'unexpected error');
      throw err;
    }
    return { dryRun: false, body: { schema: 1, dryRun: false, series: publicSeries(stored, category.name), changes } };
  });
}

async function deleteSeries({ tokenId, id }) {
  return exclusive(async () => {
    const list = await readSeries();
    const existing = list.find((s) => s.id === id);
    if (!existing) throw notFound();
    await persist(list.filter((s) => s.id !== id));
    await appendAudit({ tokenId, op: 'budget.series.delete', ids: { series: id, category: existing.categoryId }, amount: existing.amount, before: { mode: existing.mode, startMonth: existing.startMonth, appliedThrough: existing.appliedThrough }, after: null });
    return { schema: 1, ok: true };
  });
}

async function buildSeriesList(client) {
  const names = new Map();
  for (const group of (await client.getCategoryGroups()) || []) for (const c of group.categories || []) names.set(c.id, c.name);
  const list = await readSeries();
  return { schema: 1, generatedAt: new Date().toISOString(), series: list.map((s) => publicSeries(s, names.get(s.categoryId))) };
}

// One scheduler pass for one series: write ONLY months after appliedThrough
// (and never before the current month) up to the end of coverage. Returns the
// number of months written. Runs inside the write lock.
async function applyOne({ id, getClient, now }) {
  return exclusive(async () => {
    const list = await readSeries();
    const s = list.find((x) => x.id === id);
    if (!s) return 0;
    const current = currentMonthOf(now);
    let from = writeFrom(s.startMonth, current);
    if (s.appliedThrough) from = maxMonth(from, addMonths(s.appliedThrough, 1));
    const client = await getClient();
    const to = coverageEnd(s, current, await lastAvailableMonth(client));
    if (monthIndex(from) > monthIndex(to)) return 0;
    const months = monthRange(from, to);

    const found = await findCategory(client, s.categoryId);
    if (!found || isHidden(found.group, found.category) || isIncome(found.group, found.category)) throw new Error('category unavailable');

    const changes = await writeMonths(client, s.categoryId, months, s.amount);
    await appendAudit({
      tokenId: 'scheduler',
      op: 'budget.series.apply',
      ids: { series: s.id, category: s.categoryId },
      amount: s.amount,
      before: { appliedThrough: s.appliedThrough },
      after: { appliedThrough: to, written: { months: changes.length, first: from, last: to, totalBefore: total(changes, 'before'), totalAfter: total(changes, 'after') } },
    });
    await persist(list.map((x) => (x.id === s.id ? { ...x, appliedThrough: to } : x)));
    return changes.length;
  });
}

// All series, one at a time; a failure in one never blocks the rest.
async function applyAllSeries({ getClient = scopedClient, now = new Date(), onWritten = () => {} } = {}) {
  let written = 0;
  const ids = (await readSeries()).map((s) => s.id);
  for (const id of ids) {
    try {
      const n = await applyOne({ id, getClient, now });
      written += n;
      if (n > 0) onWritten();
    } catch (err) {
      console.error('budget series: apply failed:', err && err.code ? err.code : err && err.message ? err.message : 'unexpected error');
    }
  }
  return written;
}

module.exports = { parseSeriesBody, saveSeries, deleteSeries, buildSeriesList, applyAllSeries, applyOne, monthIndex, addMonths, currentMonthOf, HORIZON };
