const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');

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
  if (s.table === 'custom_reports') return stub.customReports;
  if (s.table !== 'transactions') throw new Error(`stub AQL: ${s.table}`);
  const rows = TXS.filter((r) => s.filterExpressions.every((f) => matches(r, f)));
  if (s.limit === 1) {
    return [...rows].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 1).map((r) => ({ date: r.date }));
  }
  const col = s.groupExpressions[0];
  const groups = new Map();
  for (const r of rows) {
    const k = r[col];
    const g = groups.get(k) || { key: k, amount: 0, count: 0 };
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
      else out[name] = g.key;
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
    expect((await run(report({ graph_type: 'StackedBarGraph' }))).chart).toBe('bars');
    expect('chart' in (await run(report({ graph_type: 'TableGraph' })))).toBe(false);
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
    expect((await one('markdown-card', md('account-balances'))).chart).toBe('bars');
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
  test('cash-flow-card: income minus spending per month, last 6 months', async () => {
    const card = await one('cash-flow-card', null);
    expect(card.kind).toBe('series');
    expect(card.chart).toBe('bar');
    expect(card.points.map((p) => p.label)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(card.points.map((p) => p.value)).toEqual([0, 0, 0, 300000, 297000, 400000 - 100000 - 4000 - 2500]);
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
    expect(card.items).toEqual([{ label: 'Rent', value: 100000 }, { label: 'Eating out', value: 4000 }, { label: 'Power', value: 2500 }]);
  });

  test('spending-card average: mean of the last three months', async () => {
    const card = await one('spending-card', { mode: 'average' });
    expect(card.items[0]).toEqual({ label: 'Rent', value: 66667 });
    expect(card.total).toBe(Math.round(card.items.reduce((s, i) => s + i.value, 0)));
  });

  test('spending-card budget: spent from the budget month', async () => {
    const card = await one('spending-card', { mode: 'budget' });
    expect(card.items.map((i) => i.label)).toEqual(['Rent', 'Eating out', 'Power']);
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
    expect(card.items[0]).toEqual({ label: 'Rent', value: 100000 });
  });

  test('groupBy Group, Payee and Account', async () => {
    const group = await run(report({ date_range: 'This month', group_by: 'Group' }));
    expect(group.items).toEqual([{ label: 'Bills', value: 102500 }, { label: 'Fun', value: 4000 }]);
    const payee = await run(report({ date_range: 'Last month', group_by: 'Payee' }));
    expect(payee.items.map((i) => i.label).sort()).toEqual(['Example Diner', 'Uncategorized']);
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
    expect(narrowed.items).toEqual([{ label: 'Eating out', value: 4000 }]);
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
      { label: 'Rent', current: 100000, target: 100000, drill: { level: 'payees', categoryId: 'c-rent' } },
      { label: 'Eating out', current: 4000, target: 20000, drill: { level: 'payees', categoryId: 'c-eat' } },
    ]);
  });

  test('pacing-bars rollup items in the legacy array become one drillable row', async () => {
    const card = await one('markdown-card', md('pacing-bars', '[{"title":"House","budgets":["c-rent","c-power","c-gone"]},"c-eat"]'));
    expect(card.items).toEqual([
      { label: 'House', current: 102500, target: 110000, drill: { level: 'categories', categoryIds: ['c-rent', 'c-power'] } },
      { label: 'Eating out', current: 4000, target: 20000, drill: { level: 'payees', categoryId: 'c-eat' } },
    ]);
  });

  test('pacing-bars allGroups: one row per visible expense group, then picked ids; income and hidden left out', async () => {
    const card = await one('markdown-card', md('pacing-bars', '{"categoryIds":["c-eat"],"allGroups":true}'));
    expect(card.items).toEqual([
      { label: 'Bills', current: 102500, target: 110000, drill: { level: 'categories', categoryIds: ['c-rent', 'c-power'] } },
      { label: 'Fun', current: 4000, target: 20000, drill: { level: 'categories', categoryIds: ['c-eat'] } },
      { label: 'Eating out', current: 4000, target: 20000, drill: { level: 'payees', categoryId: 'c-eat' } },
    ]);
    const only = await one('markdown-card', md('pacing-bars', '{"categoryIds":[],"allGroups":true}'));
    expect(only.items.map((i) => i.label)).toEqual(['Bills', 'Fun']);
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

  test('burn rate and savings rate to stat', async () => {
    const burn = await one('markdown-card', md('burn-rate'));
    expect(burn).toMatchObject({ kind: 'stat', value: 106500, format: 'money', compare: { value: 130000, label: 'Budgeted' } });
    const rate = await one('markdown-card', md('savings-rate-gauge', '[]'));
    expect(rate).toMatchObject({ kind: 'stat', format: 'percent', value: 73.4 });
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

  test('spending-heatmap to calendar; account-balances and donut to breakdown', async () => {
    const heat = await one('markdown-card', md('spending-heatmap', '{}'));
    expect(heat.kind).toBe('calendar');
    expect(heat.days).toHaveLength(30);
    expect(heat.days.find((d) => d.date === '2026-11-05').value).toBe(4000);
    const donut = await one('markdown-card', md('spending-breakdown-donut', '[]'));
    expect(donut).toMatchObject({ kind: 'breakdown', total: 106500 });
    const balances = await one('markdown-card', md('account-balances', '[]'));
    expect(balances.kind).toBe('breakdown');
    expect(balances.total).toBe(123456 + 5000 + 5000);
  });

  test('an Insights widget with no mobile form is unsupported', async () => {
    expect(await one('markdown-card', { name: 'Sankey', ...md('spending-sankey') })).toEqual({ id: U(1), kind: 'unsupported', title: 'Sankey' });
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
    expect(body.cards.map((c) => c.kind)).toEqual(['stat', 'series', 'series', 'breakdown', 'calendar', 'text', 'progress', 'unsupported']);
  });
});
