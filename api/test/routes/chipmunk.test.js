const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chipmunk-web-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/chipmunk/entitlement', () => ({ chipmunkEntitled: jest.fn(), entitlementMode: jest.fn(() => 'strict') }));
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
  chipmunkEntitled.mockResolvedValue({ entitled: true, reason: 'verified', lastVerifiedAt: '2026-11-09T21:00:00.000Z', validUntil: '2026-12-16T21:00:00.000Z' });
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
  it('is no longer the always-true stub: strict and not entitled until a proof arrived', async () => {
    const real = jest.requireActual('../../src/chipmunk/entitlement');
    expect(await real.chipmunkEntitled()).toEqual({ entitled: false, reason: 'none', lastVerifiedAt: null, validUntil: null });
    expect(real.entitlementMode()).toBe('strict');
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
      expect(await (await get(base, '/api/chipmunk-mode')).json()).toEqual({ enabled: false, entitled: true, reason: 'verified', lastVerifiedAt: '2026-11-09T21:00:00.000Z', validUntil: '2026-12-16T21:00:00.000Z', mode: 'strict' });
      const { entitlementMode } = require('../../src/chipmunk/entitlement');
      entitlementMode.mockReturnValue('dev');
      expect((await (await get(base, '/api/chipmunk-mode')).json()).mode).toBe('dev');
      entitlementMode.mockReturnValue('strict');
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

describe('/api/chipmunk writes (web)', () => {
  const flagStore = require('../../src/mobile-transaction-flags-store');
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const updates = () => client.state.calls.filter((c) => c[0] === 'updateTransaction');
  const auditLines = () => fs.readFileSync(path.join(DATA_DIR, 'mobile-audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  describe('PATCH /transactions (bulk)', () => {
    it('categorizes several rows in one pass: one sync, one audit line each, writer web', async () => {
      await withServer(async (base) => {
        const res = await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: ['t-02', 't-03', 't-01'], changes: { category: 'c-groc' } });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ schema: 1, updated: ['t-02', 't-03'], unchanged: ['t-01'], skipped: [] });
        expect(updates().map((c) => [c[1], c[2]])).toEqual([['t-02', { category: 'c-groc' }], ['t-03', { category: 'c-groc' }]]);
        expect(client.state.syncs).toBe(1);
        const lines = auditLines();
        expect(lines).toHaveLength(2);
        expect(lines.every((l) => l.tokenId === 'web' && l.op === 'transaction.update')).toBe(true);
        expect(lines[0]).toMatchObject({ ids: { transaction: 't-02' }, before: { category: null }, after: { category: 'c-groc' } });
      });
    });

    it('skips rows the change is not allowed on (transfer, split parent, closed account) and reports them', async () => {
      await withServer(async (base) => {
        const res = await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: ['t-02', 't-04', 't-05', 't-08'], changes: { category: 'c-fuel' } });
        const out = await res.json();
        expect(out.updated).toEqual(['t-02']);
        expect(out.skipped.map((s) => s.id).sort()).toEqual(['t-04', 't-05', 't-08']);
        expect(updates()).toHaveLength(1);
      });
    });

    it('a reconciled row keeps its cleared flag (skipped); others are marked cleared', async () => {
      await withServer(async (base) => {
        const res = await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: ['t-02', 't-03', 't-11'], changes: { cleared: false } });
        // t-02/t-03 already uncleared, t-11 reconciled and cleared -> locked
        expect(await res.json()).toMatchObject({ updated: [], unchanged: ['t-02', 't-03'], skipped: [{ id: 't-11' }] });
        const res2 = await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: ['t-02', 't-03'], changes: { cleared: true } });
        expect((await res2.json()).updated).toEqual(['t-02', 't-03']);
        expect(client.state.syncs).toBe(1);
      });
    });

    it('hide / exclude are flags only: no Actual write, no sync, hidden implies excluded', async () => {
      await withServer(async (base) => {
        const res = await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: ['t-02', 't-03'], changes: { hidden: true } });
        expect((await res.json()).updated).toEqual(['t-02', 't-03']);
        expect(updates()).toHaveLength(0);
        expect(client.state.syncs).toBe(0);
        expect(await flagStore.getFlags('t-02')).toEqual({ excluded: true, hidden: true });
        const ex = await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: ['t-01'], changes: { excluded: true } });
        expect((await ex.json()).updated).toEqual(['t-01']);
        expect(await flagStore.getFlags('t-01')).toEqual({ excluded: true, hidden: false });
      });
    });

    it('an unknown id is a 404 and nothing is written', async () => {
      await withServer(async (base) => {
        const res = await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: ['t-02', 'nope-1'], changes: { category: 'c-groc' } });
        expect(res.status).toBe(404);
        expect(updates()).toHaveLength(0);
      });
    });

    it('strict validation and the batch limit', async () => {
      await withServer(async (base) => {
        const bad = [
          {},
          { ids: [], changes: { cleared: true } },
          { ids: ['t-01'], changes: {} },
          { ids: ['t-01'], changes: { amount: 5 } },
          { ids: ['t-01'], changes: { cleared: 'yes' } },
          { ids: ['t-01'], changes: { category: 'bad id' } },
          { ids: ['t-01', 't-01'], changes: { cleared: true } },
          { ids: ['t-01'], changes: { cleared: true }, extra: 1 },
          { ids: 't-01', changes: { cleared: true } },
          { ids: Array.from({ length: 51 }, (_, i) => `t-${i}`), changes: { cleared: true } },
          { ids: ['t-01'], changes: { notes: 'x'.repeat(501) } },
        ];
        for (const b of bad) expect([JSON.stringify(b).slice(0, 40), (await send(base, 'PATCH', '/api/chipmunk/transactions', b)).status]).toEqual([JSON.stringify(b).slice(0, 40), 400]);
        const fifty = Array.from({ length: 50 }, (_, i) => `t-x${i}`);
        expect((await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: fifty, changes: { cleared: true } })).status).toBe(404); // valid shape, unknown ids
      });
    });

    it('needs the session and entitlement', async () => {
      await withServer(async (base) => {
        expect((await fetch(`${base}/api/chipmunk/transactions`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
        chipmunkEntitled.mockResolvedValue({ entitled: false, reason: 'none' });
        expect((await send(base, 'PATCH', '/api/chipmunk/transactions', { ids: ['t-01'], changes: { cleared: true } })).status).toBe(403);
      });
    });
  });

  describe('budget amount writes', () => {
    it('sets one category amount, audited as web', async () => {
      await withServer(async (base) => {
        const res = await send(base, 'PUT', `/api/chipmunk/budget/${month}/categories/c-groc`, { budgeted: 51000 });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.categories[0]).toMatchObject({ id: 'c-groc', budgeted: 51000 });
        expect(client.state.calls).toContainEqual(['setBudgetAmount', month, 'c-groc', 51000]);
        expect(client.state.syncs).toBe(1);
        expect(auditLines().at(-1)).toMatchObject({ tokenId: 'web', op: 'budget.set', after: { budgeted: 51000 } });
      });
    });

    it('moves money between categories, never below zero', async () => {
      await withServer(async (base) => {
        const ok = await send(base, 'POST', `/api/chipmunk/budget/${month}/move`, { from: 'c-groc', to: 'c-fuel', amount: 1000 });
        expect(ok.status).toBe(200);
        expect(client.state.calls).toContainEqual(['setBudgetAmount', month, 'c-fuel', 19000]);
        expect((await send(base, 'POST', `/api/chipmunk/budget/${month}/move`, { from: 'c-fuel', to: 'c-groc', amount: 99999999 })).status).toBe(400);
        expect(auditLines().at(-1)).toMatchObject({ tokenId: 'web', op: 'budget.move' });
      });
    });

    it('rejects bad input', async () => {
      await withServer(async (base) => {
        const p = (u, b) => send(base, 'PUT', u, b).then((r) => r.status);
        expect(await p(`/api/chipmunk/budget/${month}/categories/c-groc`, { budgeted: -1 })).toBe(400);
        expect(await p(`/api/chipmunk/budget/${month}/categories/c-groc`, { budgeted: 1.5 })).toBe(400);
        expect(await p(`/api/chipmunk/budget/${month}/categories/c-groc`, { budgeted: 5, extra: 1 })).toBe(400);
        expect(await p(`/api/chipmunk/budget/2026-13/categories/c-groc`, { budgeted: 5 })).toBe(400);
        expect(await p(`/api/chipmunk/budget/${month}/categories/c-hid`, { budgeted: 5 })).toBe(400);
        expect(await p(`/api/chipmunk/budget/${month}/categories/c-nope`, { budgeted: 5 })).toBe(404);
        const mv = (b) => send(base, 'POST', `/api/chipmunk/budget/${month}/move`, b).then((r) => r.status);
        expect(await mv({ from: 'c-groc', to: 'c-groc', amount: 1 })).toBe(400);
        expect(await mv({ from: 'c-groc', to: 'c-fuel', amount: 0 })).toBe(400);
        expect(await mv({ from: 'c-groc', to: 'c-fuel' })).toBe(400);
        expect(client.state.calls.filter((c) => c[0] === 'setBudgetAmount')).toHaveLength(0);
      });
    });
  });
});
