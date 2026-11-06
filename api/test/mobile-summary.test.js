const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');
const { q } = require('@actual-app/api');

jest.mock('../src/forecast/compute');
const { computeForecast } = require('../src/forecast/compute');

const { buildMobileSummary } = require('../src/mobile/summary');
const forecastSettings = require('../src/forecast/settings-store');
const { writeGoals } = require('../src/goals-store');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const schema = JSON.parse(fs.readFileSync(path.join(DOCS, 'mobile-summary.schema.json'), 'utf8'));
const example = JSON.parse(fs.readFileSync(path.join(DOCS, 'mobile-summary.example.json'), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

function expectValid(payload) {
  const ok = validate(payload);
  if (!ok) throw new Error(`payload does not match the schema: ${JSON.stringify(validate.errors)}`);
}

// 2026-11-12, Thursday, 10:00 local: day 12 of a 30-day month.
const NOW = new Date(2026, 10, 12, 10, 0, 0);
const ORIGINAL_TZ = process.env.TZ;

const GROUPS = [
  {
    id: 'g-bills',
    name: 'Bills',
    categories: [
      { id: 'c-rent', name: 'Rent', budgeted: 100000, spent: -100000, balance: 0 },
      { id: 'c-power', name: 'Power', budgeted: 10000, spent: -4000, balance: 6000 },
    ],
  },
  {
    id: 'g-fun',
    name: 'Fun',
    categories: [{ id: 'c-eat', name: 'Eating out', budgeted: 40000, spent: -10000, balance: 30000 }],
  },
  { id: 'g-income', name: 'Income', is_income: true, categories: [{ id: 'c-pay', name: 'Paycheck', budgeted: 0, spent: 0, balance: 0 }] },
  { id: 'g-xfer', name: 'Transfers', categories: [{ id: 'c-xfer', name: 'Savings transfer', budgeted: 50000, spent: -50000, balance: 0 }] },
];

const PAYEES = [
  { id: 'p-util', name: 'Example Utilities' },
  { id: 'p-boss', name: 'Example Employer' },
  { id: 'p-card', name: 'Example Card', transfer_acct: 'a-card' },
  { id: 'p-sav', name: 'Rainy Day Savings', transfer_acct: 'a-sav' },
  { id: 'p-gym', name: 'Example Gym' },
];

const oneTime = (id, date, amount, payee, extra = {}) => ({ id, name: id, payee, account: 'a-chk', amount, date, next_date: date, completed: false, rule: `r-${id}`, ...extra });

function makeClient(overrides = {}) {
  return {
    getBudgetMonth: jest.fn(async () => ({ categoryGroups: GROUPS })),
    getAccounts: jest.fn(async () => [
      { id: 'a-sav', name: 'Rainy Day Savings', offbudget: false, closed: false },
      { id: 'a-chk', name: 'Everyday Checking', offbudget: false, closed: false },
      { id: 'a-401k', name: 'Retirement', offbudget: true, closed: false },
      { id: 'a-old', name: 'Old account', offbudget: false, closed: true },
    ]),
    getAccountBalance: jest.fn(async (id) => ({ 'a-chk': 312450, 'a-sav': 1050000, 'a-401k': 9900000 })[id] ?? 0),
    getSchedules: jest.fn(async () => [
      oneTime('util', '2026-11-13', -8400, 'p-util'),
      oneTime('pay', '2026-11-14', 215000, 'p-boss'),
      oneTime('card', '2026-11-17', -54000, 'p-card'),
      oneTime('too-late', '2026-11-25', -99900, 'p-gym'),
      oneTime('xfer-in', '2026-11-15', 30000, 'p-sav'),
      oneTime('zero', '2026-11-16', 0, 'p-card'),
      oneTime('done', '2026-11-14', -1000, 'p-gym', { completed: true }),
    ]),
    getPayees: jest.fn(async () => PAYEES),
    getRules: jest.fn(async () => []),
    getCategoryGroups: jest.fn(async () => GROUPS),
    aqlQuery: jest.fn(async (query) => {
      if (query.state.table === 'preferences') return { data: [{ id: 'defaultCurrencyCode', value: 'EUR' }] };
      return { data: PAYEES };
    }),
    ...overrides,
  };
}

let dataDir;

beforeEach(() => {
  process.env.TZ = 'America/Denver';
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-summary-test-'));
  computeForecast.mockReset();
  // Sections that fail on purpose log one line each; keep the output clean.
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
});

afterEach(() => {
  console.error.mockRestore();
  jest.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

const build = (client = makeClient()) => buildMobileSummary({ client, now: NOW, dataDir });

describe('the published example', () => {
  test('validates against the published schema', () => {
    expectValid(example);
  });

  test('the schema rejects a payload that drifts from it', () => {
    expect(validate({ ...example, schema: 2 })).toBe(false);
    expect(validate({ ...example, extra: true })).toBe(false);
    expect(validate({ ...example, accounts: undefined })).toBe(false);
    expect(validate({ ...example, upcoming: [{ date: '2026-11-13', payee: 'x', amount: -5, kind: 'bill' }] })).toBe(false);
    expect(validate({ ...example, month: { ...example.month, pace: 'late' } })).toBe(false);
  });
});

describe('month', () => {
  test('sums spending categories only, with the same pace rule as the budget pacing widget', async () => {
    const { month } = await build();
    // Rent 100000 + Power 10000 + Eating out 40000 budgeted; income and Transfers groups are left out.
    expect(month).toEqual({ label: '2026-11', budgeted: 150000, spent: 114000, remaining: 36000, daysLeft: 18, pace: 'over' });
  });

  test('pace is "on" when spending tracks the calendar, "under" when behind it, "over" when over budget', async () => {
    const paced = (spent, balance) =>
      makeClient({ getBudgetMonth: jest.fn(async () => ({ categoryGroups: [{ id: 'g', name: 'Bills', categories: [{ id: 'c', name: 'C', budgeted: 100000, spent: -spent, balance }] }] })) });
    // 12 of 30 days gone = 40% of 100000 available = 40000 expected, 10% tolerance.
    expect((await build(paced(40000, 60000))).month.pace).toBe('on');
    expect((await build(paced(10000, 90000))).month.pace).toBe('under');
    expect((await build(paced(60000, 40000))).month.pace).toBe('over');
    expect((await build(paced(120000, -20000))).month.pace).toBe('over');
  });

  test('carryover counts as money available', async () => {
    const client = makeClient({ getBudgetMonth: jest.fn(async () => ({ categoryGroups: [{ id: 'g', name: 'Bills', categories: [{ id: 'c', name: 'C', budgeted: 10000, spent: -30000, balance: 70000 }] }] })) });
    // 30000 is three times the month's budgeted 10000, but with carryover
    // available = balance + spent = 100000: 40% of that (day 12 of 30) is 40000.
    const { month } = await build(client);
    expect(month.remaining).toBe(70000);
    expect(month.pace).toBe('under');
  });

  test('daysLeft is 0 on the last day of the month', async () => {
    const lastDay = new Date(2026, 10, 30, 9, 0, 0);
    jest.setSystemTime(lastDay);
    const payload = await buildMobileSummary({ client: makeClient(), now: lastDay, dataDir });
    expect(payload.month.daysLeft).toBe(0);
  });

  test('an empty budget is zeros, not an error', async () => {
    const payload = await build(makeClient({ getBudgetMonth: jest.fn(async () => ({ categoryGroups: [] })) }));
    expect(payload.month).toEqual({ label: '2026-11', budgeted: 0, spent: 0, remaining: 0, daysLeft: 18, pace: 'on' });
    expectValid(payload);
  });
});

describe('projection', () => {
  test('uses the month-end projection the existing route reports', async () => {
    const client = makeClient({
      getBudgetMonth: jest.fn(async () => ({ totalIncome: 400000, totalSpent: -114000, categoryGroups: GROUPS })),
      getPayees: jest.fn(async () => PAYEES),
    });
    const { projection } = await build(client);
    expect(projection).toEqual({ monthEndNet: expect.any(Number) });
    expect(Number.isInteger(projection.monthEndNet)).toBe(true);
  });
});

describe('accounts', () => {
  test('lists open accounts, on-budget first then off-budget, each by name, with the real onBudget flag', async () => {
    const { accounts } = await build();
    expect(accounts).toEqual([
      { id: 'a-chk', name: 'Everyday Checking', balance: 312450, onBudget: true },
      { id: 'a-sav', name: 'Rainy Day Savings', balance: 1050000, onBudget: true },
      { id: 'a-401k', name: 'Retirement', balance: 9900000, onBudget: false },
    ]);
  });

  test('the cap keeps on-budget accounts ahead of off-budget ones', async () => {
    const mixed = [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `off-${i}`, name: `A off ${i}`, offbudget: true, closed: false })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `on-${i}`, name: `Z on ${i}`, offbudget: false, closed: false })),
    ];
    const { accounts } = await build(makeClient({ getAccounts: jest.fn(async () => mixed) }));
    expect(accounts).toHaveLength(25);
    expect(accounts.filter((a) => a.onBudget)).toHaveLength(10);
    expect(accounts.slice(0, 10).every((a) => a.onBudget)).toBe(true);
  });

  test('no accounts is an empty list', async () => {
    const payload = await build(makeClient({ getAccounts: jest.fn(async () => []) }));
    expect(payload.accounts).toEqual([]);
    expectValid(payload);
  });

  test('an account whose balance cannot be read still appears, with a null balance', async () => {
    const client = makeClient({ getAccountBalance: jest.fn(async (id) => { if (id === 'a-sav') throw new Error('boom'); return 5; }) });
    const { accounts } = await build(client);
    expect(accounts.find((a) => a.id === 'a-sav').balance).toBeNull();
    expect(accounts.find((a) => a.id === 'a-chk').balance).toBe(5);
  });

  test('500 accounts are capped at 25 and the payload stays under 8 KB', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `account-${String(i).padStart(4, '0')}-${'x'.repeat(40)}`, name: `Account number ${i} ${'long name '.repeat(20)}`, offbudget: false, closed: false }));
    const client = makeClient({ getAccounts: jest.fn(async () => many), getAccountBalance: jest.fn(async () => 123456789) });
    const payload = await build(client);
    expect(payload.accounts).toHaveLength(25);
    expect(client.getAccountBalance).toHaveBeenCalledTimes(25);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(8 * 1024);
    expectValid(payload);
  });
});

describe('upcoming', () => {
  test('bills and paychecks in the next 7 days, soonest first, amounts positive', async () => {
    const { upcoming } = await build();
    expect(upcoming).toEqual([
      { date: '2026-11-13', payee: 'Example Utilities', amount: 8400, kind: 'bill' },
      { date: '2026-11-14', payee: 'Example Employer', amount: 215000, kind: 'paycheck' },
      { date: '2026-11-17', payee: 'Example Card', amount: 54000, kind: 'bill' },
    ]);
  });

  test('leaves out a transfer in, a zero amount, a completed schedule, and anything beyond 7 days', async () => {
    const { upcoming } = await build();
    const names = upcoming.map((u) => u.payee);
    expect(names).not.toContain('Rainy Day Savings');
    expect(names).not.toContain('Example Gym');
    expect(upcoming.every((u) => u.amount > 0)).toBe(true);
  });

  test('at most 10 items', async () => {
    const lots = Array.from({ length: 30 }, (_, i) => oneTime(`s${i}`, `2026-11-${String(13 + (i % 5)).padStart(2, '0')}`, -(1000 + i), 'p-util'));
    const { upcoming } = await build(makeClient({ getSchedules: jest.fn(async () => lots) }));
    expect(upcoming).toHaveLength(10);
  });

  test('no schedules is an empty list', async () => {
    const payload = await build(makeClient({ getSchedules: jest.fn(async () => []) }));
    expect(payload.upcoming).toEqual([]);
    expectValid(payload);
  });
});

describe('forecast', () => {
  const enable = (accounts) => forecastSettings.writeSettings({ ...forecastSettings.defaultSettings(), accounts }, dataDir);
  const result = (over) => ({ accountId: 'a-chk', accountName: 'Everyday Checking', warningLevelCents: 0, lowest: { date: '2026-11-16', balanceCents: 96200 }, breach: null, ...over });

  test('null when no account is switched on', async () => {
    const payload = await build();
    expect(payload.forecast).toBeNull();
    expect(computeForecast).not.toHaveBeenCalled();
  });

  test('ok with the lowest projected balance when nothing goes below its level', async () => {
    await enable({ 'a-chk': { enabled: true, warningLevelCents: 0 } });
    computeForecast.mockResolvedValue({ results: [result()], errors: [] });
    const payload = await build();
    expect(payload.forecast).toEqual({ status: 'ok', lowestBalance: 96200, lowestDate: '2026-11-16', accountName: 'Everyday Checking' });
    expectValid(payload);
  });

  test('low, naming the account furthest below its level', async () => {
    await enable({ 'a-chk': { enabled: true, warningLevelCents: 0 }, 'a-sav': { enabled: true, warningLevelCents: 0 } });
    computeForecast.mockResolvedValue({
      results: [
        result({ breach: { date: '2026-11-18', shortfallCents: 1000, balanceCents: -1000 }, lowest: { date: '2026-11-18', balanceCents: -1000 } }),
        result({ accountId: 'a-sav', accountName: 'Rainy Day Savings', breach: { date: '2026-11-20', shortfallCents: 5000, balanceCents: -5000 }, lowest: { date: '2026-11-20', balanceCents: -5000 } }),
      ],
      errors: [],
    });
    expect((await build()).forecast).toEqual({ status: 'low', lowestBalance: -5000, lowestDate: '2026-11-20', accountName: 'Rainy Day Savings' });
  });

  test('null when the forecast cannot be computed, and the rest of the payload still arrives', async () => {
    await enable({ 'a-chk': { enabled: true, warningLevelCents: 0 } });
    computeForecast.mockRejectedValue(new Error('boom'));
    const payload = await build();
    expect(payload.forecast).toBeNull();
    expect(payload.accounts).toHaveLength(3);
  });

  test('null when every watched account failed', async () => {
    await enable({ 'a-chk': { enabled: true, warningLevelCents: 0 } });
    computeForecast.mockResolvedValue({ results: [], errors: [{ accountId: 'a-chk', accountName: 'x', error: 'boom' }] });
    expect((await build()).forecast).toBeNull();
  });
});

describe('goals', () => {
  test('a goal on an account saves the balance; one on a category saves its carryover balance', async () => {
    await writeGoals(
      [
        { id: 'g1', entityType: 'account', entityId: 'a-sav', targetAmountCents: 2000000, targetDate: '2027-06-01' },
        { id: 'g2', entityType: 'category', entityId: 'c-eat', targetAmountCents: 100000, targetDate: '2027-01-01' },
      ],
      dataDir
    );
    const { goals } = await build();
    expect(goals).toEqual([
      { id: 'g1', name: 'Rainy Day Savings', saved: 1050000, target: 2000000 },
      { id: 'g2', name: 'Eating out', saved: 30000, target: 100000 },
    ]);
  });

  test('at most 5 goals; a goal whose account or category is gone is skipped', async () => {
    const stored = Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, entityType: 'account', entityId: 'a-chk', targetAmountCents: 1000, targetDate: '2027-01-01' }));
    stored.unshift({ id: 'gone', entityType: 'account', entityId: 'a-missing', targetAmountCents: 1000, targetDate: '2027-01-01' });
    await writeGoals(stored, dataDir);
    const { goals } = await build();
    expect(goals).toHaveLength(5);
    expect(goals.map((g) => g.id)).not.toContain('gone');
  });

  test('no goals is an empty list', async () => {
    expect((await build()).goals).toEqual([]);
  });
});

describe('currency', () => {
  test('uses the budget preference', async () => {
    expect((await build()).currency).toBe('EUR');
  });

  test('USD when the budget has none, or the lookup fails, or the value is not a currency code', async () => {
    const withValue = (value) => makeClient({ aqlQuery: jest.fn(async (query) => (query.state.table === 'preferences' ? { data: value } : { data: PAYEES })) });
    expect((await build(withValue([]))).currency).toBe('USD');
    expect((await build(withValue([{ id: 'defaultCurrencyCode', value: '' }]))).currency).toBe('USD');
    expect((await build(withValue([{ id: 'defaultCurrencyCode', value: 'euro!' }]))).currency).toBe('USD');
    const failing = makeClient({ aqlQuery: jest.fn(async (query) => { if (query.state.table === 'preferences') throw new Error('nope'); return { data: PAYEES }; }) });
    expect((await build(failing)).currency).toBe('USD');
  });
});

describe('resilience and shape', () => {
  test('a section that throws becomes null or [] and the others are unaffected', async () => {
    const payload = await build(
      makeClient({
        getBudgetMonth: jest.fn(async () => { throw new Error('budget unavailable'); }),
        getSchedules: jest.fn(async () => { throw new Error('schedules unavailable'); }),
      })
    );
    expect(payload.month).toBeNull();
    expect(payload.projection).toBeNull();
    expect(payload.upcoming).toEqual([]);
    expect(payload.goals).toEqual([]);
    expect(payload.accounts).toHaveLength(3);
    expectValid(payload);
  });

  test('everything unavailable still produces a valid payload', async () => {
    const boom = jest.fn(async () => { throw new Error('down'); });
    const payload = await build({ getBudgetMonth: boom, getAccounts: boom, getAccountBalance: boom, getSchedules: boom, getRules: boom, getCategoryGroups: boom, aqlQuery: boom, getPayees: boom });
    expect(payload).toEqual({ schema: 1, generatedAt: NOW.toISOString(), currency: 'USD', month: null, projection: null, accounts: [], upcoming: [], forecast: null, goals: [] });
    expectValid(payload);
  });

  test('the full payload validates and every amount is an integer', async () => {
    await writeGoals([{ id: 'g1', entityType: 'account', entityId: 'a-sav', targetAmountCents: 2000000, targetDate: '2027-06-01' }], dataDir);
    const payload = await build();
    expectValid(payload);
    expect(payload.schema).toBe(1);
    expect(payload.generatedAt).toBe(NOW.toISOString());
    const amounts = [payload.month.budgeted, payload.month.spent, payload.month.remaining, payload.projection && payload.projection.monthEndNet, ...payload.accounts.map((a) => a.balance), ...payload.upcoming.map((u) => u.amount), ...payload.goals.flatMap((g) => [g.saved, g.target])];
    expect(amounts.every((n) => Number.isInteger(n))).toBe(true);
  });

  test('never includes household identifiers beyond account and goal ids and names', async () => {
    const text = JSON.stringify(await build());
    expect(text).not.toMatch(/token|password|secret|serverUrl/i);
  });
});
