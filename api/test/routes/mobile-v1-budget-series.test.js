const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-series-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const store = require('../../src/mobile-tokens-store');
const seriesStore = require('../../src/mobile-budget-series-store');
const { applyAllSeries } = require('../../src/mobile/v1/budget-series');
const { startBudgetSeriesScheduler, nextDailyRun } = require('../../src/budget-series/scheduler');
const { expectValid, examples, makeFakeActual } = require('../helpers/native-v1');

const NOW = new Date(2026, 10, 12, 15, 0, 0); // local time: 12 Nov 2026
const AUDIT = path.join(DATA_DIR, 'mobile-audit.log');
const V1 = '/api/mobile/v1';
let client;

async function withServer(fn) {
  require('../../src/routes/mobile-v1').resetMobileV1State();
  require('../../src/routes/mobile-summary').resetMobileSummaryState();
  const app = require('../../src/server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
const call = (base, token, method, url, body) =>
  fetch(`${base}${V1}${url}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const newToken = async (scope = 'write') => (await store.createToken('phone', DATA_DIR, { scope })).token;
const auditLines = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const budgetOf = (month, id = 'c-groc') => (client.state.budget[month] || {})[id];
const sets = () => client.state.calls.filter((c) => c[0] === 'setBudgetAmount');
const SERIES_FILE = path.join(DATA_DIR, seriesStore.FILE_NAME);

beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
  fs.rmSync(SERIES_FILE, { force: true });
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
  client = makeFakeActual();
  getActualClient.mockReset();
  getActualClient.mockImplementation(async () => client);
  syncIfDue.mockReset();
  syncIfDue.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
});
afterEach(() => {
  console.error.mockRestore();
  jest.useRealTimers();
});

const create = (base, token, over = {}) => call(base, token, 'POST', '/budget-series', { categoryId: 'c-groc', amount: 50000, startMonth: '2026-11', mode: 'months', months: 3, ...over });

describe('series store', () => {
  it('tolerates a missing or corrupt file and drops bad entries', async () => {
    expect(await seriesStore.readSeries(DATA_DIR)).toEqual([]);
    fs.writeFileSync(SERIES_FILE, '{not json');
    expect(await seriesStore.readSeries(DATA_DIR)).toEqual([]);
    const good = { id: 'ser-a', categoryId: 'c-groc', categoryName: 'G', amount: 1, startMonth: '2026-11', mode: 'months', months: 2, untilMonth: null, appliedThrough: null };
    fs.writeFileSync(SERIES_FILE, JSON.stringify({ series: [good, { ...good, id: 'bad id' }, { ...good, id: 'ser-b', mode: 'until' }, 7] }));
    expect((await seriesStore.readSeries(DATA_DIR)).map((s) => s.id)).toEqual(['ser-a']);
  });
  it('caps at 200 and writes atomically', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ id: `ser-${i}`, categoryId: 'c', categoryName: '', amount: 1, startMonth: '2026-11', mode: 'indefinite', months: null, untilMonth: null, appliedThrough: null }));
    await seriesStore.writeSeries(many, DATA_DIR);
    expect((await seriesStore.readSeries(DATA_DIR)).length).toBe(200);
    expect(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('POST /budget-series', () => {
  it('writes exactly the covered months, answers per schema, audits without a token', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      const res = await create(base, token);
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('budgetSeriesResponse', body);
      expect(body.dryRun).toBe(false);
      expect(body.changes).toEqual([
        { month: '2026-11', before: 45000, after: 50000 },
        { month: '2026-12', before: 45000, after: 50000 },
        { month: '2027-01', before: 45000, after: 50000 },
      ]);
      expect(body.series).toMatchObject({ categoryId: 'c-groc', categoryName: 'Groceries', mode: 'months', months: 3, untilMonth: null, endMonth: '2027-01', appliedThrough: '2027-01' });
      expect(body.series.id).toMatch(/^ser-/);
    });
    expect(sets().map((c) => c[1])).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(client.state.calls.filter((c) => c[0] === 'batch').length).toBe(1);
    expect(client.state.syncs).toBe(1);
    expect(budgetOf('2027-02')).toBeUndefined();
    const lines = auditLines().filter((l) => l.op === 'budget.series.create');
    expect(lines.length).toBe(1);
    expect(lines[0].after.written).toMatchObject({ months: 3, first: '2026-11', last: '2027-01', totalBefore: 135000, totalAfter: 150000 });
    expect(fs.readFileSync(AUDIT, 'utf8')).not.toContain(token);
    expect(JSON.stringify(await seriesStore.readSeries(DATA_DIR))).not.toContain(token);
  });

  it('until mode and indefinite mode cover the right months', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      let body = await (await create(base, token, { mode: 'until', untilMonth: '2027-02', months: undefined })).json();
      expectValid('budgetSeriesResponse', body);
      expect(body.changes.map((c) => c.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
      body = await (await create(base, token, { categoryId: 'c-fuel', mode: 'indefinite', months: undefined, startMonth: '2026-12' })).json();
      expectValid('budgetSeriesResponse', body);
      expect(body.changes.length).toBe(12); // 2026-12 .. 2027-11
      expect(body.series).toMatchObject({ endMonth: null, appliedThrough: '2027-11', months: null, untilMonth: null });
    });
  });

  it('dry run changes nothing, needs only read scope, matches the real result', async () => {
    const readToken = await newToken('read');
    await withServer(async (base) => {
      const res = await create(base, readToken, { dryRun: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('budgetSeriesPreviewResponse', body);
      expect(body.changes.length).toBe(3);
      expect(await (await call(base, readToken, 'GET', '/budget-series')).json()).toMatchObject({ series: [] });
      const real = await (await create(base, await newToken())).json();
      expect(real.changes).toEqual(body.changes.map((c) => ({ ...c })));
    });
    const dry = makeFakeActual();
    expect(dry.state.calls).toEqual([]);
  });

  it('dry run alone writes no budget, no series, no audit, no sync', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      expect((await create(base, token, { dryRun: true })).status).toBe(200);
    });
    expect(client.state.calls).toEqual([]);
    expect(client.state.syncs).toBe(0);
    expect(fs.existsSync(SERIES_FILE)).toBe(false);
    expect(auditLines()).toEqual([]);
  });

  it('read scope cannot write (403) even with a bad body', async () => {
    const token = await newToken('read');
    await withServer(async (base) => {
      expect((await create(base, token)).status).toBe(403);
      expect((await create(base, token, { dryRun: false })).status).toBe(403);
      expect((await call(base, token, 'DELETE', '/budget-series/ser-x')).status).toBe(403);
      expect((await call(base, token, 'PUT', '/budget-series/ser-x', { amount: 1, startMonth: '2026-11', mode: 'indefinite' })).status).toBe(403);
      expect((await call(base, undefined, 'GET', '/budget-series')).status).toBe(401);
    });
    expect(client.state.calls).toEqual([]);
  });

  it('409 on a second series for the same category', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      expect((await create(base, token)).status).toBe(200);
      const res = await create(base, token, { amount: 1 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'conflict' });
      expect((await create(base, token, { dryRun: true })).status).toBe(409);
    });
    expect(budgetOf('2026-11')).toBe(50000);
  });

  const bad = [
    ['extra key', { extra: 1 }],
    ['negative amount', { amount: -1 }],
    ['float amount', { amount: 1.5 }],
    ['string amount', { amount: '5' }],
    ['huge amount', { amount: 1000000000001 }],
    ['bad month', { startMonth: '2026-13' }],
    ['past start', { startMonth: '2026-10' }],
    ['start beyond 5 years', { startMonth: '2031-12' }],
    ['unknown mode', { mode: 'forever' }],
    ['months missing', { months: undefined }],
    ['months zero', { months: 0 }],
    ['months 121', { months: 121 }],
    ['months with until', { untilMonth: '2027-01' }],
    ['until without untilMonth', { mode: 'until', months: undefined }],
    ['until with months', { mode: 'until', untilMonth: '2027-01' }],
    ['until before start', { mode: 'until', months: undefined, startMonth: '2026-12', untilMonth: '2026-11' }],
    ['until span over 120', { mode: 'until', months: undefined, untilMonth: '2036-12' }],
    ['indefinite with months', { mode: 'indefinite' }],
    ['indefinite with until', { mode: 'indefinite', months: undefined, untilMonth: '2027-01' }],
    ['dryRun not boolean', { dryRun: 'yes' }],
    ['unknown category', { categoryId: 'c-nope' }],
    ['hidden category', { categoryId: 'c-hid' }],
    ['category in hidden group', { categoryId: 'c-gone' }],
    ['income category', { categoryId: 'c-pay' }],
    ['bad category id', { categoryId: 'a b' }],
    ['null months', { months: null }],
  ];
  it.each(bad)('rejects %s with 400 and never echoes input', async (_name, over) => {
    const token = await newToken();
    await withServer(async (base) => {
      const res = await create(base, token, { ...over, categoryId: over.categoryId ?? 'c-groc' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    });
    expect(client.state.calls).toEqual([]);
    expect(fs.existsSync(SERIES_FILE)).toBe(false);
  });

  it('rejects non-objects and bad JSON', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      for (const b of ['[]', 'null', '{"x', '"s"']) expect((await call(base, token, 'POST', '/budget-series', b)).status).toBe(400);
    });
  });

  it('start in the current month is allowed, 5 years ahead is allowed', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      expect((await create(base, token, { startMonth: '2031-11', months: 1, dryRun: true })).status).toBe(200);
    });
  });
});

describe('GET, PUT and DELETE', () => {
  it('lists series per schema (and an empty list)', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      let body = await (await call(base, token, 'GET', '/budget-series')).json();
      expectValid('budgetSeriesListResponse', body);
      expect(body.series).toEqual([]);
      await create(base, token);
      body = await (await call(base, token, 'GET', '/budget-series')).json();
      expectValid('budgetSeriesListResponse', body);
      expect(body.series.length).toBe(1);
    });
  });

  it('PUT rewrites from the current month only, never earlier months', async () => {
    const token = await newToken();
    // A series that started in the past (stored directly) with written past months.
    await seriesStore.writeSeries([{ id: 'ser-old', categoryId: 'c-groc', categoryName: 'Groceries', amount: 40000, startMonth: '2026-08', mode: 'months', months: 6, untilMonth: null, appliedThrough: '2027-01' }], DATA_DIR);
    for (const m of ['2026-08', '2026-09', '2026-10']) client.state.budget[m] = { 'c-groc': 40000 };
    await withServer(async (base) => {
      const res = await call(base, token, 'PUT', '/budget-series/ser-old', { amount: 60000, startMonth: '2026-08', mode: 'months', months: 6 });
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('budgetSeriesResponse', body);
      expect(body.changes.map((c) => c.month)).toEqual(['2026-11', '2026-12', '2027-01']);
      expect(body.series.amount).toBe(60000);
    });
    for (const m of ['2026-08', '2026-09', '2026-10']) expect(budgetOf(m)).toBe(40000);
    expect(sets().map((c) => c[1])).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(auditLines().filter((l) => l.op === 'budget.series.update').length).toBe(1);
  });

  it('PUT supports dryRun and 404 for an unknown id; PUT cannot change the category', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      await create(base, token);
      const id = (await (await call(base, token, 'GET', '/budget-series')).json()).series[0].id;
      client.state.calls.length = 0;
      const dry = await call(base, token, 'PUT', `/budget-series/${id}`, { amount: 1, startMonth: '2026-11', mode: 'until', untilMonth: '2027-03', dryRun: true });
      const body = await dry.json();
      expectValid('budgetSeriesPreviewResponse', body);
      expect(body.changes.length).toBe(5);
      expect(client.state.calls).toEqual([]);
      expect((await call(base, token, 'PUT', '/budget-series/ser-nope', { amount: 1, startMonth: '2026-11', mode: 'indefinite' })).status).toBe(404);
      expect((await call(base, token, 'PUT', `/budget-series/${id}`, { categoryId: 'c-fuel', amount: 1, startMonth: '2026-11', mode: 'indefinite' })).status).toBe(400);
      expect((await call(base, token, 'PUT', '/budget-series/a%20b', { amount: 1, startMonth: '2026-11', mode: 'indefinite' })).status).toBe(400);
    });
  });

  it('DELETE stops the series and leaves written months', async () => {
    const token = await newToken();
    await withServer(async (base) => {
      await create(base, token);
      const id = (await (await call(base, token, 'GET', '/budget-series')).json()).series[0].id;
      const res = await call(base, token, 'DELETE', `/budget-series/${id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('okResponse', body);
      expect((await call(base, token, 'DELETE', `/budget-series/${id}`)).status).toBe(404);
      expect((await (await call(base, token, 'GET', '/budget-series')).json()).series).toEqual([]);
    });
    for (const m of ['2026-11', '2026-12', '2027-01']) expect(budgetOf(m)).toBe(50000);
    expect(auditLines().map((l) => l.op)).toEqual(['budget.series.create', 'budget.series.delete']);
  });

  it('a failed series file write after the budget write is a 500 for POST', async () => {
    const token = await newToken();
    const spy = jest.spyOn(seriesStore, 'writeSeries').mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'EIO' }));
    await withServer(async (base) => {
      const res = await create(base, token);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal' });
    });
    spy.mockRestore();
  });
});

describe('scheduler', () => {
  const indefinite = (over = {}) => ({ id: 'ser-ind', categoryId: 'c-groc', categoryName: 'Groceries', amount: 70000, startMonth: '2026-11', mode: 'indefinite', months: null, untilMonth: null, appliedThrough: '2027-06', ...over });
  const getClient = async () => client;

  it('extends an indefinite series only after appliedThrough up to current + 12, never overwriting', async () => {
    await seriesStore.writeSeries([indefinite()], DATA_DIR);
    client.state.budget['2027-03'] = { 'c-groc': 12345 }; // a manual edit inside the already-written range
    const written = await applyAllSeries({ getClient, now: NOW });
    expect(written).toBe(5); // 2027-07 .. 2027-11
    expect(sets().map((c) => c[1])).toEqual(['2027-07', '2027-08', '2027-09', '2027-10', '2027-11']);
    expect(budgetOf('2027-03')).toBe(12345);
    expect((await seriesStore.readSeries(DATA_DIR))[0].appliedThrough).toBe('2027-11');
    // A second pass the same day does nothing.
    client.state.calls.length = 0;
    expect(await applyAllSeries({ getClient, now: NOW })).toBe(0);
    expect(client.state.calls).toEqual([]);
    // Next month it extends by one.
    expect(await applyAllSeries({ getClient, now: new Date(2026, 11, 1) })).toBe(1);
    expect(sets().map((c) => c[1])).toEqual(['2027-12']);
    const apply = auditLines().filter((l) => l.op === 'budget.series.apply');
    expect(apply.length).toBe(2);
    expect(apply[0].tokenId).toBe('scheduler');
  });

  it('finishes unwritten months of a bounded series, from the current month on only', async () => {
    await seriesStore.writeSeries([{ ...indefinite({ mode: 'months', months: 8, appliedThrough: '2026-12', startMonth: '2026-09' }) }], DATA_DIR);
    await applyAllSeries({ getClient, now: NOW });
    expect(sets().map((c) => c[1])).toEqual(['2027-01', '2027-02', '2027-03', '2027-04']);
    expect((await seriesStore.readSeries(DATA_DIR))[0].appliedThrough).toBe('2027-04');
  });

  it('idempotent after a simulated partial failure (series file not saved)', async () => {
    await seriesStore.writeSeries([indefinite({ appliedThrough: '2027-08' })], DATA_DIR);
    const spy = jest.spyOn(seriesStore, 'writeSeries').mockRejectedValueOnce(new Error('disk'));
    expect(await applyAllSeries({ getClient, now: NOW })).toBe(0); // failure is logged, not thrown
    expect((await seriesStore.readSeries(DATA_DIR))[0].appliedThrough).toBe('2027-08');
    const afterFailure = JSON.stringify(client.state.budget);
    spy.mockRestore();
    expect(await applyAllSeries({ getClient, now: NOW })).toBe(3);
    expect(sets().filter((c) => c[1] === '2027-09').length).toBe(2); // rewritten with the same value
    expect(JSON.stringify(client.state.budget)).toBe(afterFailure);
    expect((await seriesStore.readSeries(DATA_DIR))[0].appliedThrough).toBe('2027-11');
    expect(await applyAllSeries({ getClient, now: NOW })).toBe(0);
  });

  it('a failing series does not block the others and is retried next pass', async () => {
    await seriesStore.writeSeries([indefinite({ id: 'ser-bad', categoryId: 'c-gone' }), indefinite({ id: 'ser-ok', categoryId: 'c-fuel' })], DATA_DIR);
    await applyAllSeries({ getClient, now: NOW });
    const list = await seriesStore.readSeries(DATA_DIR);
    expect(list.find((s) => s.id === 'ser-ok').appliedThrough).toBe('2027-11');
    expect(list.find((s) => s.id === 'ser-bad').appliedThrough).toBe('2027-06');
    expect(console.error).toHaveBeenCalled();
  });

  it('a budget write failure leaves appliedThrough unchanged', async () => {
    await seriesStore.writeSeries([indefinite()], DATA_DIR);
    client.batchBudgetUpdates.mockRejectedValueOnce(new Error('boom'));
    await applyAllSeries({ getClient, now: NOW });
    expect((await seriesStore.readSeries(DATA_DIR))[0].appliedThrough).toBe('2027-06');
    expect(await applyAllSeries({ getClient, now: NOW })).toBe(5);
  });

  it('startBudgetSeriesScheduler runs once shortly after start and can be stopped', async () => {
    const runImpl = jest.fn(async () => {});
    const stop = startBudgetSeriesScheduler({ runImpl, firstRunDelayMs: 5, now: () => NOW });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(runImpl).toHaveBeenCalledTimes(1);
    expect(nextDailyRun(NOW)).toEqual(new Date(2026, 10, 13, 3, 30));
    expect(nextDailyRun(new Date(2026, 10, 12, 2, 0))).toEqual(new Date(2026, 10, 12, 3, 30));
  });

  it('series create uses examples-compatible shapes', () => {
    expectValid('budgetSeriesListResponse', examples.budgetSeriesListResponse);
  });
});
