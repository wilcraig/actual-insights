const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-excl-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

const flagStore = require('../src/mobile-transaction-flags-store');
const { buildReports } = require('../src/mobile/v1/reports');
const { buildSpending } = require('../src/mobile/v1/spending');
const { buildMobileSummary } = require('../src/mobile/summary');
const { adjustBudgetMonth, loadExclusions, notInClause } = require('../src/mobile/v1/exclusions');
const { expectValid } = require('./helpers/native-v1');

const NOW = new Date(2026, 10, 12, 10, 0, 0);

const GROUPS = [
  { id: 'g-bills', name: 'Bills', categories: [{ id: 'c-rent', name: 'Rent' }] },
  { id: 'g-fun', name: 'Fun', categories: [{ id: 'c-eat', name: 'Eating out' }] },
  { id: 'g-income', name: 'Income', is_income: true, categories: [{ id: 'c-pay', name: 'Paycheck' }] },
];
const ACCOUNTS = [{ id: 'a-chk', name: 'Checking', offbudget: false, closed: false }];
const PAYEES = [{ id: 'p-diner', name: 'Example Diner' }];
const tx = (id, date, amount, category, extra = {}) => ({ id, date, amount, category, payee: category === 'c-eat' ? 'p-diner' : null, account: 'a-chk', notes: null, imported_payee: null, transfer_id: null, starting_balance_flag: false, tombstone: false, is_parent: false, parent_id: null, ...extra });
const TXS = [
  tx('pay', '2026-11-02', 400000, 'c-pay'),
  tx('rent', '2026-11-03', -100000, 'c-rent'),
  tx('n1', '2026-11-08', -700, 'c-eat'),
  tx('e1', '2026-11-05', -1000, 'c-eat'), // flagged excluded
  tx('e2', '2026-11-06', -2000, 'c-eat'),
  tx('e3', '2026-11-07', -3000, 'c-rent'), // flagged hidden
  tx('e4', '2026-10-05', -500, 'c-eat'), // flagged, other month
  tx('e5', '2026-11-09', -4000, null, { is_parent: true }), // split parent, flagged
  tx('e5a', '2026-11-09', -1500, 'c-eat', { parent_id: 'e5' }),
  tx('e5b', '2026-11-09', -2500, 'c-rent', { parent_id: 'e5' }),
];
const groupOf = (row) => GROUPS.find((g) => g.categories.some((c) => c.id === row.category));
const field = (row, key) => {
  if (key === 'category.group.is_income') return Boolean(groupOf(row) && groupOf(row).is_income);
  if (key === 'category.group') return groupOf(row) && groupOf(row).id;
  if (key === 'account.offbudget') return false;
  if (key === 'account.closed') return false;
  return row[key] ?? null;
};
function matches(row, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return cond.every((c) => matches(row, c));
    if (key === '$or') return cond.some((c) => matches(row, c));
    const v = field(row, key);
    if (cond === null || typeof cond !== 'object') return v === cond;
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case '$gte': return v >= arg;
        case '$lte': return v <= arg;
        case '$gt': return v > arg;
        case '$lt': return v < arg;
        case '$eq': return v === arg;
        case '$ne': return v !== arg;
        case '$oneof': return arg.includes(v);
        default: throw new Error(`stub AQL: ${op}`);
      }
    });
  });
}

function runQuery(query, state) {
  const s = query.serialize();
  if (s.table === 'dashboard_pages') return [];
  if (s.table === 'dashboard') return state.dashboard;
  if (s.table === 'payees') return PAYEES;
  if (s.table === 'category_groups') return GROUPS;
  if (s.table === 'categories') return GROUPS.flatMap((g) => g.categories);
  if (s.table === 'custom_reports') return state.customReports || [];
  if (s.table === 'preferences') return [];
  if (s.table !== 'transactions') throw new Error(`stub AQL: ${s.table}`);
  const all = s.tableOptions && s.tableOptions.splits === 'all';
  // default splits mode ('inline'): children instead of their parents
  const rows = TXS.filter((r) => !r.tombstone && (all || !r.is_parent)).filter((r) => s.filterExpressions.every((f) => matches(r, f)));
  state.queries.push(s);
  if (s.groupExpressions.length === 0) {
    return rows.map((r) => Object.fromEntries(s.selectExpressions.map((f) => (typeof f === 'string' ? [f, field(r, f)] : [Object.keys(f)[0], r.amount]))));
  }
  const cols = s.groupExpressions;
  const groups = new Map();
  for (const r of rows) {
    const keys = cols.map((c) => field(r, c));
    const k = JSON.stringify(keys);
    const g = groups.get(k) || { keys, amount: 0, count: 0 };
    g.amount += r.amount;
    g.count += 1;
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => {
    const out = {};
    for (const sel of s.selectExpressions) {
      const name = Object.keys(sel)[0];
      const value = Object.values(sel)[0];
      if (value && value.$sum) out[name] = g.amount;
      else if (value && value.$count) out[name] = g.count;
      else out[name] = g.keys[cols.indexOf(value)];
    }
    return out;
  });
}

const BUDGET = () => ({
  totalIncome: 400000,
  totalSpent: -(100000 + 700 + 1000 + 2000 + 3000 + 4000 + 0),
  totalBalance: 0,
  categoryGroups: [
    { id: 'g-bills', name: 'Bills', categories: [{ id: 'c-rent', name: 'Rent', budgeted: 120000, spent: -(100000 + 3000 + 2500), balance: 14500 }] },
    { id: 'g-fun', name: 'Fun', categories: [{ id: 'c-eat', name: 'Eating out', budgeted: 20000, spent: -(700 + 1000 + 2000 + 1500), balance: 14800 }] },
    { id: 'g-income', name: 'Income', is_income: true, categories: [{ id: 'c-pay', name: 'Paycheck', budgeted: 0, spent: 400000, balance: 0 }] },
  ],
});

let state;
function makeClient() {
  state = { dashboard: [], queries: [] };
  return {
    aqlQuery: jest.fn(async (query) => ({ data: runQuery(query, state) })),
    getAccounts: jest.fn(async () => ACCOUNTS),
    getPayees: jest.fn(async () => PAYEES),
    getCategoryGroups: jest.fn(async () => GROUPS),
    getBudgetMonth: jest.fn(async () => BUDGET()),
    getSchedules: jest.fn(async () => []),
    getRules: jest.fn(async () => []),
  };
}
const widget = (id, type, meta, y = 0) => ({ id, dashboard_page_id: null, type, width: 4, height: 2, x: 0, y, meta, tombstone: false });
const insights = (name, config = '[]') => ({ content: `{{INSIGHTS:${name}:${config}}}` });
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function card(client, type, meta) {
  state.dashboard = [widget(U(1), type, meta)];
  const body = await buildReports({ client, now: NOW });
  return body.cards[0];
}

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Denver';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

beforeEach(async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  fs.rmSync(path.join(DATA_DIR, flagStore.FILE_NAME), { force: true });
});
afterEach(() => jest.restoreAllMocks());

const flag = async () => {
  await flagStore.setFlags('e1', { excluded: true, hidden: false }, DATA_DIR);
  await flagStore.setFlags('e3', { excluded: true, hidden: true }, DATA_DIR);
  await flagStore.setFlags('e4', { excluded: true, hidden: false }, DATA_DIR);
  await flagStore.setFlags('e5', { excluded: true, hidden: false }, DATA_DIR);
};

describe('loadExclusions', () => {
  test('nothing flagged: no Actual call at all', async () => {
    const client = makeClient();
    const ex = await loadExclusions(client);
    expect(ex.empty).toBe(true);
    expect(client.aqlQuery).not.toHaveBeenCalled();
    expect(adjustBudgetMonth(BUDGET(), ex, '2026-11')).toEqual(BUDGET());
  });

  test('gathers flagged rows and the lines of flagged split parents; sums add back per category and month', async () => {
    await flag();
    const ex = await loadExclusions(makeClient());
    expect([...ex.ids].sort()).toEqual(['e1', 'e3', 'e4', 'e5', 'e5a', 'e5b']);
    expect(Object.fromEntries(ex.addBack('2026-11'))).toEqual({ 'c-eat': -1000 - 1500, 'c-rent': -3000 - 2500 });
    expect(Object.fromEntries(ex.addBack('2026-10'))).toEqual({ 'c-eat': -500 });
    expect(ex.idsBetween('2026-11-01', '2026-11-30').sort()).toEqual(['e1', 'e3', 'e5', 'e5a', 'e5b']);
  });

  test('the not-in clause nests so thousands of ids stay inside AQL depth', () => {
    const clause = notInClause(Array.from({ length: 3000 }, (_, i) => `id${i}`));
    const depth = (node) => (node && node.$and ? 1 + Math.max(...node.$and.map(depth)) : 0);
    expect(depth(clause)).toBeLessThan(5);
    expect(notInClause([])).toBeNull();
  });
});

describe('/spending drills', () => {
  const cats = (body) => Object.fromEntries(body.items.map((i) => [i.id, i.amount]));
  test('every level leaves excluded and hidden transactions out (split lines by their parent flag)', async () => {
    const plainClient = makeClient();
    const plain = await buildSpending(plainClient, '2026-11', { level: 'categories', categoryIds: ['c-eat', 'c-rent'] }, NOW);
    expect(cats(plain)).toEqual({ 'c-rent': 100000 + 3000 + 2500, 'c-eat': 700 + 1000 + 2000 + 1500 });
    await flag();
    const client = makeClient();
    const body = await buildSpending(client, '2026-11', { level: 'categories', categoryIds: ['c-eat', 'c-rent'] }, NOW);
    expectValid('spendingResponse', body);
    expect(cats(body)).toEqual({ 'c-rent': 100000, 'c-eat': 700 + 2000 });
    expect(body.total).toBe(100000 + 2700);

    const payees = await buildSpending(client, '2026-11', { level: 'payees', categoryId: 'c-eat' }, NOW);
    expect(payees.total).toBe(2700);
    const list = await buildSpending(client, '2026-11', { level: 'transactions', categoryId: 'c-eat', payeeId: 'p-diner' }, NOW);
    expectValid('spendingResponse', list);
    expect(list.transactions.map((t) => t.id).sort()).toEqual(['e2', 'n1']);
  });

  test('a flag in another month does not touch this month', async () => {
    await flagStore.setFlags('e4', { excluded: true, hidden: false }, DATA_DIR);
    const body = await buildSpending(makeClient(), '2026-11', { level: 'categories', categoryIds: ['c-eat'] }, NOW);
    expect(cats(body)).toEqual({ 'c-eat': 700 + 1000 + 2000 + 1500 });
  });
});

describe('mobile reports', () => {
  test('pacing bars use the adjusted spent (and the available amount stays the budget plus carryover)', async () => {
    const client = makeClient();
    const before = await card(client, 'markdown-card', insights('pacing-bars', '["c-eat","c-rent"]'));
    expect(before.items.map((i) => [i.label, i.current])).toEqual([['Eating out', 5200], ['Rent', 105500]]);
    await flag();
    const after = await card(makeClient(), 'markdown-card', insights('pacing-bars', '["c-eat","c-rent"]'));
    expect(after.items.map((i) => [i.label, i.current])).toEqual([['Eating out', 2700], ['Rent', 100000]]);
    // target = balance + spent: balance moved with spent, so the target is the same
    expect(after.items.map((i) => i.target)).toEqual(before.items.map((i) => i.target));
    // a group rollup too
    const roll = await card(makeClient(), 'markdown-card', insights('pacing-bars', '{"categoryIds":[],"allGroups":true}'));
    expect(roll.items.map((i) => [i.label, i.current])).toEqual([['Bills', 100000], ['Fun', 2700]]);
  });

  test('spending card (month, budget and average modes), donut/treemap and Sankey leave excluded ones out', async () => {
    const values = (c) => Object.fromEntries(c.items.map((i) => [i.label, i.value]));
    const plain = await card(makeClient(), 'spending-card', {});
    expect(values(plain)).toEqual({ Rent: 105500, 'Eating out': 5200 });
    await flag();
    const month = await card(makeClient(), 'spending-card', {});
    expect(values(month)).toEqual({ Rent: 100000, 'Eating out': 2700 });
    const budget = await card(makeClient(), 'spending-card', { mode: 'budget' });
    expect(values(budget)).toEqual({ Rent: 100000, 'Eating out': 2700 });
    const donut = await card(makeClient(), 'markdown-card', insights('spending-breakdown-donut'));
    expect(values(donut)).toEqual({ Bills: 100000, Fun: 2700 });
    const tree = await card(makeClient(), 'markdown-card', insights('spending-treemap'));
    expect(values(tree)).toEqual({ Bills: 100000, Fun: 2700 });
    const sankey = await card(makeClient(), 'markdown-card', insights('spending-sankey'));
    const linkValues = sankey.links.map((l) => l.value);
    expect(linkValues).toContain(100000);
    expect(linkValues).toContain(2700);
    expect(linkValues).not.toContain(105500);
    expect(linkValues).not.toContain(5200);
  });

  test('custom reports by category leave them out, by account do not; cash flow is real money and unchanged', async () => {
    const report = (id, group_by) => ({ id, name: id, group_by, balance_type: 'Payment', conditions: '[]', conditions_op: 'and', start_date: '2026-11-01', end_date: '2026-11-30', date_static: 1, interval: 'Monthly', graph_type: 'BarGraph', show_offbudget: false, tombstone: false });
    const run = async (client, group) => {
      state.customReports = [report('r1', group)];
      state.dashboard = [];
      const body = await buildReports({ client, now: NOW, reportId: 'r1' });
      return body.cards[0];
    };
    const plainCat = await run(makeClient(), 'Category');
    const total = (c) => c.items.reduce((s, i) => s + i.value, 0);
    // (the report's window also reaches October, so e4 is in it)
    const plainTotal = total(plainCat);
    expect(plainTotal).toBe(100000 + 3000 + 2500 + 700 + 1000 + 2000 + 1500 + 500);
    await flag();
    const client = makeClient();
    const cat = await run(client, 'Category');
    expect(total(cat)).toBe(100000 + 700 + 2000);
    const acct = await run(makeClient(), 'Account');
    expect(total(acct)).toBe(plainTotal);

    const flow = await card(makeClient(), 'cash-flow-card', { timeFrame: { start: '2026-11-01', end: '2026-11-30', mode: 'static' } });
    const expenses = flow.series.find((s) => s.name === 'Expenses').values;
    expect(expenses[expenses.length - 1]).toBe(100000 + 3000 + 2500 + 700 + 1000 + 2000 + 1500);
  });

  test('burn rate: the daily spend leaves excluded ones out', async () => {
    const last = (c) => c.series.find((s) => s.name === 'Spent so far').values.filter((v) => v !== null).pop();
    const plain = await card(makeClient(), 'markdown-card', insights('burn-rate'));
    await flag();
    const after = await card(makeClient(), 'markdown-card', insights('burn-rate'));
    expect(last(plain) - last(after)).toBe(3000 + 1000 + 1500 + 2500);
  });
});

describe('mobile summary', () => {
  test('the month section adds excluded amounts back; goals keep the raw balances', async () => {
    const run = async () => buildMobileSummary({ client: { ...makeClient(), getAccountBalance: jest.fn(async () => 0), getSchedules: jest.fn(async () => []) }, now: NOW, dataDir: DATA_DIR });
    const plain = await run();
    await flag();
    const after = await run();
    expect(plain.month).not.toBeNull();
    expect(after.month.spent).toBe(plain.month.spent - (1000 + 1500 + 3000 + 2500));
    expect(after.month.remaining).toBe(plain.month.remaining + (1000 + 1500 + 3000 + 2500));
  });
});
