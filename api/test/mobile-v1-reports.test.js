const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');

const { createColorResolver } = require('../src/mobile/v1/colors');
const { buildReports, buildReportList, stripMarkdown } = require('../src/mobile/v1/reports');
const { resolveTimeFrame, resolveReportRange } = require('../src/mobile/v1/reports-time');
const { parsePlaceholder } = require('../src/mobile/v1/reports-insights');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'native-v1.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false, formats: { 'date-time': true } });
ajv.addSchema(schema, 'native');
const validateResponse = ajv.compile({ $ref: 'native#/definitions/reportsResponse' });
const validateList = ajv.compile({ $ref: 'native#/definitions/reportListResponse' });

function expectValid(body) {
  if (!validateResponse(body)) throw new Error(`does not match the schema: ${JSON.stringify(validateResponse.errors)}`);
}

// 2026-11-12, Thursday, local.
const NOW = new Date(2026, 10, 12, 10, 0, 0);
const ORIGINAL_TZ = process.env.TZ;
let dataDir;
let ORIGINAL_DATA_DIR;

beforeAll(() => {
  process.env.TZ = 'America/Denver';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation((...a) => { if (process.env.DBG) process.stdout.write(a.join(' ') + '\n'); });
});
afterEach(() => {
  jest.restoreAllMocks();
});

// ---- a tiny in-memory AQL ----

const ACCOUNTS = [
  { id: 'a-chk', name: 'Checking', offbudget: false, closed: false },
  { id: 'a-sav', name: 'Savings', offbudget: false, closed: false },
  { id: 'a-inv', name: 'Brokerage', offbudget: true, closed: false },
  { id: 'a-old', name: 'Old card', offbudget: false, closed: true },
];
const GROUPS = [
  { id: 'g-bills', name: 'Bills', categories: [{ id: 'c-rent', name: 'Rent' }, { id: 'c-power', name: 'Power' }] },
  { id: 'g-fun', name: 'Fun', categories: [{ id: 'c-eat', name: 'Eating out' }] },
  { id: 'g-income', name: 'Income', is_income: true, categories: [{ id: 'c-pay', name: 'Paycheck' }] },
];
const PAYEES = [{ id: 'p-boss', name: 'Example Employer' }, { id: 'p-diner', name: 'Example Diner' }];

const tx = (date, amount, extra = {}) => ({ date, amount, account: 'a-chk', category: null, payee: null, transfer_id: null, starting_balance_flag: false, tombstone: false, ...extra });
const TXS = [
  tx('2026-01-02', 500000, { category: 'c-pay', payee: 'p-boss' }),
  tx('2026-09-02', 400000, { category: 'c-pay', payee: 'p-boss' }),
  tx('2026-09-03', -100000, { category: 'c-rent' }),
  tx('2026-10-02', 400000, { category: 'c-pay', payee: 'p-boss' }),
  tx('2026-10-03', -100000, { category: 'c-rent' }),
  tx('2026-10-10', -3000, { category: 'c-eat', payee: 'p-diner' }),
  tx('2026-11-02', 400000, { category: 'c-pay', payee: 'p-boss' }),
  tx('2026-11-03', -100000, { category: 'c-rent' }),
  tx('2026-11-05', -4000, { category: 'c-eat', payee: 'p-diner' }),
  tx('2026-11-06', -2500, { category: 'c-power' }),
  tx('2026-11-07', -9999, { category: 'c-eat', tombstone: true }),
  tx('2026-11-08', -50000, { account: 'a-sav', transfer_id: 'x' }),
  tx('2026-11-08', 50000, { account: 'a-inv', transfer_id: 'y' }),
  tx('2025-11-09', 777, { account: 'a-old' }),
];

const groupOf = (row) => GROUPS.find((g) => g.categories.some((c) => c.id === row.category));
const field = (row, key) => {
  if (key === 'category.group.is_income') return Boolean(groupOf(row) && groupOf(row).is_income);
  if (key === 'category.group') return groupOf(row) && groupOf(row).id;
  if (key === 'account.offbudget') return ACCOUNTS.find((a) => a.id === row.account).offbudget;
  if (key === 'account.closed') return ACCOUNTS.find((a) => a.id === row.account).closed;
  return row[key];
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

function runQuery(query) {
  const s = query.serialize();
  if (s.table === 'dashboard') return stub.dashboard;
  if (s.table === 'dashboard_pages') return stub.pages;
  if (s.table === 'payees') return PAYEES;
  if (s.table === 'category_groups') return GROUPS;
  if (s.table === 'custom_reports') return stub.customReports;
  if (s.table !== 'transactions') throw new Error(`stub AQL: ${s.table}`);
  const rows = TXS.filter((r) => s.filterExpressions.every((f) => matches(r, f)));
  if (s.limit === 1) {
    return [...rows].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 1).map((r) => ({ date: r.date }));
  }
  const cols = s.groupExpressions;
  const groups = new Map();
  for (const r of rows) {
    const keys = cols.map((c) => (c === 'category.group' ? field(r, c) : r[c]));
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
      if (name.startsWith('amount')) out[name] = g.amount;
      else if (name === 'count') out.count = g.count;
      else out[name] = g.keys[cols.indexOf(Object.values(sel)[0])];
    }
    return out;
  });
}

let stub;
function makeClient(w = {}) {
  stub = { dashboard: [], pages: [{ id: 'page-1', name: 'Main', tombstone: false }], customReports: [], ...w };
  return {
    aqlQuery: jest.fn(async (query) => ({ data: runQuery(query) })),
    getAccounts: jest.fn(async () => ACCOUNTS),
    getPayees: jest.fn(async () => PAYEES),
    getCategoryGroups: jest.fn(async () => GROUPS),
    getAccountBalance: jest.fn(async (id) => (id === 'a-chk' ? 123456 : 5000)),
    getTransactions: jest.fn(async (id, start, end) => TXS.filter((t) => t.account === id && !t.tombstone && t.date >= start && t.date <= end)),
    getBudgetMonth: jest.fn(async () => ({
      totalIncome: 400000,
      totalSpent: -106500,
      categoryGroups: [
        { id: 'g-bills', name: 'Bills', categories: [{ id: 'c-rent', name: 'Rent', budgeted: 100000, spent: -100000, balance: 0 }, { id: 'c-power', name: 'Power', budgeted: 10000, spent: -2500, balance: 7500 }] },
        { id: 'g-fun', name: 'Fun', categories: [{ id: 'c-eat', name: 'Eating out', budgeted: 20000, spent: -4000, balance: 16000 }] },
        { id: 'g-income', name: 'Income', is_income: true, categories: [{ id: 'c-pay', name: 'Paycheck', budgeted: 0, spent: 0, balance: 0 }] },
      ],
    })),
    getSchedules: jest.fn(async () => []),
    getRules: jest.fn(async () => []),
  };
}

const widget = (id, type, meta, x = 0, y = 0) => ({ id, dashboard_page_id: 'page-1', type, width: 4, height: 2, x, y, meta, tombstone: false });
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function one(type, meta, extra = {}) {
  const client = makeClient({ dashboard: [widget(U(1), type, meta)], ...extra });
  const body = await buildReports({ client, now: NOW });
  expectValid(body);
  return body.cards[0];
}

describe('response shape', () => {
  test('schema 1, generatedAt from now, validates', async () => {
    const body = await buildReports({ client: makeClient(), now: NOW });
    expect(body).toEqual({ schema: 1, generatedAt: NOW.toISOString(), cards: [] });
    expectValid(body);
  });

  test('a dashboard read failure is thrown, not hidden as an empty dashboard', async () => {
    const client = makeClient();
    client.aqlQuery.mockRejectedValue(new Error('boom'));
    await expect(buildReports({ client, now: NOW })).rejects.toThrow('boom');
  });
});

describe('ordering, cap and ids', () => {
  test('orders by y, then x, then id; ignores tombstoned rows and other pages', async () => {
    const dashboard = [
      widget(U(3), 'markdown-card', { content: '## C' }, 4, 2),
      widget(U(2), 'markdown-card', { content: '## B' }, 0, 2),
      widget(U(1), 'markdown-card', { content: '## A' }, 8, 0),
      { ...widget(U(9), 'markdown-card', { content: '## gone' }, 0, 0), tombstone: true },
      { ...widget(U(8), 'markdown-card', { content: '## other page' }, 0, 0), dashboard_page_id: 'page-2' },
    ];
    const body = await buildReports({ client: makeClient({ dashboard }), now: NOW });
    expect(body.cards.map((c) => c.title)).toEqual(['A', 'B', 'C']);
    expectValid(body);
  });

  test('keeps at most 40 cards', async () => {
    const dashboard = Array.from({ length: 55 }, (_, i) => widget(U(i + 1), 'markdown-card', { content: `## N${i}` }, 0, i));
    const body = await buildReports({ client: makeClient({ dashboard }), now: NOW });
    expect(body.cards).toHaveLength(40);
    expect(body.cards[0].title).toBe('N0');
    expectValid(body);
  });

  test('non-conforming and duplicate widget ids get safe unique ids', async () => {
    const dashboard = [
      widget('has spaces & symbols!', 'markdown-card', { content: '## A' }, 0, 0),
      widget('x'.repeat(100), 'markdown-card', { content: '## B' }, 0, 1),
      widget('dup', 'markdown-card', { content: '## C' }, 0, 2),
      widget('dup', 'markdown-card', { content: '## D' }, 0, 3),
      widget('', 'markdown-card', { content: '## E' }, 0, 4),
    ];
    const body = await buildReports({ client: makeClient({ dashboard }), now: NOW });
    expectValid(body);
    expect(new Set(body.cards.map((c) => c.id)).size).toBe(5);
  });
});

describe('text and unsupported', () => {
  test('plain markdown becomes text with markdown stripped; first heading is the title', async () => {
    const card = await one('markdown-card', { content: '## Tips\n\nUse **bold** and [a link](https://example.com).\n\n- one\n- two' });
    expect(card).toEqual({ id: U(1), kind: 'text', title: 'Tips', text: 'Use bold and a link.\n\n- one\n- two' });
  });

  test('a named markdown card keeps its name and its whole text, capped at 4000', async () => {
    const card = await one('markdown-card', { name: 'Notes', content: `# Heading\n${'a'.repeat(5000)}` });
    expect(card.title).toBe('Notes');
    expect(card.text.startsWith('Heading')).toBe(true);
    expect(card.text).toHaveLength(4000);
  });

  test('unknown widget types are unsupported and keep their name', async () => {
    expect(await one('sankey-card', { name: 'Sankey' })).toEqual({ id: U(1), kind: 'unsupported', title: 'Sankey' });
  });

  test('stripMarkdown handles images, code and quotes', () => {
    expect(stripMarkdown('> quote\n![alt](x.png)\n`code` ~~old~~')).toBe('quote\nalt\ncode old');
  });
});

describe('summary-card', () => {
  const content = (type) => JSON.stringify({ type, fontSize: 20 });
  const base = { timeFrame: { start: '2024-01-01', end: '2024-12-31', mode: 'yearToDate' }, conditionsOp: 'and' };

  test('sum with conditions', async () => {
    const card = await one('summary-card', { ...base, name: 'Total Income (YTD)', content: content('sum'), conditions: [{ field: 'amount', op: 'gt', value: 0 }, { field: 'account', op: 'onBudget', value: '' }, { field: 'transfer', op: 'is', value: false }] });
    expect(card).toMatchObject({ kind: 'stat', title: 'Total Income (YTD)', format: 'money', value: 500000 + 400000 * 3 });
  });

  test('expenses sum, average per month and per transaction', async () => {
    const conditions = [{ field: 'amount', op: 'lt', value: 0 }, { field: 'transfer', op: 'is', value: false }];
    const expenses = -(100000 * 3 + 3000 + 4000 + 2500);
    const sum = await one('summary-card', { ...base, content: content('sum'), conditions });
    expect(sum.value).toBe(expenses);
    const perMonth = await one('summary-card', { ...base, content: content('avgPerMonth'), conditions });
    expect(perMonth.value).toBe(Math.round(expenses / 11));
    const perTx = await one('summary-card', { ...base, content: content('avgPerTransact'), conditions });
    expect(perTx.value).toBe(Math.round(expenses / 6));
  });

  test('a condition it cannot represent makes the card unsupported', async () => {
    const card = await one('summary-card', { ...base, name: 'Odd', content: content('sum'), conditions: [{ field: 'date', op: 'isapprox', value: '2026-01-01' }] });
    expect(card).toEqual({ id: U(1), kind: 'unsupported', title: 'Odd' });
  });

  test('percentage and unknown summary types are unsupported', async () => {
    expect((await one('summary-card', { ...base, content: content('percentage'), conditions: [] })).kind).toBe('unsupported');
    expect((await one('summary-card', { ...base, content: 'not json' })).kind).toBe('unsupported');
  });
});

describe('time frames', () => {
  test('static range', async () => {
    expect(await resolveTimeFrame({ start: '2025-02', end: '2025-04', mode: 'static' }, NOW)).toEqual({ start: '2025-02-01', end: '2025-04-30' });
    expect(await resolveTimeFrame({ start: '2025-02-10', end: '2025-02-20' }, NOW)).toEqual({ start: '2025-02-10', end: '2025-02-20' });
  });
  test('sliding window keeps its length, ending this month', async () => {
    expect(await resolveTimeFrame({ start: '2024-01-01', end: '2024-03-31', mode: 'sliding-window' }, NOW)).toEqual({ start: '2026-09-01', end: '2026-11-30' });
  });
  test('yearToDate, lastYear and full', async () => {
    expect(await resolveTimeFrame({ mode: 'yearToDate' }, NOW)).toEqual({ start: '2026-01-01', end: '2026-11-12' });
    expect(await resolveTimeFrame({ mode: 'lastYear' }, NOW)).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    expect(await resolveTimeFrame({ mode: 'full' }, NOW, { earliest: async () => '2023-05-04' })).toEqual({ start: '2023-05-04', end: '2026-11-12' });
  });
  test('garbage never throws and falls back to a sensible window', async () => {
    const fallback = { start: '2025-12-01', end: '2026-11-30' };
    expect(await resolveTimeFrame(undefined, NOW)).toEqual(fallback);
    expect(await resolveTimeFrame({ mode: 'weird', start: 'x', end: 5 }, NOW)).toEqual(fallback);
    expect(await resolveTimeFrame({ start: '2025-05-01', end: '2025-01-01' }, NOW)).toEqual(fallback);
    expect(await resolveTimeFrame({ mode: 'full' }, NOW, { earliest: async () => { throw new Error('x'); } })).toEqual({ start: '2025-12-01', end: '2026-11-12' });
    expect(await resolveTimeFrame('nonsense', NOW)).toEqual(fallback);
  });
  test('saved report ranges', async () => {
    expect(await resolveReportRange({ date_static: 0, date_range: 'Last month' }, NOW)).toEqual({ start: '2026-10-01', end: '2026-10-31' });
    expect(await resolveReportRange({ date_static: 0, date_range: 'Last 3 months' }, NOW)).toEqual({ start: '2026-08-01', end: '2026-10-31' });
    expect(await resolveReportRange({ date_static: 1, start: '2025-01', end: '2025-03' }, NOW)).toEqual({ start: '2025-01-01', end: '2025-03-31' });
    expect(await resolveReportRange({ date_range: 'Never heard of it' }, NOW)).toEqual({ start: '2025-12-01', end: '2026-11-30' });
  });
});

describe('chart types', () => {
  const md = (name, config = '[]') => ({ content: `{{INSIGHTS:${name}:${config}}}` });
  const report = (extra) => ({ id: 'rep-1', name: 'Saved', date_static: 0, date_range: 'This month', group_by: 'Category', balance_type: 'Payment', graph_type: 'BarGraph', interval: 'Monthly', conditions: [], conditions_op: 'and', show_offbudget: false, show_uncategorized: true, tombstone: false, ...extra });
  const run = (r) => one('custom-report', { id: 'rep-1' }, { customReports: [r] });

  test('custom reports: donut, bar, others', async () => {
    expect((await run(report({ graph_type: 'DonutGraph' }))).chart).toBe('donut');
    expect((await run(report({ graph_type: 'BarGraph' }))).chart).toBe('bars');
    expect((await run(report({ graph_type: 'StackedBarGraph' }))).chart).toBe('stackedBar');
    expect((await run(report({ graph_type: 'TableGraph' }))).kind).toBe('table');
    expect((await run(report({ group_by: 'Interval', graph_type: 'LineGraph' }))).chart).toBe('line');
    expect((await run(report({ group_by: 'Interval', graph_type: 'AreaGraph' }))).chart).toBe('area');
    expect((await run(report({ group_by: 'Interval', graph_type: 'BarGraph' }))).chart).toBe('bar');
  });

  test('spending card and Insights widgets', async () => {
    expect((await one('spending-card', { mode: 'single-month' })).chart).toBe('donut');
    expect((await one('spending-card', { mode: 'budget' })).chart).toBe('donut');
    expect((await one('spending-card', { mode: 'average' })).chart).toBe('donut');
    expect((await one('markdown-card', md('spending-breakdown-donut'))).chart).toBe('donut');
    expect((await one('markdown-card', md('spending-treemap'))).chart).toBe('treemap');
    expect((await one('markdown-card', md('account-balances'))).chart).toBe('stackedArea');
  });
});

describe('report list and report=<id>', () => {
  const pages = [{ id: 'page-1', name: 'Main', tombstone: false }, { id: 'page-2', name: 'Second', tombstone: false }, { id: 'page-gone', name: 'Gone', tombstone: true }, { id: 'bad id', name: 'Bad', tombstone: false }];
  const customReports = [{ id: 'rep-1', name: 'Saved', date_static: 0, date_range: 'This month', group_by: 'Category', balance_type: 'Payment', graph_type: 'DonutGraph', conditions: [], tombstone: false }, { id: 'rep-gone', name: 'Old', tombstone: true }, { id: 'bad/id', name: 'Bad', tombstone: false }];
  const dashboard = [widget(U(1), 'markdown-card', { content: '## One' }), { ...widget(U(2), 'markdown-card', { content: '## Two' }), dashboard_page_id: 'page-2' }];

  test('list: pages in order then custom reports, junk skipped, defaultId the first page', async () => {
    const body = await buildReportList({ client: makeClient({ pages, customReports }), now: NOW });
    expect(validateList(body)).toBe(true);
    expect(body).toEqual({ schema: 1, generatedAt: NOW.toISOString(), reports: [{ id: 'page-1', title: 'Main', kind: 'dashboard' }, { id: 'page-2', title: 'Second', kind: 'dashboard' }, { id: 'rep-1', title: 'Saved', kind: 'custom' }], defaultId: 'page-1' });
    const empty = await buildReportList({ client: makeClient({ pages: [], customReports: [] }), now: NOW });
    expect(empty).toMatchObject({ reports: [], defaultId: null });
  });

  test('report=<page id>: that page; no param: the first page; custom id: one card; unknown 404', async () => {
    const client = makeClient({ pages, customReports, dashboard });
    const titles = async (reportId) => {
      const body = await buildReports({ client, now: NOW, reportId });
      expectValid(body);
      return body.cards.map((c) => c.title);
    };
    expect(await titles(undefined)).toEqual(['One']);
    expect(await titles('page-1')).toEqual(['One']);
    expect(await titles('page-2')).toEqual(['Two']);
    const custom = await buildReports({ client, now: NOW, reportId: 'rep-1' });
    expectValid(custom);
    expect(custom.cards).toHaveLength(1);
    expect(custom.cards[0]).toMatchObject({ id: 'rep-1', kind: 'breakdown', title: 'Saved', chart: 'donut' });
    for (const id of ['nope', 'page-gone', 'rep-gone']) {
      await expect(buildReports({ client, now: NOW, reportId: id })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    }
  });
});

describe('series cards', () => {
  test('cash-flow-card: income and expenses per month as a bar multiseries, last 6 months', async () => {
    const card = await one('cash-flow-card', null);
    expect(card.kind).toBe('multiseries');
    expect(card.chart).toBe('bar');
    expect(card.labels).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(card.series).toEqual([
      { name: 'Income', values: [0, 0, 0, 400000, 400000, 400000] },
      { name: 'Expenses', values: [0, 0, 0, 100000, 103000, 106500] },
    ]);
  });

  test('net-worth-card: month-end totals across open accounts, carried forward', async () => {
    const card = await one('net-worth-card', null);
    expect(card.chart).toBe('line');
    expect(card.points).toHaveLength(12);
    expect(card.points[0].label).toBe('2025-12');
    const byLabel = Object.fromEntries(card.points.map((p) => [p.label, p.value]));
    expect(byLabel['2026-01']).toBe(500000);
    expect(byLabel['2026-08']).toBe(500000);
    expect(byLabel['2026-09']).toBe(500000 + 300000);
    expect(byLabel['2026-10']).toBe(800000 + 297000);
    // November: income, rent, diner, power, and both sides of the transfer (closed account excluded).
    expect(byLabel['2026-11']).toBe(1097000 + 400000 - 100000 - 4000 - 2500);
  });

  test('net-worth-card honors a static time frame', async () => {
    const card = await one('net-worth-card', { timeFrame: { start: '2026-09-01', end: '2026-10-31', mode: 'static' } });
    expect(card.points.map((p) => p.label)).toEqual(['2026-09', '2026-10']);
    expect(card.points[0].value).toBe(800000);
  });
});

describe('breakdown and calendar cards', () => {
  test('spending-card single-month: this month by category', async () => {
    const card = await one('spending-card', { name: 'This Month', mode: 'single-month' });
    expect(card).toMatchObject({ kind: 'breakdown', title: 'This Month', format: 'money', total: 106500 });
    expect(card.items).toEqual([
      { label: 'Rent', value: 100000, drill: { level: 'payees', categoryId: 'c-rent' }, color: 'blue' },
      { label: 'Eating out', value: 4000, drill: { level: 'payees', categoryId: 'c-eat' }, color: 'teal' },
      { label: 'Power', value: 2500, drill: { level: 'payees', categoryId: 'c-power' }, color: 'blue' },
    ]);
  });

  test('spending-card average: mean of the last three months', async () => {
    const card = await one('spending-card', { mode: 'average' });
    expect(card.items[0]).toEqual({ label: 'Rent', value: 66667, drill: { level: 'payees', categoryId: 'c-rent' }, color: 'blue' });
    expect(card.total).toBe(Math.round(card.items.reduce((s, i) => s + i.value, 0)));
  });

  test('spending-card budget: spent from the budget month', async () => {
    const card = await one('spending-card', { mode: 'budget' });
    expect(card.items.map((i) => i.label)).toEqual(['Rent', 'Eating out', 'Power']);
  });

  test('month-based spending cards carry monthNav (month shown, earliest transaction month); the average card does not', async () => {
    for (const meta of [{ mode: 'single-month' }, { mode: 'budget' }]) {
      const card = await one('spending-card', meta);
      expect(card.monthNav.month).toBe('2026-11');
      expect(card.monthNav.earliest).toMatch(/^\d{4}-\d{2}$/);
      expect(card.monthNav.earliest <= card.monthNav.month).toBe(true);
    }
    expect((await one('spending-card', { mode: 'average' })).monthNav).toBeUndefined();
  });

  test('built as of a past moment, the card shows that month', async () => {
    const body = await buildReports({ client: makeClient(), now: NOW, asOf: new Date(2026, 9, 31, 23, 59, 59) });
    const card = body.cards.find((c) => c.monthNav);
    if (card) expect(card.monthNav.month).toBe('2026-10');
    expect(body.generatedAt).toBe(NOW.toISOString());
  });

  test('calendar-card: at most 62 days, net per day, conditions applied, never past today', async () => {
    const card = await one('calendar-card', { name: 'Calendar', timeFrame: { start: '2024-01-01', end: '2024-03-31', mode: 'sliding-window' }, conditions: [{ field: 'transfer', op: 'is', value: false }], conditionsOp: 'and' });
    expect(card.kind).toBe('calendar');
    expect(card.days).toHaveLength(62);
    expect(card.days[card.days.length - 1].date).toBe('2026-11-12');
    const byDate = Object.fromEntries(card.days.map((d) => [d.date, d.value]));
    expect(byDate['2026-11-05']).toBe(-4000);
    expect(byDate['2026-11-08']).toBe(0);
    expect(byDate['2026-11-07']).toBe(0);
  });
});

describe('custom-report', () => {
  const report = (extra) => ({ id: 'rep-1', name: 'Saved', date_static: 0, date_range: 'Last 3 months', group_by: 'Category', balance_type: 'Payment', graph_type: 'BarGraph', interval: 'Monthly', conditions: [], conditions_op: 'and', show_offbudget: false, show_uncategorized: true, tombstone: false, ...extra });
  const run = (r, meta = { id: 'rep-1' }) => one('custom-report', meta, { customReports: [r] });

  test('groupBy Category as a breakdown of payments (positive)', async () => {
    const card = await run(report({ date_range: 'This month' }));
    expect(card).toMatchObject({ kind: 'breakdown', title: 'Saved', total: 106500 });
    expect(card.items[0]).toEqual({ label: 'Rent', value: 100000, drill: { level: 'payees', categoryId: 'c-rent' }, color: 'blue' });
  });

  test('groupBy Group, Payee and Account', async () => {
    const group = await run(report({ date_range: 'This month', group_by: 'Group' }));
    expect(group.items).toEqual([
      { label: 'Bills', value: 102500, drill: { level: 'categories', categoryIds: ['c-rent', 'c-power'] }, color: 'blue' },
      { label: 'Fun', value: 4000, drill: { level: 'categories', categoryIds: ['c-eat'] }, color: 'teal' },
    ]);
    const payee = await run(report({ date_range: 'Last month', group_by: 'Payee' }));
    expect(payee.items.map((i) => i.label).sort()).toEqual(['Example Diner', 'Uncategorized']);
    expect(payee.items.every((i) => !('drill' in i))).toBe(true);
    const account = await run(report({ date_range: 'This month', group_by: 'Account' }));
    expect(account.items[0].label).toBe('Checking');
  });

  test('deposits and net balance types', async () => {
    const dep = await run(report({ date_range: 'This month', balance_type: 'Deposit' }));
    expect(dep.total).toBe(400000);
    const net = await run(report({ date_range: 'This month', balance_type: 'Net' }));
    expect(net.total).toBe(400000 - 106500);
  });

  test('groupBy Interval as a series with the graph type as chart', async () => {
    const bar = await run(report({ group_by: 'Interval', date_range: 'Last 3 months', balance_type: 'Net', graph_type: 'LineGraph' }));
    expect(bar).toMatchObject({ kind: 'series', chart: 'line', format: 'money' });
    expect(bar.points).toEqual([{ label: '2026-08', value: 0 }, { label: '2026-09', value: 300000 }, { label: '2026-10', value: 297000 }]);
    const area = await run(report({ group_by: 'Interval', graph_type: 'AreaGraph', balance_type: 'Payment' }));
    expect(area.chart).toBe('area');
    expect(area.points[1].value).toBe(100000);
  });

  test('conditions narrow the report; unrepresentable ones fall back to unsupported', async () => {
    const narrowed = await run(report({ date_range: 'This month', conditions: [{ field: 'category', op: 'oneOf', value: ['c-eat'] }] }));
    expect(narrowed.items).toEqual([{ label: 'Eating out', value: 4000, drill: { level: 'payees', categoryId: 'c-eat' }, color: 'teal' }]);
    const bad = await run(report({ conditions: [{ field: 'category', op: 'notOneOf', value: ['c-eat'] }] }));
    expect(bad).toEqual({ id: U(1), kind: 'unsupported', title: 'Report' });
  });

  test('a missing report is unsupported', async () => {
    expect((await run(report(), { id: 'nope', name: 'Gone' })).kind).toBe('unsupported');
  });

  test('breakdowns cap at 60 items with an Other that keeps the total', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `c${i}`, name: `Cat ${i}` }));
    const client = makeClient({ dashboard: [widget(U(1), 'custom-report', { id: 'rep-1' })], customReports: [report({ date_range: 'This month' })] });
    client.getCategoryGroups.mockResolvedValue([{ id: 'g', name: 'G', categories: many }]);
    const rows = many.map((c, i) => ({ id: c.id, amount: -(i + 1) }));
    const original = client.aqlQuery.getMockImplementation();
    client.aqlQuery.mockImplementation(async (query) => (query.serialize().table === 'transactions' ? { data: rows } : original(query)));
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    const card = body.cards[0];
    expect(card.items).toHaveLength(60);
    expect(card.items[59].label).toBe('Other');
    expect(card.total).toBe((80 * 81) / 2);
    expect(card.items.reduce((s, i) => s + i.value, 0)).toBe(card.total);
  });

  test('series are capped at 400 points', async () => {
    const card = await run(report({ group_by: 'Interval', interval: 'Daily', date_static: 1, start: '2024-01-01', end: '2026-10-31' }));
    expect(card.points).toHaveLength(400);
    expect(card.points[399].label).toBe('2026-10-31');
  });
});

describe('Insights placeholders', () => {
  const md = (name, config = 'null') => ({ content: `{{INSIGHTS:${name}:${config}}}` });

  test('parsePlaceholder follows the bundle: nested braces, legacy prefix, junk', () => {
    expect(parsePlaceholder('x {{INSIGHTS:spending-heatmap:{}}} y')).toEqual({ name: 'spending-heatmap', config: {} });
    expect(parsePlaceholder('{{ACTUALMINT:pacing-bars:["a"]}}')).toEqual({ name: 'pacing-bars', config: ['a'] });
    expect(parsePlaceholder('{{INSIGHTS:burn-rate:}}')).toBeNull();
    expect(parsePlaceholder('plain text')).toBeNull();
  });

  test('pacing-bars to progress', async () => {
    const card = await one('markdown-card', md('pacing-bars', '["c-rent","c-eat"]'));
    expect(card).toMatchObject({ kind: 'progress', format: 'money', title: 'Budget pacing' });
    expect(card.items).toEqual([
      { label: 'Rent', current: 100000, target: 100000, drill: { level: 'payees', categoryId: 'c-rent' }, color: 'blue' },
      { label: 'Eating out', current: 4000, target: 20000, drill: { level: 'payees', categoryId: 'c-eat' }, color: 'teal' },
    ]);
  });

  test('pacing-bars rollup items in the legacy array become one drillable row', async () => {
    const card = await one('markdown-card', md('pacing-bars', '[{"title":"House","budgets":["c-rent","c-power","c-gone"]},"c-eat"]'));
    expect(card.items).toEqual([
      { label: 'House', current: 102500, target: 110000, drill: { level: 'categories', categoryIds: ['c-rent', 'c-power'] }, color: 'blue' },
      { label: 'Eating out', current: 4000, target: 20000, drill: { level: 'payees', categoryId: 'c-eat' }, color: 'teal' },
    ]);
  });

  test('pacing-bars allGroups: one row per visible expense group, then picked ids; income and hidden left out', async () => {
    const card = await one('markdown-card', md('pacing-bars', '{"categoryIds":["c-eat"],"allGroups":true}'));
    expect(card.items).toEqual([
      { label: 'Bills', current: 102500, target: 110000, drill: { level: 'categories', categoryIds: ['c-rent', 'c-power'] }, color: 'blue' },
      { label: 'Fun', current: 4000, target: 20000, drill: { level: 'categories', categoryIds: ['c-eat'] }, color: 'teal' },
      { label: 'Eating out', current: 4000, target: 20000, drill: { level: 'payees', categoryId: 'c-eat' }, color: 'teal' },
    ]);
    const only = await one('markdown-card', md('pacing-bars', '{"categoryIds":[],"allGroups":true}'));
    expect(only.items.map((i) => i.label)).toEqual(['Bills', 'Fun']);
  });

  test('pacing-bars colours: a rollup is the group colour only when it is exactly that group; explicit colours win', async () => {
    const colorOf = async (cfg) => (await one('markdown-card', md('pacing-bars', JSON.stringify(cfg)))).items.map((i) => i.color);
    // Bills is blue, Fun teal by position.
    expect(await colorOf([{ title: 'Part', budgets: ['c-rent'] }])).toEqual([undefined]);
    expect(await colorOf([{ title: 'Mixed', budgets: ['c-rent', 'c-eat'] }])).toEqual([undefined]);
    expect(await colorOf([{ title: 'All', budgets: ['c-rent', 'c-power'] }])).toEqual(['blue']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-colors-'));
    const original = process.env.INSIGHTS_DATA_DIR;
    process.env.INSIGHTS_DATA_DIR = dir;
    try {
      fs.writeFileSync(path.join(dir, 'mobile-colors.json'), JSON.stringify({ groups: { 'g-bills': 'red' }, categories: { 'c-power': 'pink' } }));
      expect(await colorOf({ categoryIds: ['c-rent', 'c-power'], allGroups: true })).toEqual(['red', 'teal', 'red', 'pink']);
    } finally {
      if (original === undefined) delete process.env.INSIGHTS_DATA_DIR;
      else process.env.INSIGHTS_DATA_DIR = original;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('pacing-bars groupIds: only those groups in that order, unknown/duplicate/income ids ignored, picked rows after', async () => {
    const labels = async (cfg) => (await one('markdown-card', md('pacing-bars', JSON.stringify(cfg)))).items.map((i) => i.label);
    expect(await labels({ categoryIds: [], allGroups: true, groupIds: ['g-fun', 'g-bills'] })).toEqual(['Fun', 'Bills']);
    expect(await labels({ categoryIds: [], allGroups: true, groupIds: ['g-fun'] })).toEqual(['Fun']);
    expect(await labels({ categoryIds: [], allGroups: true, groupIds: ['g-nope', 'g-fun', 'g-fun', 'g-income'] })).toEqual(['Fun']);
    expect(await labels({ categoryIds: ['c-power'], allGroups: true, groupIds: ['g-fun'] })).toEqual(['Fun', 'Power']);
    expect(await labels({ categoryIds: [], allGroups: true, groupIds: [] })).toEqual([]);
    expect(await labels({ categoryIds: [], allGroups: true, groupIds: [5, 'g-bills'] })).toEqual(['Bills']);
    // Legacy: no groupIds means every group; groupIds without allGroups is ignored; bare array.
    expect(await labels({ categoryIds: [], allGroups: true })).toEqual(['Bills', 'Fun']);
    expect(await labels({ categoryIds: ['c-eat'], groupIds: ['g-fun'] })).toEqual(['Eating out']);
    expect(await labels(['c-eat'])).toEqual(['Eating out']);
    const card = await one('markdown-card', md('pacing-bars', '{"allGroups":true,"groupIds":["g-fun"]}'));
    expect(card.items[0].drill).toEqual({ level: 'categories', categoryIds: ['c-eat'] });
  });

  test('pacing-bars object without allGroups behaves like the picked ids', async () => {
    const card = await one('markdown-card', md('pacing-bars', '{"categoryIds":["c-power"]}'));
    expect(card.items.map((i) => i.label)).toEqual(['Power']);
  });

  test('pacing-bars with no ids shows spending categories with something available', async () => {
    const card = await one('markdown-card', md('pacing-bars', '[]'));
    expect(card.items.map((i) => i.label)).toEqual(['Rent', 'Power', 'Eating out']);
  });

  test('savings goals to progress, from the goals file', async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-goals-'));
    ORIGINAL_DATA_DIR = process.env.INSIGHTS_DATA_DIR;
    jest.resetModules();
    process.env.INSIGHTS_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(dataDir, 'goals.json'), JSON.stringify([{ id: 'g1', entityType: 'category', entityId: 'c-power', targetAmountCents: 50000 }, { id: 'g2', entityType: 'account', entityId: 'a-sav', targetAmountCents: 900000 }]));
    const { buildReports: fresh } = require('../src/mobile/v1/reports');
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', md('savings-goals-thermometers', '[]'))] });
    const body = await fresh({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0]).toMatchObject({ kind: 'progress', items: [{ label: 'Power', current: 7500, target: 50000 }, { label: 'Savings', current: 5000, target: 900000 }] });
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.INSIGHTS_DATA_DIR;
    else process.env.INSIGHTS_DATA_DIR = ORIGINAL_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('month-end net to stat', async () => {
    const card = await one('markdown-card', md('month-end-net'));
    expect(card.kind).toBe('stat');
    expect(card.format).toBe('money');
  });

  test('bills-timeline to list', async () => {
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', md('bills-timeline'))] });
    client.getSchedules.mockResolvedValue([{ id: 's1', name: 'Power bill', payee: 'p-diner', account: 'a-chk', amount: -8400, date: '2026-11-20', next_date: '2026-11-20', completed: false, rule: 'r1' }]);
    client.getRules.mockResolvedValue([]);
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0].kind).toBe('list');
    expect(body.cards[0].rows).toEqual([{ title: 'Power bill', subtitle: 'Checking', date: '2026-11-20', value: -8400 }]);
  });

  test('spending-heatmap to calendar; the donut to a drillable breakdown', async () => {
    const heat = await one('markdown-card', md('spending-heatmap', '"month"'));
    expect(heat.kind).toBe('calendar');
    expect(heat.days.find((d) => d.date === '2026-11-05').value).toBe(4000);
    const donut = await one('markdown-card', md('spending-breakdown-donut', '[]'));
    expect(donut).toMatchObject({ kind: 'breakdown', chart: 'donut', total: 106500 });
  });

  test('an Insights widget with no mobile form is unsupported', async () => {
    expect(await one('markdown-card', { name: 'Mystery', ...md('no-such-widget') })).toEqual({ id: U(1), kind: 'unsupported', title: 'Mystery' });
  });
});

describe('isolation', () => {
  test('a throwing card becomes unsupported and the rest still render', async () => {
    const dashboard = [
      widget(U(1), 'markdown-card', { content: '## First' }, 0, 0),
      widget(U(2), 'cash-flow-card', { name: 'Cash' }, 0, 1),
      widget(U(3), 'markdown-card', { content: '## Last' }, 0, 2),
    ];
    const client = makeClient({ dashboard });
    const original = client.aqlQuery.getMockImplementation();
    client.aqlQuery.mockImplementation(async (query) => {
      const s = query.serialize();
      // loadMonthCashFlow groups transactions by category; make only that fail.
      if (s.table === 'transactions' && s.groupExpressions[0] === 'category') throw new Error('secret budget detail');
      return original(query);
    });
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards.map((c) => c.kind)).toEqual(['text', 'unsupported', 'text']);
    expect(body.cards[1].title).toBe('Cash');
    // Logged by code only, never the message.
    const logged = console.error.mock.calls.flat().join(' ');
    expect(logged).not.toContain('secret budget detail');
  });

  test('a card that never settles times out and keeps its title', async () => {
    const dashboard = [widget(U(1), 'calendar-card', { name: 'Slow', timeFrame: { mode: 'yearToDate' } }, 0, 0), widget(U(2), 'markdown-card', { content: '## Fine' }, 0, 1)];
    const client = makeClient({ dashboard });
    const original = client.aqlQuery.getMockImplementation();
    client.aqlQuery.mockImplementation((query) => (query.serialize().table === 'transactions' ? new Promise(() => {}) : original(query)));
    const started = Date.now();
    const body = await buildReports({ client, now: NOW, cardTimeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expectValid(body);
    expect(body.cards).toEqual([{ id: U(1), kind: 'unsupported', title: 'Slow' }, expect.objectContaining({ kind: 'text', title: 'Fine' })]);
  });
});

describe('whole dashboard', () => {
  test('a demo-shaped dashboard validates against the schema', async () => {
    const dashboard = [
      widget(U(1), 'summary-card', { name: 'Total Income (YTD)', content: '{"type":"sum","fontSize":20}', timeFrame: { start: '2024-01-01', end: '2024-12-31', mode: 'yearToDate' }, conditions: [{ field: 'amount', op: 'gt', value: 0 }], conditionsOp: 'and' }, 0, 0),
      widget(U(2), 'net-worth-card', null, 0, 2),
      widget(U(3), 'cash-flow-card', null, 6, 2),
      widget(U(4), 'spending-card', { name: 'This Month', mode: 'single-month' }, 0, 5),
      widget(U(5), 'calendar-card', { name: 'Transaction Calendar', timeFrame: { start: '2024-01-01', end: '2024-03-31', mode: 'sliding-window' }, conditions: [{ field: 'transfer', op: 'is', value: false }], conditionsOp: 'and' }, 0, 8),
      widget(U(6), 'markdown-card', { content: '## Dashboard Tips\n\nYou can add **widgets**.' }, 8, 10),
      widget(U(7), 'markdown-card', { content: '{{INSIGHTS:pacing-bars:[]}}' }, 0, 12),
      widget(U(8), 'formula-card', { name: 'Formula' }, 0, 14),
    ];
    const body = await buildReports({ client: makeClient({ dashboard }), now: NOW });
    expectValid(body);
    expect(body.cards.map((c) => c.kind)).toEqual(['stat', 'series', 'multiseries', 'breakdown', 'calendar', 'text', 'progress', 'unsupported']);
  });
});

// ---------------------------------------------------------------------------
// Every web chart on mobile: gauge, multiseries, sankey, timeline, table, the
// list cards and breakdown drills. Same stub, same schema validation.

describe('breakdown drills', () => {
  const md = (name, config = '[]') => ({ content: `{{INSIGHTS:${name}:${config}}}` });
  const NOW_BUILDER = NOW;

  test('donut and treemap slices drill into their group: visible category ids only', async () => {
    const donut = await one('markdown-card', md('spending-breakdown-donut'));
    expect(donut.chart).toBe('donut');
    expect(donut.items).toEqual([
      { label: 'Bills', value: 102500, drill: { level: 'categories', categoryIds: ['c-rent', 'c-power'] }, color: 'blue' },
      { label: 'Fun', value: 4000, drill: { level: 'categories', categoryIds: ['c-eat'] }, color: 'teal' },
    ]);
    const tree = await one('markdown-card', md('spending-treemap'));
    expect(tree.chart).toBe('treemap');
    expect(tree.items.map((i) => i.drill.level)).toEqual(['categories', 'categories']);
  });

  test('groupIds narrow the donut like the web, and hidden categories are not drilled into', async () => {
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', md('spending-breakdown-donut', '["g-fun"]'))] });
    client.getCategoryGroups.mockResolvedValue(GROUPS.map((g) => (g.id === 'g-fun' ? { ...g, categories: [...g.categories, { id: 'c-hid', name: 'Hidden', hidden: true }] } : g)));
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0].items).toEqual([{ label: 'Fun', value: 4000, drill: { level: 'categories', categoryIds: ['c-eat'] }, color: 'teal' }]);
  });

  test('a user-made Transfers group is left out and a group with no visible category has no drill', async () => {
    const { insightsBuilder } = require('../src/mobile/v1/reports-insights');
    const client = {
      aqlQuery: jest.fn(async (query) => {
        const t = query.serialize().table;
        if (t === 'category_groups') return { data: [{ id: 'g1', name: 'Home' }, { id: 'g2', name: 'Transfers' }, { id: 'g3', name: 'Empty' }] };
        return { data: [{ groupId: 'g1', amountCents: -500 }, { groupId: 'g2', amountCents: -900 }, { groupId: 'g3', amountCents: -100 }] };
      }),
    };
    const groups = [{ id: 'g1', name: 'Home', categories: [{ id: 'c1' }] }, { id: 'g3', name: 'Empty', categories: [{ id: 'c9', hidden: true }] }];
    const ctx = { client, month: '2026-11', excludeClause: async () => null, categoryGroups: async () => groups, colors: async () => createColorResolver(groups) };
    const card = await insightsBuilder('donut').build(ctx, []);
    expect(card.items).toEqual([{ label: 'Home', value: 500, drill: { level: 'categories', categoryIds: ['c1'] }, color: 'blue' }, { label: 'Empty', value: 100, color: 'teal' }]);
  });

  test('group drills cap at 200 ids', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, name: `C${i}` }));
    const { groupDrills } = require('../src/mobile/v1/reports-insights');
    const drills = await groupDrills({ categoryGroups: async () => [{ id: 'g', name: 'Big', categories: many }] });
    expect(drills.get('g').categoryIds).toHaveLength(200);
  });

  test('payee, account and the folded Other carry no drill; an invalid drill is dropped', async () => {
    const card = await one('custom-report', { id: 'r' }, { customReports: [{ id: 'r', name: 'R', date_static: 0, date_range: 'This month', group_by: 'Account', balance_type: 'Payment', graph_type: 'DonutGraph', conditions: [], show_offbudget: true, tombstone: false }] });
    expect(card.items.every((i) => !('drill' in i))).toBe(true);
    expect(NOW_BUILDER).toBe(NOW);
  });
});

describe('gauge (savings rate)', () => {
  const { insightsBuilder } = require('../src/mobile/v1/reports-insights');
  const md = (config = '[]') => ({ content: `{{INSIGHTS:savings-rate-gauge:${config}}}` });
  const flowClient = (income, spending) => ({
    aqlQuery: jest.fn(async () => ({ data: [{ categoryId: 'c-pay', amountCents: income }, { categoryId: 'c-rent', amountCents: -spending }] })),
    getCategoryGroups: jest.fn(async () => GROUPS),
  });
  const build = (income, spending, config = []) => insightsBuilder('savings-rate-gauge').build({ client: flowClient(income, spending), month: '2026-11' }, config);

  test('the whole-percent rate on a 0-100 axis with the web thresholds', async () => {
    const card = await one('markdown-card', md());
    expect(card).toMatchObject({ kind: 'gauge', format: 'percent', value: 73, min: 0, max: 100, caption: 'Net savings rate: 73%' });
    expect(card.bands).toEqual([{ from: 0, to: 20, tone: 'warn' }, { from: 20, to: 100, tone: 'good' }]);
  });

  test('negative rate: value pinned to 0, caption keeps the real figure, a bad band appears', async () => {
    const card = await build(1000, 1500);
    expect(card).toMatchObject({ value: 0, caption: 'Net savings rate: -50%' });
    expect(card.bands[0]).toEqual({ from: 0, to: 0, tone: 'bad' });
  });

  test('over 100% is clamped on the axis; investment groups are added back like the web', async () => {
    expect((await build(1000, 0)).value).toBe(100);
    const client = flowClient(1000, 900);
    client.getCategoryGroups.mockResolvedValue(GROUPS);
    const card = await insightsBuilder('savings-rate-gauge').build({ client, month: '2026-11' }, ['g-bills']);
    expect(card.caption).toBe('Net savings rate: 100%'); // (1000 - 900 + 900) / 1000
  });

  test('no income is unsupported, as on the web', async () => {
    await expect(build(0, 0)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(await one('markdown-card', md()).then((c) => c.kind)).toBe('gauge');
  });
});

describe('multiseries: burn rate', () => {
  const md = { content: '{{INSIGHTS:burn-rate:null}}' };

  test('spent so far to today (then gaps) against the even pace to the month budget', async () => {
    const card = await one('markdown-card', md);
    expect(card).toMatchObject({ kind: 'multiseries', chart: 'line', format: 'money' });
    expect(card.labels).toHaveLength(30);
    expect(card.labels.slice(0, 3)).toEqual(['1', '2', '3']);
    const [spent, pace] = card.series;
    expect(spent.name).toBe('Spent so far');
    expect(pace.name).toBe('Even pace');
    expect(spent.values.slice(0, 12)).toEqual([0, 0, 100000, 100000, 104000, 106500, 106500, 106500, 106500, 106500, 106500, 106500]);
    expect(spent.values.slice(12).every((v) => v === null)).toBe(true);
    expect(pace.values[0]).toBe(0);
    expect(pace.values[29]).toBe(130000);
    expect(pace.values[14]).toBe(Math.round((130000 * 14) / 29));
  });

  test('matches the web route numbers (same builder)', async () => {
    const { loadBurnRate } = require('../src/burn-rate-data');
    const web = await loadBurnRate(makeClient(), '2026-11', NOW);
    const card = await one('markdown-card', md);
    expect(web.budgetedCents).toBe(card.series[1].values[29]);
    expect(web.days.map((d) => d.cumulativeSpendCents)).toEqual(card.series[0].values.slice(0, web.days.length));
  });
});

describe('multiseries: account balances', () => {
  const md = (config = '[]') => ({ content: `{{INSIGHTS:account-balances:${config}}}` });

  test('one series per open account over the last month, stacked, with the web numbers', async () => {
    const card = await one('markdown-card', md());
    expect(card).toMatchObject({ kind: 'multiseries', chart: 'stackedArea', format: 'money' });
    expect(card.labels[0]).toBe('2026-10-12');
    expect(card.labels[card.labels.length - 1]).toBe('2026-11-12');
    expect(card.series.map((s) => s.name)).toEqual(['Checking', 'Savings', 'Brokerage']);
    expect(card.series[0].values[card.labels.length - 1]).toBe(1390500);
    expect(card.series[1].values[card.labels.length - 1]).toBe(-50000);
    expect(card.series.every((s) => s.values.length === card.labels.length)).toBe(true);
  });

  test('accountIds config (bare array and object) narrow the accounts, in that order', async () => {
    expect((await one('markdown-card', md('["a-sav","a-chk"]'))).series.map((s) => s.name)).toEqual(['Savings', 'Checking']);
    expect((await one('markdown-card', md('{"accountIds":["a-inv"],"labelContent":"name"}'))).series.map((s) => s.name)).toEqual(['Brokerage']);
  });

  test('hidden accounts stay hidden (scoped client)', async () => {
    const { scopeClient } = require('../src/mobile/v1/hidden');
    const client = scopeClient(makeClient({ dashboard: [widget(U(1), 'markdown-card', md())] }), ['a-sav']);
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0].series.map((s) => s.name)).toEqual(['Checking', 'Brokerage']);
  });

  test('more than 12 accounts fold the smallest into Other accounts', async () => {
    const accounts = Array.from({ length: 14 }, (_, i) => ({ id: `acc-${i}`, name: `Acct ${i}`, offbudget: false, closed: false }));
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', md())] });
    client.getAccounts.mockResolvedValue(accounts);
    client.getTransactions.mockImplementation(async (id) => [{ date: '2026-10-01', amount: (Number(id.slice(4)) + 1) * 100 }]);
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    const { series } = body.cards[0];
    expect(series).toHaveLength(12);
    expect(series[11].name).toBe('Other accounts');
    expect(series[11].values[0]).toBe(100 + 200 + 300);
  });
});

describe('multiseries: account balances chart and range options', () => {
  const md = (config) => ({ content: `{{INSIGHTS:account-balances:${config}}}` });
  const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

  test('chart "lines" gives a line chart, "stacked" and the bare/older forms stay stackedArea', async () => {
    expect((await one('markdown-card', md('{"accountIds":[],"chart":"lines"}'))).chart).toBe('line');
    expect((await one('markdown-card', md('{"chart":"stacked"}'))).chart).toBe('stackedArea');
    expect((await one('markdown-card', md('{"accountIds":[],"labelContent":"both"}'))).chart).toBe('stackedArea');
    expect((await one('markdown-card', md('[]'))).chart).toBe('stackedArea');
    expect((await one('markdown-card', md('{"chart":"weird","range":"weird"}'))).labels).toHaveLength(32);
  });

  test('1M and 3M are daily', async () => {
    expect((await one('markdown-card', md('{"range":"1M"}'))).labels).toHaveLength(32);
    const three = await one('markdown-card', md('{"range":"3M"}'));
    expect(three.labels[0]).toBe('2026-08-12');
    expect(three.labels).toHaveLength(93);
  });

  test('6M and 1Y are weekly and end today', async () => {
    for (const range of ['6M', '1Y']) {
      const card = await one('markdown-card', md(`{"range":"${range}"}`));
      expect(card.labels[card.labels.length - 1]).toBe('2026-11-12');
      for (let i = 1; i < card.labels.length; i += 1) expect(days(card.labels[i - 1], card.labels[i])).toBe(7);
      expect(card.series.every((x) => x.values.length === card.labels.length)).toBe(true);
    }
    expect((await one('markdown-card', md('{"range":"6M"}'))).labels.length).toBeLessThan(30);
  });

  test('ALL is monthly: month ends, the first day and today', async () => {
    const card = await one('markdown-card', md('{"range":"ALL"}'));
    expect(card.labels[0]).toBe('2026-01-02');
    expect(card.labels).toContain('2026-09-30');
    expect(card.labels).toContain('2026-10-31');
    expect(card.labels[card.labels.length - 1]).toBe('2026-11-12');
    expect(card.labels.length).toBeLessThan(15);
    expect(card.series[0].values[card.labels.length - 1]).toBe(1390500);
  });

  test('never more than 400 points', async () => {
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', md('{"range":"ALL"}'))] });
    client.getTransactions.mockImplementation(async (id) => (id === 'a-chk' ? [{ date: '1960-01-01', amount: 100 }] : []));
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0].labels.length).toBeLessThanOrEqual(400);
    expect(body.cards[0].labels[body.cards[0].labels.length - 1]).toBe('2026-11-12');
  });
});

describe('list: account balance list', () => {
  const md = (config) => ({ content: `{{INSIGHTS:account-balance-list:${config}}}` });

  test('every open account by default, with budget side and balance in cents, no total', async () => {
    const card = await one('markdown-card', md('{"accountIds":[],"showTotal":false}'));
    expect(card).toMatchObject({ kind: 'list', title: 'Account balances', signed: true });
    expect(card.rows).toEqual([
      { title: 'Checking', subtitle: 'On budget', value: 123456 },
      { title: 'Savings', subtitle: 'On budget', value: 5000 },
      { title: 'Brokerage', subtitle: 'Off budget', value: 5000 },
    ]);
  });

  test('picked accounts in the picked order, then a Total row', async () => {
    const card = await one('markdown-card', md('{"accountIds":["a-inv","a-chk","a-old","nope"],"showTotal":true}'));
    expect(card.rows).toEqual([
      { title: 'Brokerage', subtitle: 'Off budget', value: 5000 },
      { title: 'Checking', subtitle: 'On budget', value: 123456 },
      { title: 'Total', value: 128456 },
    ]);
  });

  test('a missing showTotal means no total', async () => {
    expect((await one('markdown-card', md('{"accountIds":["a-chk"]}'))).rows).toHaveLength(1);
  });

  test('hidden accounts are neither listed nor counted (scoped client)', async () => {
    const { scopeClient } = require('../src/mobile/v1/hidden');
    const client = scopeClient(makeClient({ dashboard: [widget(U(1), 'markdown-card', md('{"accountIds":[],"showTotal":true}'))] }), ['a-sav']);
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0].rows.map((r) => [r.title, r.value])).toEqual([['Checking', 123456], ['Brokerage', 5000], ['Total', 128456]]);
  });

  test('at most 60 rows including the total', async () => {
    const accounts = Array.from({ length: 70 }, (_, i) => ({ id: `acc-${i}`, name: `Acct ${i}`, offbudget: false, closed: false }));
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', md('{"showTotal":true}'))] });
    client.getAccounts.mockResolvedValue(accounts);
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0].rows).toHaveLength(60);
    expect(body.cards[0].rows[59].title).toBe('Total');
  });
});

describe('multiseries and table: custom reports', () => {
  const report = (extra) => ({ id: 'rep-1', name: 'Saved', date_static: 1, start: '2026-09', end: '2026-11', group_by: 'Category', balance_type: 'Payment', graph_type: 'StackedBarGraph', interval: 'Monthly', conditions: [], conditions_op: 'and', show_offbudget: false, show_uncategorized: true, tombstone: false, ...extra });
  const run = (r) => one('custom-report', { id: 'rep-1' }, { customReports: [r] });

  test('stacked bar by category over months: a series per category, positive payments', async () => {
    const card = await run(report());
    expect(card).toMatchObject({ kind: 'multiseries', chart: 'stackedBar', format: 'money', labels: ['2026-09', '2026-10', '2026-11'] });
    expect(card.series).toEqual([
      { name: 'Rent', values: [100000, 100000, 100000] },
      { name: 'Eating out', values: [0, 3000, 4000] },
      { name: 'Power', values: [0, 0, 2500] },
    ]);
  });

  test('line is a line multiseries; area is stackedArea; group by Group folds categories', async () => {
    expect((await run(report({ graph_type: 'LineGraph' }))).chart).toBe('line');
    const area = await run(report({ graph_type: 'AreaGraph', group_by: 'Group' }));
    expect(area.chart).toBe('stackedArea');
    expect(area.series.map((s) => s.name)).toEqual(['Bills', 'Fun']);
    expect(area.series[0].values).toEqual([100000, 100000, 102500]);
  });

  test('a plain bar report with groups stays one bar per group (as the web draws it)', async () => {
    expect(await run(report({ graph_type: 'BarGraph' }))).toMatchObject({ kind: 'breakdown', chart: 'bars' });
  });

  test('more than 12 groups fold the smallest into Other', async () => {
    const cats = Array.from({ length: 14 }, (_, i) => ({ id: `c-${i}`, name: `Cat ${i}` }));
    const txs = cats.map((c, i) => tx('2026-11-03', -(i + 1) * 100, { category: c.id }));
    const client = makeClient({ dashboard: [widget(U(1), 'custom-report', { id: 'rep-1' })], customReports: [report({ date_static: 0, date_range: 'This month' })] });
    client.getCategoryGroups.mockResolvedValue([{ id: 'g-x', name: 'X', categories: cats }]);
    const original = TXS.splice(0, TXS.length, ...txs);
    try {
      const body = await buildReports({ client, now: NOW });
      expectValid(body);
      const { series } = body.cards[0];
      expect(series).toHaveLength(12);
      expect(series[11].name).toBe('Other');
      expect(series[11].values[0]).toBe(100 + 200 + 300);
    } finally {
      TXS.splice(0, TXS.length, ...original);
    }
  });

  test('table by category: a column per month plus Total, with a totals row', async () => {
    const card = await run(report({ graph_type: 'TableGraph' }));
    expect(card).toMatchObject({ kind: 'table', format: 'money', columns: ['2026-09', '2026-10', '2026-11', 'Total'] });
    expect(card.rows[0]).toEqual({ label: 'Rent', values: [100000, 100000, 100000, 300000] });
    expect(card.totals).toEqual([100000, 103000, 106500, 309500]);
  });

  test('table by interval: deposits, payments and net per month', async () => {
    const card = await run(report({ graph_type: 'TableGraph', group_by: 'Interval' }));
    expect(card.columns).toEqual(['Deposits', 'Payments', 'Net']);
    expect(card.rows).toEqual([
      { label: '2026-09', values: [400000, 100000, 300000] },
      { label: '2026-10', values: [400000, 103000, 297000] },
      { label: '2026-11', values: [400000, 106500, 293500] },
    ]);
    expect(card.totals).toEqual([1200000, 309500, 890500]);
  });

  test('a table with more than 11 intervals keeps just the Total column', async () => {
    const card = await run(report({ graph_type: 'TableGraph', start: '2025-01', end: '2026-11' }));
    expect(card.kind).toBe('table');
    expect(card.columns).toEqual(['Total']);
    expect(card.rows[0].values).toHaveLength(1);
  });

  test('interval reports with one series stay series', async () => {
    expect((await run(report({ group_by: 'Interval', graph_type: 'StackedBarGraph' }))).kind).toBe('series');
  });
});

describe('sankey', () => {
  const { buildSankey, MAX_NODES, MAX_LINKS } = require('../src/mobile/v1/reports-sankey');
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  const flow = (income, groups) => {
    const g = groups.map((x) => ({ ...x, amountCents: x.categories.reduce((s, c) => s + c.amountCents, 0) }));
    return { incomeCents: income.reduce((s, i) => s + i.amountCents, 0), spendingCents: g.reduce((s, x) => s + x.amountCents, 0), income, groups: g };
  };
  const bigFlow = (groupsN, catsN) => flow(
    [{ id: 'i1', label: 'Pay', amountCents: 100000000 }],
    Array.from({ length: groupsN }, (_, g) => ({ id: `g${g}`, label: `G${g}`, categories: Array.from({ length: catsN }, (_, c) => ({ id: `g${g}c${c}`, label: `C${g}-${c}`, amountCents: 100 + c + g })) }))
  );

  test('columns: sources, Income, groups and Saved, categories; links all positive', async () => {
    const card = await one('markdown-card', { content: '{{INSIGHTS:spending-sankey:null}}' });
    expect(card.kind).toBe('sankey');
    const col = (label) => card.nodes.find((n) => n.label === label).column;
    expect(col('Paycheck')).toBe(0);
    expect(col('Income')).toBe(1);
    expect(col('Saved')).toBe(2);
    expect(col('Bills')).toBe(2);
    expect(col('Rent')).toBe(3);
    expect(card.links.every((l) => l.value > 0)).toBe(true);
    const id = (label) => card.nodes.find((n) => n.label === label).id;
    expect(card.links).toContainEqual({ source: id('Income'), target: id('Saved'), value: 293500 });
    expect(card.links).toContainEqual({ source: id('Bills'), target: id('Rent'), value: 100000 });
  });

  test('spending beyond income draws From savings; no income names the hub Spending; empty is an empty graph', () => {
    const over = buildSankey(flow([{ id: 'i', label: 'Pay', amountCents: 100 }], [{ id: 'g', label: 'G', categories: [{ id: 'c', label: 'C', amountCents: 250 }] }]));
    expect(over.nodes.map((n) => n.label)).toEqual(['Pay', 'From savings', 'Income', 'G', 'C']);
    expect(over.links.find((l) => l.value === 150)).toBeTruthy();
    const none = buildSankey(flow([], [{ id: 'g', label: 'G', categories: [{ id: 'c', label: 'C', amountCents: 50 }] }]));
    expect(none.nodes.map((n) => n.label)).toEqual(['From savings', 'Spending', 'G', 'C']);
    expect(buildSankey(flow([], []))).toEqual({ nodes: [], links: [] });
  });

  test('ids are safe and unique even for odd source ids', () => {
    const odd = buildSankey(flow([{ id: 'a b/c', label: 'P', amountCents: 10 }, { id: 'a_b_c', label: 'Q', amountCents: 10 }], [{ id: 'x'.repeat(100), label: 'G', categories: [{ id: null, label: 'C', amountCents: 5 }, { id: '', label: 'D', amountCents: 5 }] }]));
    const ids = odd.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => ID.test(i))).toBe(true);
    expect(odd.links.every((l) => ids.includes(l.source) && ids.includes(l.target))).toBe(true);
  });

  test('caps: 80 nodes and 300 links, the smallest fold into Other, nothing is lost', () => {
    const f = bigFlow(6, 30);
    const graph = buildSankey(f);
    expect(graph.nodes.length).toBeLessThanOrEqual(MAX_NODES);
    expect(graph.links.length).toBeLessThanOrEqual(MAX_LINKS);
    expect(graph.nodes.some((n) => n.label === 'Other')).toBe(true);
    for (const g of f.groups) {
      const groupNode = graph.nodes.find((n) => n.label === g.label);
      const out = graph.links.filter((l) => l.source === groupNode.id).reduce((s, l) => s + l.value, 0);
      expect(out).toBe(g.amountCents);
    }
    expect(JSON.stringify(buildSankey(f))).toBe(JSON.stringify(graph)); // deterministic
  });

  test('a graph that cannot fit even folded is unsupported', () => {
    expect(() => buildSankey(bigFlow(90, 1))).toThrow(/too many/);
  });

  test('the capped graph validates through the card pipeline', async () => {
    const { insightsBuilder } = require('../src/mobile/v1/reports-insights');
    expect(insightsBuilder('spending-sankey')).toBeTruthy();
    const body = { schema: 1, generatedAt: NOW.toISOString(), cards: [{ id: 's', title: 'S', kind: 'sankey', format: 'money', ...buildSankey(bigFlow(6, 30)) }] };
    expectValid(body);
  });
});

describe('timeline (subscription radar)', () => {
  const md = (config = 'null') => ({ content: `{{INSIGHTS:subscription-radar:${config}}}` });
  const schedules = [
    { id: 's1', completed: false, name: null, payee: 'p-diner', account: 'a-chk', amount: -1599, date: { frequency: 'monthly', start: '2026-11-15', interval: 1, patterns: [], skipWeekend: false, weekendSolveMode: 'after', endMode: 'never' }, rule: 'r1' },
    { id: 's2', completed: false, name: 'Cloud', payee: 'p-boss', account: 'a-chk', amount: -299, date: '2026-12-10', next_date: '2026-12-10', rule: 'r2' },
    { id: 's3', completed: false, name: 'Too late', payee: 'p-boss', account: 'a-chk', amount: -100, date: '2026-12-20', next_date: '2026-12-20' },
    { id: 's4', completed: true, name: 'Done', payee: 'p-boss', account: 'a-chk', amount: -100, date: '2026-11-20', next_date: '2026-11-20' },
  ];
  const rules = [{ id: 'r1', actions: [{ op: 'set', field: 'category', value: 'c-eat' }] }, { id: 'r2', actions: [{ op: 'set', field: 'category', value: 'c-rent' }] }];
  const cardFor = async (config, now = NOW) => {
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', md(config))] });
    client.getSchedules.mockResolvedValue(schedules);
    client.getRules.mockResolvedValue(rules);
    const body = await buildReports({ client, now });
    expectValid(body);
    return body.cards[0];
  };

  test('window is today to +30 days; items are renewals in it, money out negative', async () => {
    const card = await cardFor('null');
    expect(card).toMatchObject({ kind: 'timeline', layout: 'horizontal', start: '2026-11-12', end: '2026-12-12' });
    expect(card.items).toEqual([
      { date: '2026-11-15', title: 'Example Diner', subtitle: 'Fun', value: -1599 },
      { date: '2026-12-10', title: 'Example Employer', subtitle: 'Bills', value: -299 },
    ]);
  });

  test('layout comes from the config; unknown layouts are horizontal', async () => {
    expect((await cardFor('{"layout":"vertical"}')).layout).toBe('vertical');
    expect((await cardFor('{"layout":"diagonal"}')).layout).toBe('horizontal');
  });

  test('excludeCategoryIds drop renewals of those categories; uncategorised ones stay', async () => {
    const card = await cardFor('{"excludeCategoryIds":["c-eat"]}');
    expect(card.items.map((i) => i.title)).toEqual(['Example Employer']);
    const { excludeCategories, parseRadarConfig } = require('../src/mobile/v1/reports-insights');
    expect(excludeCategories([{ categoryId: null }, { categoryId: '' }, {}, { categoryId: 'x' }], ['x'])).toHaveLength(3);
    expect(parseRadarConfig(['x'])).toEqual({ layout: 'horizontal', excludeCategoryIds: [] });
    expect(parseRadarConfig({ excludeCategoryIds: ['a', 5, 'b'] }).excludeCategoryIds).toEqual(['a', 'b']);
  });

  test('matches the web path: the bills-timeline items of each month inside the window', async () => {
    const { loadScheduleData, buildOccurrences } = require('../src/bills-data');
    const client = makeClient();
    client.getSchedules.mockResolvedValue(schedules);
    client.getRules.mockResolvedValue(rules);
    const data = await loadScheduleData(client);
    const web = [
      ...buildOccurrences(data, new Date(2026, 10, 12), new Date(2026, 10, 30, 23, 59, 59, 999)),
      ...buildOccurrences(data, new Date(2026, 11, 1), new Date(2026, 11, 31, 23, 59, 59, 999)),
    ].filter((i) => i.date <= '2026-12-12');
    const card = await cardFor('null');
    expect(card.items.map((i) => [i.date, i.value])).toEqual(web.map((i) => [i.date, i.amountCents]));
  });

  test('bills-timeline stays a list', async () => {
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', { content: '{{INSIGHTS:bills-timeline:null}}' })] });
    client.getSchedules.mockResolvedValue(schedules);
    expect((await buildReports({ client, now: NOW })).cards[0].kind).toBe('list');
  });
});

describe('lists: paycheck alerts and unlinked transfers', () => {
  const NOW_OCT = new Date(2026, 9, 26, 10);
  const run = async (name, setup, now = NOW_OCT) => {
    const client = makeClient({ dashboard: [widget(U(1), 'markdown-card', { content: `{{INSIGHTS:${name}:null}}` })] });
    setup(client);
    const body = await buildReports({ client, now });
    expectValid(body);
    return body.cards[0];
  };
  const biweekly = { id: 'pay', completed: false, name: 'Payroll', payee: 'p-boss', amount: 250000, date: { frequency: 'weekly', interval: 2, start: '2020-01-03', endMode: 'never' } };

  test('paycheck alerts: one row per alert with the web wording, value the paycheck amount', async () => {
    const card = await run('paycheck-alerts', (c) => c.getSchedules.mockResolvedValue([biweekly]));
    expect(card.kind).toBe('list');
    expect(card.rows).toEqual([{ title: '3 Payroll paychecks this month', subtitle: '~2.2/month average', value: 250000 }]);
  });

  test('no alerts is a list with no rows', async () => {
    const card = await run('paycheck-alerts', (c) => c.getSchedules.mockResolvedValue([]));
    expect(card).toMatchObject({ kind: 'list', rows: [] });
  });

  test('unlinked transfers: one row per pair with both account names', async () => {
    const t = (id, account, date, amount) => ({ id, account, date, amount, transfer_id: null, tombstone: false });
    const card = await run('unlinked-transfers', (c) => c.getTransactions.mockImplementation(async (id) => (id === 'a-chk' ? [t('t1', 'a-chk', '2026-10-20', -5000)] : id === 'a-sav' ? [t('t2', 'a-sav', '2026-10-21', 5000)] : [])));
    expect(card.rows).toEqual([{ title: 'Checking to Savings', subtitle: '2026-10-20 and 2026-10-21', date: '2026-10-20', value: 5000 }]);
  });

  test('unlinked transfers: none found is an empty list; a hidden account never pairs', async () => {
    const { scopeClient } = require('../src/mobile/v1/hidden');
    const t = (id, account, date, amount) => ({ id, account, date, amount, transfer_id: null, tombstone: false });
    const base = makeClient({ dashboard: [widget(U(1), 'markdown-card', { content: '{{INSIGHTS:unlinked-transfers:null}}' })] });
    base.getTransactions.mockImplementation(async (id) => (id === 'a-chk' ? [t('t1', 'a-chk', '2026-10-20', -5000)] : id === 'a-sav' ? [t('t2', 'a-sav', '2026-10-21', 5000)] : []));
    const visible = await buildReports({ client: scopeClient(base, ['a-sav']), now: NOW_OCT });
    expectValid(visible);
    expect(visible.cards[0]).toMatchObject({ kind: 'list', rows: [] });
  });
});

describe('the contract example and card limits', () => {
  const { examples } = require('./helpers/native-v1');
  test('the reportsResponseCharts example validates through the shared helper', () => {
    const { expectValid: contractValid } = require('./helpers/native-v1');
    contractValid('reportsResponseCharts', examples.reportsResponseCharts);
  });

  test('an over-long multiseries is trimmed to 400 labels and equal-length series', async () => {
    const client = makeClient({ dashboard: [widget(U(1), 'custom-report', { id: 'rep-1' })], customReports: [{ id: 'rep-1', name: 'Daily', date_static: 1, start: '2025-01-01', end: '2026-11-12', group_by: 'Category', balance_type: 'Payment', graph_type: 'LineGraph', interval: 'Daily', conditions: [], show_offbudget: false, tombstone: false }] });
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0].labels.length).toBeLessThanOrEqual(400);
    for (const s of body.cards[0].series) expect(s.values).toHaveLength(body.cards[0].labels.length);
  });

  test('a chart card that throws is isolated and keeps its title', async () => {
    const dashboard = [widget(U(1), 'markdown-card', { name: 'Burn', content: '{{INSIGHTS:burn-rate:null}}' }, 0, 0), widget(U(2), 'markdown-card', { content: '## After' }, 0, 1)];
    const client = makeClient({ dashboard });
    client.getBudgetMonth.mockRejectedValue(new Error('secret'));
    const body = await buildReports({ client, now: NOW });
    expectValid(body);
    expect(body.cards[0]).toEqual({ id: U(1), kind: 'unsupported', title: 'Burn' });
    expect(body.cards[1].kind).toBe('text');
  });
});
