const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-hidden-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { q } = require('@actual-app/api');
const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const tokens = require('../../src/mobile-tokens-store');
const store = require('../../src/mobile-hidden-accounts-store');
const { scopeClient } = require('../../src/mobile/v1/hidden');
const { buildSpending } = require('../../src/mobile/v1/spending');
const { loadMonthCashFlow } = require('../../src/cash-flow-data');
const { expectValid, makeFakeActual } = require('../helpers/native-v1');

const SESSION = 'valid-session';
const FILE = path.join(DATA_DIR, store.FILE_NAME);
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
const v1 = (base, token, method, url, body) =>
  fetch(`${base}/api/mobile/v1${url}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
const admin = (base, method, body, headers = { 'X-ACTUAL-TOKEN': SESSION }) =>
  fetch(`${base}/api/mobile/hidden-accounts`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  validateToken.mockReset();
  validateToken.mockImplementation(async (t) => t === SESSION);
  client = makeFakeActual();
  getActualClient.mockReset();
  getActualClient.mockImplementation(async () => client);
  syncIfDue.mockReset();
  syncIfDue.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => console.error.mockRestore());

describe('the store', () => {
  test('missing or corrupt files hide nothing; ids are validated, unique and capped', async () => {
    expect(await store.readHiddenIds()).toEqual([]);
    for (const junk of ['{nope', 'null', '[]', '{"hiddenIds":"a-sav"}', '{"hiddenIds":[5,null,"bad id","","a".repeat(65)]}']) {
      fs.writeFileSync(FILE, junk.replace('"a".repeat(65)', JSON.stringify('a'.repeat(65))));
      expect(await store.readHiddenIds()).toEqual([]);
    }
    fs.writeFileSync(FILE, JSON.stringify({ hiddenIds: ['a-sav', 'a-sav', 'x y', 'a-old'] }));
    expect(await store.readHiddenIds()).toEqual(['a-sav', 'a-old']);
    const many = Array.from({ length: 300 }, (_, i) => `acc-${i}`);
    expect(await store.writeHiddenIds(many)).toHaveLength(200);
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8')).hiddenIds).toHaveLength(200);
    expect(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.statSync(FILE).mode & 0o077).toBe(0);
  });
});

describe('the admin endpoints', () => {
  test('need an Actual session; a device token (any scope) gets 401', async () => {
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'write' });
    await withServer(async (base) => {
      for (const headers of [{}, { 'X-ACTUAL-TOKEN': 'wrong' }, { Authorization: `Bearer ${token}` }, { 'X-ACTUAL-TOKEN': token }]) {
        for (const method of ['GET', 'PUT']) {
          expect((await admin(base, method, method === 'PUT' ? { hiddenIds: [] } : undefined, headers)).status).toBe(401);
        }
      }
      expect(fs.existsSync(FILE)).toBe(false);
    });
  });

  test('GET lists every account (closed and off-budget too) sorted by name; PUT replaces the list and drops unknown ids', async () => {
    await withServer(async (base) => {
      const first = await (await admin(base, 'GET')).json();
      expect(first.accounts.map((a) => a.name)).toEqual(['Everyday Checking', 'Old account', 'Rainy Day Savings', 'Retirement']);
      expect(first.accounts.find((a) => a.id === 'a-old')).toEqual({ id: 'a-old', name: 'Old account', closed: true, offBudget: false, hidden: false });
      expect(first.accounts.find((a) => a.id === 'a-ret').offBudget).toBe(true);

      const res = await admin(base, 'PUT', { hiddenIds: ['a-sav', 'a-nope', 'a-old'] });
      expect(res.status).toBe(200);
      expect((await res.json()).accounts.filter((a) => a.hidden).map((a) => a.id).sort()).toEqual(['a-old', 'a-sav']);
      expect(await store.readHiddenIds()).toEqual(['a-sav', 'a-old']);
      await admin(base, 'PUT', { hiddenIds: [] });
      expect(await store.readHiddenIds()).toEqual([]);
    });
  });

  test('PUT is strict', async () => {
    await withServer(async (base) => {
      for (const body of [{}, { hiddenIds: 'a-sav' }, { hiddenIds: [5] }, { hiddenIds: [], extra: 1 }, [], 'null', { hiddenIds: Array.from({ length: 201 }, (_, i) => `a${i}`) }]) {
        expect([JSON.stringify(body).slice(0, 40), (await admin(base, 'PUT', body)).status]).toEqual([JSON.stringify(body).slice(0, 40), 400]);
      }
      expect(fs.existsSync(FILE)).toBe(false);
    });
  });
});

describe('the native API with a hidden account', () => {
  const HIDDEN = 'a-sav';
  const hide = (ids = [HIDDEN]) => store.writeHiddenIds(ids);

  test('accounts and transactions: the hidden account never appears in any v1 response', async () => {
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'write' });
    await hide();
    await withServer(async (base) => {
      const bodies = [];
      for (const url of ['/me', '/accounts', '/transactions', '/transactions?uncategorized=1', '/transactions?group=g-usual', '/transactions?category=c-groc', '/transactions?account=a-chk', '/categories']) {
        const res = await v1(base, token, 'GET', url);
        expect([url, res.status]).toEqual([url, 200]);
        bodies.push(await res.text());
      }
      const all = bodies.join('\n');
      expect(all).not.toContain('a-sav');
      expect(all).not.toContain('Rainy Day Savings');
      expect(JSON.parse(bodies[1]).accounts.map((a) => a.id)).toEqual(['a-chk', 'a-ret']);
      expect(JSON.parse(bodies[2]).transactions.find((t) => t.id === 't-04x').payee).toBe('Transfer: Other account');
    });
  });

  test('uncategorizedCount excludes the hidden account', async () => {
    const { token } = await tokens.createToken('phone', DATA_DIR);
    await withServer(async (base) => {
      const before = (await (await v1(base, token, 'GET', '/transactions?uncategorized=1')).json()).uncategorizedCount;
      await hide(['a-chk']);
      require('../../src/routes/mobile-v1').clearMobileV1Cache();
      const after = (await (await v1(base, token, 'GET', '/transactions?uncategorized=1')).json()).uncategorizedCount;
      expect(before).toBeGreaterThan(0);
      expect(after).toBeLessThan(before);
    });
  });

  test('an explicit account filter naming a hidden account is 404, as are its transactions and every write', async () => {
    const { token } = await tokens.createToken('phone', DATA_DIR, { scope: 'write' });
    await hide();
    await withServer(async (base) => {
      const line = (category, amount) => ({ category, amount, notes: null });
      const cases = [
        ['GET', `/transactions?account=${HIDDEN}`],
        ['GET', '/transactions/t-09'],
        ['PATCH', '/transactions/t-09', { category: 'c-groc' }],
        ['PUT', '/transactions/t-09/splits', { splits: [line('c-groc', -100), line('c-fuel', -200)] }],
        ['DELETE', '/transactions/t-09/splits'],
      ];
      for (const [method, url, body] of cases) {
        const res = await v1(base, token, method, url, body);
        expect([method, url, res.status, await res.text()]).toEqual([method, url, 404, '{"error":"not_found"}']);
      }
      expect(client.updateTransaction).not.toHaveBeenCalled();
      expect(client.state.transactions.find((t) => t.id === 't-09').category).toBeNull();
      // A visible account's transaction still works.
      expect((await v1(base, token, 'PATCH', '/transactions/t-02', { category: 'c-groc' })).status).toBe(200);
    });
  });

  test('unhiding brings everything back at once (caches are cleared by the admin PUT)', async () => {
    const { token } = await tokens.createToken('phone', DATA_DIR);
    await withServer(async (base) => {
      expect((await (await v1(base, token, 'GET', '/accounts')).json()).accounts).toHaveLength(3);
      await admin(base, 'PUT', { hiddenIds: [HIDDEN] });
      const hidden = await (await v1(base, token, 'GET', '/accounts')).json();
      expectValid('accountsResponse', hidden);
      expect(hidden.accounts.map((a) => a.id)).not.toContain(HIDDEN);
      await admin(base, 'PUT', { hiddenIds: [] });
      expect((await (await v1(base, token, 'GET', '/accounts')).json()).accounts).toHaveLength(3);
    });
  });

  test('the legacy summary leaves hidden accounts out of its accounts list', async () => {
    const { token } = await tokens.createToken('phone', DATA_DIR);
    const seen = [];
    await hide();
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../src/mobile/summary', () => ({ buildMobileSummary: async ({ client: c }) => { seen.push((await c.getAccounts()).map((a) => a.id)); return { schema: 1 }; } }));
      const app = require('../../src/server');
      const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/mobile/summary`, { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status).toBe(200);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
    expect(seen).toEqual([['a-chk', 'a-ret', 'a-old']]);
  });
});

describe('the shared client view', () => {
  const recording = () => {
    const queries = [];
    const base = {
      getAccounts: async () => [{ id: 'a-1' }, { id: 'a-2' }],
      getAccountBalance: jest.fn(async () => 500),
      getTransactions: jest.fn(async () => [{ id: 't' }]),
      getBudgetMonth: async () => ({ untouched: true }),
      getCategoryGroups: async () => [],
      getPayees: async () => [],
      aqlQuery: jest.fn(async (query) => { queries.push(query.serialize()); return { data: [] }; }),
    };
    return { base, queries };
  };
  const filterText = (s) => JSON.stringify(s.filterExpressions);

  test('accounts, balances and transactions of a hidden account vanish; budget data is untouched; nothing hidden returns the client itself', async () => {
    const { base } = recording();
    expect(scopeClient(base, [])).toBe(base);
    const view = scopeClient(base, ['a-2']);
    expect((await view.getAccounts()).map((a) => a.id)).toEqual(['a-1']);
    expect(await view.getTransactions('a-2')).toEqual([]);
    expect(await view.getTransactions('a-1')).toEqual([{ id: 't' }]);
    expect(await view.getAccountBalance('a-1')).toBe(500);
    expect(await view.getBudgetMonth('2026-11')).toEqual({ untouched: true });
  });

  test('every query on transactions gets the account filter, other tables are left alone', async () => {
    const { base, queries } = recording();
    const view = scopeClient(base, ['a-2', 'a-3']);
    await view.aqlQuery(q('transactions').filter({ date: { $gte: '2026-01-01' } }).groupBy('date').select([{ date: 'date' }]));
    await view.aqlQuery(q('transactions').calculate({ $count: '$id' }));
    await view.aqlQuery(q('payees').select('*'));
    expect(filterText(queries[0])).toContain('"account":{"$ne":"a-2"}');
    expect(filterText(queries[0])).toContain('"account":{"$ne":"a-3"}');
    expect(filterText(queries[0])).toContain('$gte');
    expect(filterText(queries[1])).toContain('"$ne":"a-2"');
    expect(queries[2].filterExpressions).toEqual([]);
  });

  test('the spending drill-down and the cash-flow data go through it, so hidden accounts are excluded', async () => {
    const { base, queries } = recording();
    const view = scopeClient(base, ['a-2']);
    await buildSpending(view, '2026-11', { level: 'categories', categoryIds: ['c-1'] }, new Date());
    await buildSpending(view, '2026-11', { level: 'payees', categoryId: 'c-1' }, new Date());
    await buildSpending(view, '2026-11', { level: 'transactions', categoryId: 'c-1', payeeId: '__none__' }, new Date());
    await loadMonthCashFlow(view, '2026-11').catch(() => {});
    const onTransactions = queries.filter((s) => s.table === 'transactions');
    expect(onTransactions.length).toBeGreaterThanOrEqual(4);
    for (const s of onTransactions) expect(filterText(s)).toContain('"$ne":"a-2"');
  });
});
