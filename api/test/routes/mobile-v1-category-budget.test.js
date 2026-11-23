const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-catbudget-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/chipmunk/entitlement', () => ({ chipmunkEntitled: jest.fn(), entitlementMode: jest.fn(() => 'strict') }));
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const { chipmunkEntitled } = require('../../src/chipmunk/entitlement');
const store = require('../../src/mobile-tokens-store');
const flagsStore = require('../../src/mobile-transaction-flags-store');
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
const carryCalls = () => client.state.calls.filter((c) => c[0] === 'setBudgetCarryover');
const RESET = '/budget/2026-11/categories/c-fuel/rollover-reset';

beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
  fs.rmSync(path.join(DATA_DIR, flagsStore.FILE_NAME || 'x'), { force: true });
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
  chipmunkEntitled.mockReset();
  chipmunkEntitled.mockResolvedValue({ entitled: true, reason: 'verified' });
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

describe('GET /budget/category/:id/history', () => {
  it('matches the contract example shape and returns oldest-first completed months only', async () => {
    expectValid('categoryHistoryResponse', examples.categoryHistoryResponse);
    const token = await newToken('read');
    client.state.monthData = {
      '2026-08': { 'c-groc': { budgeted: 50000, spent: -47210 } },
      '2026-09': { 'c-groc': { budgeted: 50000, spent: -53100 } },
      '2026-10': { 'c-groc': { budgeted: 50000, spent: -48875 } },
      '2026-11': { 'c-groc': { budgeted: 1, spent: -1 } },
    };
    await withServer(async (base) => {
      const res = await call(base, token, 'GET', '/budget/category/c-groc/history?months=3');
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('categoryHistoryResponse', body);
      expect(body).toEqual(examples.categoryHistoryResponse);
      expect(client.getBudgetMonth).toHaveBeenCalledTimes(3);
      expect(client.getBudgetMonth.mock.calls.map((c) => c[0])).toEqual(['2026-08', '2026-09', '2026-10']);
    });
  });

  it('defaults to 6 months, accepts 1 and 12, rejects 0, 13, junk and extra params', async () => {
    const token = await newToken('read');
    await withServer(async (base) => {
      let body = await (await call(base, token, 'GET', '/budget/category/c-groc/history')).json();
      expect(body.months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
      body = await (await call(base, token, 'GET', '/budget/category/c-groc/history?months=1')).json();
      expect(body.months.map((m) => m.month)).toEqual(['2026-10']);
      body = await (await call(base, token, 'GET', '/budget/category/c-groc/history?months=12')).json();
      expect(body.months.length).toBe(12);
      expect(body.months[11].month).toBe('2026-10');
      for (const q of ['months=0', 'months=13', 'months=abc', 'months=2.5', 'months=-1', 'months=', 'months=03', 'months=3&x=1', 'x=1']) {
        const res = await call(base, token, 'GET', `/budget/category/c-groc/history?${q}`);
        expect([q, res.status]).toEqual([q, 400]);
        expect(await res.json()).toEqual({ error: 'bad_request' });
      }
      expect((await call(base, token, 'GET', '/budget/category/bad%20id/history')).status).toBe(400);
    });
  });

  it('gives fewer entries for a young budget and never reads a month Actual lacks', async () => {
    const token = await newToken('read');
    client.state.months = ['2026-09', '2026-10', '2026-11', '2026-12'];
    const realGet = client.getBudgetMonth.getMockImplementation();
    client.getBudgetMonth.mockImplementation(async (m) => {
      if (!client.state.months.includes(m)) throw new Error('No budget exists for month: ' + m);
      return realGet(m);
    });
    await withServer(async (base) => {
      const body = await (await call(base, token, 'GET', '/budget/category/c-groc/history?months=12')).json();
      expectValid('categoryHistoryResponse', body);
      expect(body.months.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    });
    client.state.months = ['2026-11'];
    await withServer(async (base) => {
      const body = await (await call(base, token, 'GET', '/budget/category/c-groc/history')).json();
      expect(body).toEqual({ schema: 1, categoryId: 'c-groc', months: [] });
    });
  });

  it('uses the same numbers as the Budget screen, exclusions included', async () => {
    const token = await newToken('read');
    client.state.transactions.push({ id: 't-ex', date: '2026-10-05', account: 'a-chk', payee: 'p-grocer', category: 'c-groc', amount: -4000, notes: null, cleared: true });
    await flagsStore.setFlags('t-ex', { excluded: true, hidden: false });
    client.state.monthData = { '2026-10': { 'c-groc': { budgeted: 50000, spent: -48000, balance: 2000 } } };
    await withServer(async (base) => {
      const screen = await (await call(base, token, 'GET', '/budget/2026-10')).json();
      const line = screen.groups.flatMap((g) => g.categories).find((c) => c.id === 'c-groc');
      const body = await (await call(base, token, 'GET', '/budget/category/c-groc/history?months=1')).json();
      expect(body.months).toEqual([{ month: '2026-10', budgeted: line.budgeted, spent: line.spent }]);
      expect(line.spent).toBe(-44000);
    });
  });

  it('404s for unknown, hidden and income categories; caches per id and months', async () => {
    const token = await newToken('read');
    await withServer(async (base) => {
      for (const id of ['c-nope', 'c-hid', 'c-gone', 'c-pay']) {
        const res = await call(base, token, 'GET', `/budget/category/${id}/history`);
        expect([id, res.status]).toEqual([id, 404]);
        expect(await res.json()).toEqual({ error: 'not_found' });
      }
      const a = await (await call(base, token, 'GET', '/budget/category/c-groc/history?months=2')).json();
      const b = await (await call(base, token, 'GET', '/budget/category/c-groc/history?months=3')).json();
      const c = await (await call(base, token, 'GET', '/budget/category/c-fuel/history?months=2')).json();
      expect([a.months.length, b.months.length, c.categoryId]).toEqual([2, 3, 'c-fuel']);
      const before = client.getBudgetMonth.mock.calls.length;
      await call(base, token, 'GET', '/budget/category/c-groc/history?months=2');
      expect(client.getBudgetMonth.mock.calls.length).toBe(before);
    });
  });

  it('needs a token and counts against the read rate limit', async () => {
    const token = await newToken('read');
    await withServer(async (base) => {
      expect((await call(base, null, 'GET', '/budget/category/c-groc/history')).status).toBe(401);
      for (let i = 0; i < 60; i++) expect((await call(base, token, 'GET', '/budget/category/c-groc/history')).status).toBe(200);
      expect((await call(base, token, 'GET', '/budget/category/c-groc/history')).status).toBe(429);
    });
  });
});

describe('POST /budget/:month/categories/:id/rollover-reset', () => {
  // c-fuel carries over (flag on in every month); 2026-10 balance 12500 carries into November.
  const setup = () => {
    client.state.monthData = { '2026-10': { 'c-fuel': { balance: 12500 } } };
  };

  it('switches off ONLY the previous month, reports the balance, syncs, audits, clears the cache', async () => {
    setup();
    const token = await newToken('write');
    await withServer(async (base) => {
      const before = await (await call(base, token, 'GET', '/budget/2026-11')).json();
      expect(before.groups[0].categories.find((c) => c.id === 'c-fuel').carryover).toBe(true);
      const res = await call(base, token, 'POST', RESET, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('rolloverResetResponse', body);
      expect(body).toEqual({ schema: 1, ok: true, month: '2026-11', carriedOver: 12500 });
      expect(carryCalls()).toEqual([['setBudgetCarryover', '2026-10', 'c-fuel', false]]);
      expect(client.state.syncs).toBe(1);
      const lines = auditLines();
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatchObject({ op: 'budget.rollover.reset', ids: { category: 'c-fuel' }, before: { carriedOver: 12500 } });
      expect(lines[0].tokenId).toBeTruthy();
      expect(fs.readFileSync(AUDIT, 'utf8')).not.toContain(token);
      // cache cleared: the Budget screen reflects the new state at once; November's own flag is untouched
      const mk = (m) => client.getBudgetMonth(m).then((b) => b.categoryGroups.flatMap((g) => g.categories).find((c) => c.id === 'c-fuel').carryover);
      expect(await mk('2026-10')).toBe(false);
      expect(await mk('2026-11')).toBe(true);
      expect(await mk('2026-12')).toBe(true);
      // second reset is now a no-op
      const again = await (await call(base, token, 'POST', RESET, {})).json();
      expect(again.carriedOver).toBe(0);
      expect(carryCalls().length).toBe(1);
      expect(client.state.syncs).toBe(1);
      expect(auditLines().length).toBe(1);
    });
  });

  it('is a 200/0 no-op (no write, sync or audit) when nothing carries in', async () => {
    setup();
    const token = await newToken('write');
    const expectNoop = async (base, url = RESET) => {
      const res = await call(base, token, 'POST', url, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('rolloverResetResponse', body);
      expect(body.carriedOver).toBe(0);
      expect(carryCalls()).toEqual([]);
      expect(client.state.syncs).toBe(0);
      expect(auditLines()).toEqual([]);
    };
    await withServer(async (base) => {
      // previous month's flag already off
      client.state.carryoverByMonth = { '2026-10': { 'c-fuel': false } };
      await expectNoop(base);
      // not a rollover category this month (c-groc has no flag)
      client.state.carryoverByMonth = {};
      await expectNoop(base, '/budget/2026-11/categories/c-groc/rollover-reset');
      // this month's flag off
      client.state.carryoverByMonth = { '2026-11': { 'c-fuel': false } };
      await expectNoop(base);
      // nothing to carry (balance 0)
      client.state.carryoverByMonth = {};
      client.state.monthData = { '2026-10': { 'c-fuel': { balance: 0 } } };
      await expectNoop(base);
      // previous month is before the budget's start
      client.state.monthData = { '2026-10': { 'c-fuel': { balance: 12500 } } };
      client.state.months = ['2026-11', '2026-12'];
      await expectNoop(base);
    });
  });

  it('reports a negative carried balance as is', async () => {
    client.state.monthData = { '2026-10': { 'c-fuel': { balance: -3000 } } };
    const token = await newToken('write');
    await withServer(async (base) => {
      expect((await (await call(base, token, 'POST', RESET, {})).json()).carriedOver).toBe(-3000);
    });
  });

  it('400s a non-current month, a bad body, an income or hidden category; 404s unknown; 403 for a read token', async () => {
    setup();
    const token = await newToken('write');
    const read = await newToken('read');
    await withServer(async (base) => {
      for (const url of ['/budget/2026-10/categories/c-fuel/rollover-reset', '/budget/2026-12/categories/c-fuel/rollover-reset', '/budget/2026-13/categories/c-fuel/rollover-reset', '/budget/2026-11/categories/c-pay/rollover-reset', '/budget/2026-11/categories/c-hid/rollover-reset', '/budget/2026-11/categories/c-gone/rollover-reset']) {
        const res = await call(base, token, 'POST', url, {});
        expect([url, res.status]).toEqual([url, 400]);
        expect(await res.json()).toEqual({ error: 'bad_request' });
      }
      for (const body of [{ x: 1 }, [], '[]', 'null', '"x"', '{not json']) {
        const res = await call(base, token, 'POST', RESET, body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      }
      const unknown = await call(base, token, 'POST', '/budget/2026-11/categories/c-nope/rollover-reset', {});
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: 'not_found' });
      const denied = await call(base, read, 'POST', RESET, {});
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'read_only' });
      expect((await call(base, null, 'POST', RESET, {})).status).toBe(401);
      expect(carryCalls()).toEqual([]);
      expect(auditLines()).toEqual([]);
    });
  });

  it('runs inside the shared write mutex', async () => {
    setup();
    const token = await newToken('write');
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    client.setBudgetAmount.mockImplementationOnce(async () => { order.push('amount:start'); await gate; order.push('amount:end'); });
    client.setBudgetCarryover.mockImplementationOnce(async (...a) => { order.push('carry'); client.state.calls.push(['setBudgetCarryover', ...a]); });
    await withServer(async (base) => {
      const first = call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 100 });
      await new Promise((r) => setTimeout(r, 50));
      const second = call(base, token, 'POST', RESET, {});
      await new Promise((r) => setTimeout(r, 50));
      expect(order).toEqual(['amount:start']);
      release();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(order).toEqual(['amount:start', 'amount:end', 'carry']);
    });
  });

  it('counts against the write rate limit', async () => {
    const token = await newToken('write');
    await withServer(async (base) => {
      for (let i = 0; i < 20; i++) expect((await call(base, token, 'POST', RESET, {})).status).toBe(200);
      expect((await call(base, token, 'POST', RESET, {})).status).toBe(429);
    });
  });

  it('still answers when the sync fails (the write is already saved)', async () => {
    setup();
    client.sync.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ECONN' }));
    const token = await newToken('write');
    await withServer(async (base) => {
      const res = await call(base, token, 'POST', RESET, {});
      expect(res.status).toBe(200);
      expect(carryCalls().length).toBe(1);
    });
  });
});

describe('web shell routes', () => {
  const AUTH = { 'X-ACTUAL-TOKEN': 'valid' };
  const web = (base, method, url, body) =>
    fetch(`${base}/api/chipmunk${url}`, { method, headers: { ...AUTH, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  beforeEach(() => validateToken.mockImplementation(async (t) => t === 'valid'));

  it('serves the history and validates like the phone', async () => {
    await withServer(async (base) => {
      const res = await web(base, 'GET', '/budget/category/c-groc/history?months=2');
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('categoryHistoryResponse', body);
      expect(body.months.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
      expect((await web(base, 'GET', '/budget/category/c-groc/history?months=13')).status).toBe(400);
      expect((await web(base, 'GET', '/budget/category/c-groc/history?z=1')).status).toBe(400);
      expect((await web(base, 'GET', '/budget/category/c-pay/history')).status).toBe(404);
      expect((await fetch(`${base}/api/chipmunk/budget/category/c-groc/history`)).status).toBe(401);
    });
  });

  it('resets the rollover, audited as web', async () => {
    client.state.monthData = { '2026-10': { 'c-fuel': { balance: 7700 } } };
    await withServer(async (base) => {
      const res = await web(base, 'POST', RESET, {});
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('rolloverResetResponse', body);
      expect(body.carriedOver).toBe(7700);
      expect(carryCalls()).toEqual([['setBudgetCarryover', '2026-10', 'c-fuel', false]]);
      expect(auditLines().map((l) => [l.op, l.tokenId])).toEqual([['budget.rollover.reset', 'web']]);
      expect((await web(base, 'POST', '/budget/2026-10/categories/c-fuel/rollover-reset', {})).status).toBe(400);
      expect((await web(base, 'POST', RESET, { a: 1 })).status).toBe(400);
      expect((await web(base, 'POST', '/budget/2026-11/categories/c-pay/rollover-reset', {})).status).toBe(400);
      expect((await web(base, 'POST', '/budget/2026-11/categories/c-nope/rollover-reset', {})).status).toBe(404);
    });
  });

  it('is entitlement gated', async () => {
    chipmunkEntitled.mockResolvedValue({ entitled: false, reason: 'none' });
    await withServer(async (base) => {
      expect((await web(base, 'GET', '/budget/category/c-groc/history')).status).toBe(403);
      expect((await web(base, 'POST', RESET, {})).status).toBe(403);
    });
    expect(carryCalls()).toEqual([]);
  });
});
