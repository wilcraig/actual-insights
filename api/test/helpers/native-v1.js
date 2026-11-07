const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

// Validates a response body against one definition of the shared contract.
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'native-v1.schema.json'), 'utf8'));
const examples = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'native-v1.examples.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
ajv.addSchema(schema);

function expectValid(definition, body) {
  const validate = ajv.getSchema(`${schema.$id}#/definitions/${definition}`);
  if (!validate) throw new Error(`no definition ${definition}`);
  if (!validate(body)) throw new Error(`${definition} does not match the schema: ${JSON.stringify(validate.errors)}\n${JSON.stringify(body).slice(0, 500)}`);
}

function isValid(definition, body) {
  return ajv.getSchema(`${schema.$id}#/definitions/${definition}`)(body);
}

// An in-memory Actual client: just enough of the API surface (and a small AQL
// evaluator over query.serialize()) for the v1 routes.
function makeFakeActual(overrides = {}) {
  const state = {
    accounts: [
      { id: 'a-chk', name: 'Everyday Checking', offbudget: false, closed: false, balance: 312450 },
      { id: 'a-sav', name: 'Rainy Day Savings', offbudget: false, closed: false, balance: 1050000 },
      { id: 'a-ret', name: 'Retirement', offbudget: true, closed: false, balance: 9900000 },
      { id: 'a-old', name: 'Old account', offbudget: false, closed: true, balance: 0 },
    ],
    payees: { 'p-grocer': { name: 'Example Grocer' }, 'p-hw': { name: 'Example Hardware' }, 'p-xfer': { name: 'Everyday Checking', transfer_acct: 'a-chk' }, 'p-xfer2': { name: 'Rainy Day Savings', transfer_acct: 'a-sav' } },
    schedules: { 's-1': { name: 'Hardware club' } },
    groups: [
      { id: 'g-usual', name: 'Usual Expenses', is_income: false, hidden: false, categories: [
        { id: 'c-groc', name: 'Groceries', is_income: false, hidden: false },
        { id: 'c-fuel', name: 'Fuel', is_income: false, hidden: false },
        { id: 'c-hid', name: 'Old hobby', is_income: false, hidden: true },
      ] },
      { id: 'g-gone', name: 'Retired group', is_income: false, hidden: true, categories: [{ id: 'c-gone', name: 'Gone', is_income: false, hidden: false }] },
      { id: 'g-empty', name: 'Nothing here', is_income: false, hidden: false, categories: [] },
      { id: 'g-income', name: 'Income', is_income: true, hidden: false, categories: [{ id: 'c-pay', name: 'Paycheck', is_income: true, hidden: false }] },
    ],
    // month -> category id -> budgeted
    budget: {},
    spent: { 'c-groc': -9500, 'c-fuel': -2800, 'c-pay': 0 },
    carryover: { 'c-fuel': true },
    income: 215000,
    toBudget: 163840,
    transactions: [
      { id: 't-01', date: '2026-11-11', account: 'a-chk', payee: 'p-grocer', category: 'c-groc', amount: -8423, notes: null, cleared: true },
      { id: 't-02', date: '2026-11-10', account: 'a-chk', payee: 'p-hw', category: null, amount: -2399, notes: 'screws #house #diy #house', cleared: false, imported_payee: 'EXAMPLE HDWR #1234', imported_id: 'SFIN-0001', schedule: 's-1' },
      { id: 't-03', date: '2026-11-10', account: 'a-chk', payee: 'p-hw', category: null, amount: -100, notes: '', cleared: false },
      { id: 't-04', date: '2026-11-10', account: 'a-sav', payee: 'p-xfer', category: null, amount: 50000, notes: null, cleared: true, transfer_id: 't-04x' },
      { id: 't-05', date: '2026-11-09', account: 'a-chk', payee: 'p-grocer', category: null, amount: -5000, notes: null, cleared: true, is_parent: true },
      { id: 't-05c', date: '2026-11-09', account: 'a-chk', payee: 'p-grocer', category: 'c-groc', amount: -2500, notes: 'half', cleared: true, is_child: true, parent_id: 't-05', sort_order: 2 },
      { id: 't-05d', date: '2026-11-09', account: 'a-chk', payee: 'p-grocer', category: null, amount: -2500, notes: null, cleared: true, is_child: true, parent_id: 't-05', sort_order: 1 },
      { id: 't-04x', date: '2026-11-10', account: 'a-chk', payee: 'p-xfer2', category: null, amount: -50000, notes: null, cleared: true, transfer_id: 't-04' },
      { id: 't-11', date: '2026-11-05', account: 'a-chk', payee: 'p-grocer', category: 'c-fuel', amount: -1500, notes: null, cleared: true, reconciled: true },
      { id: 't-06', date: '2026-11-09', account: 'a-chk', payee: 'p-grocer', category: null, amount: -700, notes: null, cleared: true, tombstone: true },
      { id: 't-07', date: '2026-11-08', account: 'a-ret', payee: 'p-grocer', category: null, amount: -900, notes: null, cleared: true },
      { id: 't-08', date: '2026-11-08', account: 'a-old', payee: 'p-grocer', category: null, amount: -800, notes: null, cleared: true },
      { id: 't-09', date: '2026-11-07', account: 'a-sav', payee: null, category: null, amount: -300, notes: null, cleared: true },
      { id: 't-10', date: '2026-11-06', account: 'a-chk', payee: 'p-grocer', category: 'c-fuel', amount: -1200, notes: null, cleared: true },
    ],
    currency: 'USD',
    calls: [],
    syncs: 0,
    ...overrides,
  };
  const acct = (id) => state.accounts.find((a) => a.id === id) || {};
  const groupOfCat = (id) => state.groups.find((g) => g.categories.some((c) => c.id === id));
  const catOf = (id) => state.groups.flatMap((g) => g.categories).find((c) => c.id === id);

  const value = (row, p) => {
    switch (p) {
      case 'account.name': return acct(row.account).name;
      case 'account.closed': return Boolean(acct(row.account).closed);
      case 'account.offbudget': return Boolean(acct(row.account).offbudget);
      case 'payee.name': return row.payee ? state.payees[row.payee].name : null;
      case 'payee.transfer_acct': return row.payee ? state.payees[row.payee].transfer_acct ?? null : null;
      case 'category.name': return row.category ? catOf(row.category).name : null;
      case 'is_parent': return Boolean(row.is_parent);
      case 'transfer_id': return row.transfer_id ?? null;
      case 'tombstone': return Boolean(row.tombstone);
      case 'category': return row.category ?? null;
      case 'category.group.name': return row.category ? groupOfCat(row.category).name : null;
      case 'category.group': return row.category ? groupOfCat(row.category).id : null;
      case 'schedule.name': return row.schedule ? state.schedules[row.schedule].name : null;
      default: return row[p] ?? null;
    }
  };
  const matches = (row, expr) => Object.entries(expr).every(([k, v]) => {
    if (k === '$and') return v.every((e) => matches(row, e));
    if (k === '$or') return v.some((e) => matches(row, e));
    const actual = value(row, k);
    if (v !== null && typeof v === 'object') {
      if ('$lt' in v) return actual < v.$lt;
      throw new Error('fake AQL: unsupported operator');
    }
    return actual === v;
  });

  const monthLines = (month) => {
    state.budget[month] = state.budget[month] || { 'c-groc': 45000, 'c-fuel': 18000, 'c-pay': 0 };
    return state.budget[month];
  };

  const client = {
    state,
    sync: jest.fn(async () => { state.syncs += 1; }),
    getAccounts: jest.fn(async () => state.accounts.map(({ balance, ...a }) => a)),
    getAccountBalance: jest.fn(async (id) => acct(id).balance),
    getCategoryGroups: jest.fn(async () => state.groups),
    getBudgetMonth: jest.fn(async (month) => {
      const lines = monthLines(month);
      const groups = state.groups.map((g) => ({
        ...g,
        categories: g.categories.map((c) => ({ ...c, budgeted: lines[c.id] ?? 0, spent: state.spent[c.id] ?? 0, balance: (lines[c.id] ?? 0) + (state.spent[c.id] ?? 0), carryover: Boolean(state.carryover[c.id]) })),
      }));
      const all = groups.filter((g) => !g.is_income).flatMap((g) => g.categories);
      return {
        month,
        toBudget: state.toBudget,
        totalBudgeted: -all.reduce((s, c) => s + c.budgeted, 0),
        totalSpent: all.reduce((s, c) => s + c.spent, 0),
        totalBalance: all.reduce((s, c) => s + c.balance, 0),
        totalIncome: state.income,
        categoryGroups: groups,
      };
    }),
    setBudgetAmount: jest.fn(async (month, id, amount) => { state.calls.push(['setBudgetAmount', month, id, amount]); monthLines(month)[id] = amount; }),
    batchBudgetUpdates: jest.fn(async (fn) => { state.calls.push(['batch']); await fn(); }),
    // Mirrors what @actual-app/api 26.10 does (checked against a real budget):
    // `subtransactions` replaces every child of the parent (new ids, the
    // parent's account/date/payee/cleared, the parent's category reads null
    // while split but is kept underneath) and `is_parent: false` with no lines
    // un-splits it, bringing that old category back.
    updateTransaction: jest.fn(async (id, fields) => {
      state.calls.push(['updateTransaction', id, fields]);
      const row = state.transactions.find((t) => t.id === id);
      const { subtransactions, ...rest } = fields;
      if (subtransactions) {
        state.transactions = state.transactions.filter((t) => t.parent_id !== id);
        if (rest.is_parent === false) {
          row.is_parent = false;
          if (!row.is_parent && '_kept' in row) { row.category = row._kept; delete row._kept; }
        } else {
          if (!row.is_parent) { row._kept = row.category; row.category = null; }
          row.is_parent = true;
          for (const line of subtransactions) {
            state.nextChild = (state.nextChild || 0) + 1;
            state.transactions.push({ id: `${id}-n${state.nextChild}`, date: row.date, account: row.account, payee: row.payee, cleared: row.cleared, is_child: true, parent_id: id, ...line });
          }
        }
        delete rest.is_parent;
      }
      Object.assign(row, rest);
    }),
    aqlQuery: jest.fn(async (query) => {
      const s = query.serialize();
      if (s.table === 'preferences') return { data: [{ id: 'defaultCurrencyCode', value: state.currency }] };
      if (s.table !== 'transactions') throw new Error('fake AQL: unsupported table');
      const all = s.tableOptions && s.tableOptions.splits === 'all';
      let rows = state.transactions.filter((r) => !r.tombstone && (all || !r.is_child));
      for (const f of s.filterExpressions) rows = rows.filter((r) => matches(r, f));
      if (s.calculation) return { data: rows.length };
      for (const o of [...s.orderExpressions].reverse()) {
        const [[field, dir]] = Object.entries(o);
        rows = [...rows].sort((a, b) => (value(a, field) < value(b, field) ? -1 : value(a, field) > value(b, field) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      if (s.limit != null) rows = rows.slice(0, s.limit);
      return { data: rows.map((r) => Object.fromEntries(s.selectExpressions.map((f) => [f, value(r, f)]))) };
    }),
  };
  return client;
}

module.exports = { expectValid, isValid, examples, schema, makeFakeActual };
