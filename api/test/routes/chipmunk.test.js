const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chipmunk-web-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/chipmunk/entitlement', () => ({ chipmunkEntitled: jest.fn() }));
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const { chipmunkEntitled } = require('../../src/chipmunk/entitlement');
const { buildReports, buildReportList } = require('../../src/mobile/v1/reports');
const settings = require('../../src/chipmunk/settings-store');
const seriesStore = require('../../src/mobile-budget-series-store');
const { expectValid, examples, makeFakeActual } = require('../helpers/native-v1');

const AUTH = { 'X-ACTUAL-TOKEN': 'valid' };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };
let client;

async function withServer(fn) {
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
const get = (base, url, headers = AUTH) => fetch(`${base}${url}`, { headers });
const send = (base, method, url, body) => fetch(`${base}${url}`, { method, headers: JSON_AUTH, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  for (const f of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, f), { force: true });
  validateToken.mockReset();
  validateToken.mockImplementation(async (t) => t === 'valid');
  chipmunkEntitled.mockReset();
  chipmunkEntitled.mockResolvedValue({ entitled: true, reason: 'unlicensed-dev', lastVerifiedAt: null });
  client = makeFakeActual();
  getActualClient.mockReset();
  getActualClient.mockImplementation(async () => client);
  syncIfDue.mockReset();
  syncIfDue.mockResolvedValue(undefined);
  buildReports.mockReset();
  buildReports.mockImplementation(async () => JSON.parse(JSON.stringify(examples.reportsResponse)));
  buildReportList.mockReset();
  buildReportList.mockImplementation(async () => JSON.parse(JSON.stringify(examples.reportListResponse)));
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

describe('entitlement (real module)', () => {
  it('is entitled as unlicensed-dev for now', async () => {
    const real = jest.requireActual('../../src/chipmunk/entitlement');
    expect(await real.chipmunkEntitled()).toEqual({ entitled: true, reason: 'unlicensed-dev', lastVerifiedAt: null });
  });
});

describe('settings store', () => {
  it('defaults to off, round-trips, and ignores junk', async () => {
    expect(await settings.readSettings(DATA_DIR)).toEqual({ enabled: false });
    await settings.writeSettings({ enabled: true }, DATA_DIR);
    expect(await settings.readSettings(DATA_DIR)).toEqual({ enabled: true });
    fs.writeFileSync(path.join(DATA_DIR, 'chipmunk-mode.json'), JSON.stringify({ enabled: 'yes' }));
    expect(await settings.readSettings(DATA_DIR)).toEqual({ enabled: false });
    expect(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('/api/chipmunk-mode', () => {
  it('requires the Actual session', async () => {
    await withServer(async (base) => {
      expect((await get(base, '/api/chipmunk-mode', {})).status).toBe(401);
      expect((await get(base, '/api/chipmunk/accounts', {})).status).toBe(401);
    });
  });

  it('is off by default, can be switched on and off, and reports entitlement', async () => {
    await withServer(async (base) => {
      expect(await (await get(base, '/api/chipmunk-mode')).json()).toEqual({ enabled: false, entitled: true, reason: 'unlicensed-dev', lastVerifiedAt: null });
      const on = await send(base, 'PUT', '/api/chipmunk-mode', { enabled: true });
      expect(on.status).toBe(200);
      expect((await on.json()).enabled).toBe(true);
      expect((await (await get(base, '/api/chipmunk-mode')).json()).enabled).toBe(true);
      expect((await (await send(base, 'PUT', '/api/chipmunk-mode', { enabled: false })).json()).enabled).toBe(false);
    });
  });

  it('rejects a bad body', async () => {
    await withServer(async (base) => {
      for (const body of [{}, { enabled: 'true' }, [], { enabled: 1 }]) {
        expect((await send(base, 'PUT', '/api/chipmunk-mode', body)).status).toBe(400);
      }
    });
  });

  it('refuses to turn on when not entitled, and reports enabled=false even if stored on', async () => {
    chipmunkEntitled.mockResolvedValue({ entitled: false, reason: 'expired', lastVerifiedAt: null });
    await withServer(async (base) => {
      expect((await send(base, 'PUT', '/api/chipmunk-mode', { enabled: true })).status).toBe(403);
      await settings.writeSettings({ enabled: true }, DATA_DIR);
      expect(await (await get(base, '/api/chipmunk-mode')).json()).toMatchObject({ enabled: false, entitled: false, reason: 'expired' });
      expect((await send(base, 'PUT', '/api/chipmunk-mode', { enabled: false })).status).toBe(200);
      expect((await get(base, '/api/chipmunk/accounts')).status).toBe(403);
      expect((await get(base, '/api/chipmunk/budget-series')).status).toBe(403);
    });
  });
});

describe('/api/chipmunk data routes', () => {
  it('serves the same shapes as the phone builders', async () => {
    await withServer(async (base) => {
      const accounts = await (await get(base, '/api/chipmunk/accounts')).json();
      expectValid('accountsResponse', accounts);
      const tx = await (await get(base, '/api/chipmunk/transactions?limit=5')).json();
      expectValid('transactionsResponse', tx);
      const sug = await (await get(base, '/api/chipmunk/transactions/suggest?q=g')).json();
      expectValid('transactionSuggestResponse', sug);
      expect(await (await get(base, '/api/chipmunk/report-list')).json()).toEqual(examples.reportListResponse);
      expect(await (await get(base, '/api/chipmunk/reports?report=page-main')).json()).toEqual(examples.reportsResponse);
      expect(buildReports.mock.calls[0][0].reportId).toBe('page-main');
      const budget = await (await get(base, '/api/chipmunk/budget/2026-11')).json();
      expectValid('budgetMonthResponse', budget);
      expect(syncIfDue).toHaveBeenCalled();
    });
  });

  it('validates query parameters like the phone API', async () => {
    await withServer(async (base) => {
      for (const url of [
        '/api/chipmunk/accounts?x=1',
        '/api/chipmunk/transactions?limit=0',
        '/api/chipmunk/transactions?limit=9999',
        '/api/chipmunk/transactions?account=bad%20id',
        '/api/chipmunk/transactions?uncategorized=1&group=g1',
        '/api/chipmunk/transactions?uncategorized=2',
        '/api/chipmunk/transactions?q=',
        '/api/chipmunk/transactions?payees=a,b%20c',
        '/api/chipmunk/transactions?cursor=nope',
        '/api/chipmunk/transactions/suggest?limit=99',
        '/api/chipmunk/reports?month=2999-01',
        '/api/chipmunk/reports?report=bad%20id',
        '/api/chipmunk/budget/2026-13',
      ]) {
        expect([url, (await get(base, url)).status]).toEqual([url, 400]);
      }
    });
  });

  it('maps a builder not-found to 404', async () => {
    const { HttpError } = require('../../src/mobile/v1/common');
    buildReports.mockRejectedValue(new HttpError(404, 'not_found'));
    await withServer(async (base) => {
      expect((await get(base, '/api/chipmunk/reports?report=nope')).status).toBe(404);
    });
  });
});

describe('/api/chipmunk budget series (web)', () => {
  const body = { categoryId: 'c-groc', amount: 50000, startMonth: '2026-11', mode: 'months', months: 3 };
  const now = new Date();
  const startMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  it('dry run changes nothing, create writes and lists, delete removes', async () => {
    await withServer(async (base) => {
      const payload = { ...body, startMonth };
      const dry = await send(base, 'POST', '/api/chipmunk/budget-series', { ...payload, dryRun: true });
      expect(dry.status).toBe(200);
      const dryBody = await dry.json();
      expect(dryBody.dryRun).toBe(true);
      expect(dryBody.changes).toHaveLength(3);
      expect(client.state.calls.filter((c) => c[0] === 'setBudgetAmount')).toHaveLength(0);
      expect(await (await get(base, '/api/chipmunk/budget-series')).json()).toMatchObject({ series: [] });

      const created = await send(base, 'POST', '/api/chipmunk/budget-series', payload);
      expect(created.status).toBe(200);
      const made = await created.json();
      expect(made.dryRun).toBe(false);
      expect(client.state.calls.filter((c) => c[0] === 'setBudgetAmount')).toHaveLength(3);
      expect((await send(base, 'POST', '/api/chipmunk/budget-series', payload)).status).toBe(409);

      const list = await (await get(base, '/api/chipmunk/budget-series')).json();
      expect(list.series.map((s) => s.id)).toEqual([made.series.id]);
      const audit = fs.readFileSync(path.join(DATA_DIR, 'mobile-audit.log'), 'utf8');
      expect(audit).toContain('"tokenId":"web"');

      const put = await send(base, 'PUT', `/api/chipmunk/budget-series/${made.series.id}`, { amount: 60000, startMonth, mode: 'indefinite', dryRun: true });
      expect(put.status).toBe(200);
      expect((await send(base, 'DELETE', `/api/chipmunk/budget-series/${made.series.id}`)).status).toBe(200);
      expect((await send(base, 'DELETE', `/api/chipmunk/budget-series/${made.series.id}`)).status).toBe(404);
      expect(await seriesStore.readSeries(DATA_DIR)).toEqual([]);
    });
  });

  it('rejects bad bodies and ids', async () => {
    await withServer(async (base) => {
      expect((await send(base, 'POST', '/api/chipmunk/budget-series', { amount: 1 })).status).toBe(400);
      expect((await send(base, 'PUT', '/api/chipmunk/budget-series/bad%20id', {})).status).toBe(400);
      expect((await send(base, 'DELETE', '/api/chipmunk/budget-series/bad%20id')).status).toBe(400);
    });
  });
});
