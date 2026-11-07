const { q } = require('@actual-app/api');

const { dateRange } = require('../../aql-date-range');
const { bucketKey } = require('./reports-time');

// Thrown for anything a card cannot represent; the card becomes `unsupported`.
class Unsupported extends Error {
  constructor(reason) {
    super(reason || 'unsupported');
    this.name = 'Unsupported';
    this.code = 'UNSUPPORTED';
  }
}

const ID_FIELDS = { category: 'category', payee: 'payee', account: 'account' };

// Converts one Actual rule condition ({field, op, value}) to an AQL filter
// clause. Only the simple, unambiguous ones are supported; the rest throw
// Unsupported so a card never shows a number computed from a filter that was
// quietly dropped.
function conditionToFilter(c) {
  if (!c || typeof c !== 'object') throw new Unsupported('bad condition');
  const { field, op, value } = c;
  if (field === 'account' && (op === 'onBudget' || op === 'offBudget')) {
    return { 'account.offbudget': op === 'offBudget' };
  }
  if (field === 'transfer' && op === 'is') {
    return value ? { transfer_id: { $ne: null } } : { transfer_id: null };
  }
  if (field === 'amount') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Unsupported('amount');
    const cents = Math.round(n);
    const ops = { is: '$eq', gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };
    if (ops[op]) return { amount: { [ops[op]]: cents } };
    throw new Unsupported('amount op');
  }
  if (ID_FIELDS[field]) {
    const col = ID_FIELDS[field];
    if (op === 'is' && typeof value === 'string') return { [col]: value };
    if (op === 'isNot' && typeof value === 'string') return { [col]: { $ne: value } };
    if (op === 'oneOf' && Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      return { [col]: { $oneof: value } };
    }
    throw new Unsupported(`${field} op`);
  }
  if (field === 'notes' && op === 'contains' && typeof value === 'string' && value.length > 0) {
    return { notes: { $like: `%${value.replace(/[%_]/g, '')}%` } };
  }
  throw new Unsupported('condition');
}

// Widget `conditions` + `conditionsOp` as one AQL clause, or null for none.
function conditionsFilter(conditions, op) {
  if (conditions == null) return null;
  if (!Array.isArray(conditions)) throw new Unsupported('conditions');
  if (conditions.length === 0) return null;
  const clauses = conditions.map(conditionToFilter);
  return op === 'or' ? { $or: clauses } : { $and: clauses };
}

// Base transaction filter: live rows, an inclusive date range (either bound
// optional), plus any extra clauses.
function txFilter({ start, end, extra = [], transfers = true } = {}) {
  const clauses = [{ tombstone: false }];
  if (start) clauses.push({ date: { $gte: start } });
  if (end) clauses.push({ date: { $lte: end } });
  if (!transfers) clauses.push({ transfer_id: null });
  for (const e of extra) if (e) clauses.push(e);
  return { $and: clauses };
}

// date -> { amount, count } for the filter. Every other bucketing (months,
// weeks, years) is done in JS from these daily sums.
async function dailySums(client, filter) {
  const { data } = await client.aqlQuery(
    q('transactions')
      .filter(filter)
      .groupBy('date')
      .select([{ date: 'date' }, { amount: { $sum: '$amount' } }, { count: { $count: '$id' } }])
  );
  const out = new Map();
  for (const row of data || []) {
    if (typeof row.date !== 'string') continue;
    out.set(row.date, { amount: Number(row.amount) || 0, count: Number(row.count) || 0 });
  }
  return out;
}

function bucketSums(daily, interval) {
  const out = new Map();
  for (const [date, v] of daily) {
    const key = bucketKey(date, interval);
    out.set(key, (out.get(key) || 0) + v.amount);
  }
  return out;
}

// Rows of { id, amount } grouped by one transaction column.
async function sumsBy(client, column, filter) {
  const { data } = await client.aqlQuery(
    q('transactions')
      .filter(filter)
      .groupBy(column)
      .select([{ id: column }, { amount: { $sum: '$amount' } }])
  );
  return (data || []).map((r) => ({ id: r.id ?? null, amount: Number(r.amount) || 0 }));
}

// Rows of { date, id, amount } grouped by day and one transaction column
// (the grouped custom reports plot one series per group over time).
async function sumsByDateAnd(client, column, filter) {
  const { data } = await client.aqlQuery(
    q('transactions')
      .filter(filter)
      .groupBy(['date', column])
      .select([{ date: 'date' }, { id: column }, { amount: { $sum: '$amount' } }])
  );
  return (data || [])
    .filter((r) => typeof r.date === 'string')
    .map((r) => ({ date: r.date, id: r.id ?? null, amount: Number(r.amount) || 0 }));
}

module.exports = { Unsupported, sumsByDateAnd, conditionToFilter, conditionsFilter, txFilter, dailySums, bucketSums, sumsBy, dateRange };
