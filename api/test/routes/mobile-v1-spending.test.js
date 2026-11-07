const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-spending-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const store = require('../../src/mobile-tokens-store');
const { expectValid, examples } = require('../helpers/native-v1');

const NOW = new Date(2026, 10, 12, 10, 0, 0);

const GROUPS = [
  { id: 'g-usual', name: 'Usual Expenses', categories: [{ id: 'c-groc', name: 'Groceries' }, { id: 'c-fuel', name: 'Fuel' }] },
  { id: 'g-fun', name: 'Fun', categories: [{ id: 'c-eat', name: 'Eating out' }] },
];
const PAYEES = [{ id: 'p-grocer', name: 'Example Grocer' }, { id: 'p-pump', name: 'Example Pump' }];
const tx = (id, date, amount, category, payee, extra = {}) => ({ id, date, amount, category, payee, notes: null, imported_payee: null, tombstone: false, transfer_id: null, ...extra });
const TXS = [
  tx('t1', '2026-11-11', -8423, 'c-groc', 'p-grocer'),
  tx('t2', '2026-11-03', -1000, 'c-groc', 'p-grocer', { notes: 'x'.repeat(900) }),
  tx('t3', '2026-11-05', -1077, 'c-groc', null),
  tx('t4', '2026-11-06', -2800, 'c-fuel', 'p-pump'),
  tx('t5', '2026-11-07', 500, 'c-eat', 'p-grocer'), // net inflow: left out
  tx('t6', '2026-10-30', -9999, 'c-groc', 'p-grocer'), // other month
  tx('t7', '2026-11-08', -7777, 'c-groc', 'p-grocer', { transfer_id: 'x' }), // transfer
  tx('t8', '2026-11-09', -6666, 'c-groc', 'p-grocer', { tombstone: true }),
];

function matches(row, f) {
  return Object.entries(f).every(([key, cond]) => {
    if (key === '$and') return cond.every((c) => matches(row, c));
    const v = row[key];
    if (cond !== null && typeof cond === 'object') {
      return Object.entries(cond).every(([op, arg]) => (op === '$gte' ? v >= arg : op === '$lte' ? v <= arg : op === '$oneof' ? arg.includes(v) : false));
    }
    return (v ?? null) === cond;
  });
}

function makeClient() {
  return {
    getCategoryGroups: jest.fn(async () => GROUPS),
    aqlQuery: jest.fn(async (query) => {
      const s = query.serialize();
      if (s.table === 'categories') return { data: GROUPS.flatMap((g) => g.categories) };
      if (s.table === 'payees') return { data: PAYEES };
      if (s.table !== 'transactions') throw new Error('fake AQL');
      const rows = TXS.filter((r) => s.filterExpressions.every((f) => matches(r, f)));
      if (s.groupExpressions.length === 0) {
        return { data: rows.map((r) => ({ id: r.id, date: r.date, amount: r.amount, notes: r.notes, imported_payee: r.imported_payee })) };
      }
      const col = s.groupExpressions[0];
      const sums = new Map();
      for (const r of rows) sums.set(r[col] ?? null, (sums.get(r[col] ?? null) || 0) + r.amount);
      const name = col === 'category' ? 'categoryId' : 'payeeId';
      return { data: [...sums].map(([k, amountCents]) => ({ [name]: k, amountCents })) };
    }),
  };
}

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
const get = (base, token, url, headers = {}) => fetch(`${base}/api/mobile/v1${url}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });

beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
  client = makeClient();
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

test('the contract examples validate', () => {
  for (const name of ['spendingResponse', 'spendingPayees', 'spendingTransactions']) expectValid('spendingResponse', examples[name]);
});

test('requires a bearer token, like the other reads', async () => {
  await withServer(async (base) => {
    const res = await get(base, null, '/spending?level=payees&categoryId=c-groc');
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('levels', () => {
  test('categories: one item per category with spending, titled by the shared group, each drilling to payees', async () => {
    const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
    await withServer(async (base) => {
      const res = await get(base, token, '/spending?month=2026-11&level=categories&categoryIds=c-groc,c-fuel,c-eat');
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('spendingResponse', body);
      expect(body).toMatchObject({ month: '2026-11', level: 'categories', title: 'Selected categories', total: 8423 + 1000 + 1077 + 2800, transactions: [] });
      expect(body.items).toEqual(expect.arrayContaining([
        { id: 'c-groc', label: 'Groceries', amount: 10500, drill: { level: 'payees', categoryId: 'c-groc' } },
        { id: 'c-fuel', label: 'Fuel', amount: 2800, drill: { level: 'payees', categoryId: 'c-fuel' } },
      ]));
      expect(body.items).toHaveLength(2);

      const one = await (await get(base, token, '/spending?level=categories&categoryIds=c-groc,c-fuel')).json();
      expectValid('spendingResponse', one);
      expect(one.title).toBe('Usual Expenses');
      expect(one.month).toBe('2026-11');
    });
  });

  test('payees: positive cents, the no-payee bucket is __none__, no inflow slices, title is the category', async () => {
    const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
    await withServer(async (base) => {
      const body = await (await get(base, token, '/spending?month=2026-11&level=payees&categoryId=c-groc')).json();
      expectValid('spendingResponse', body);
      expect(body.title).toBe('Groceries');
      expect(body.total).toBe(10500);
      expect(body.items).toEqual(expect.arrayContaining([
        { id: 'p-grocer', label: 'Example Grocer', amount: 9423, drill: { level: 'transactions', categoryId: 'c-groc', payeeId: 'p-grocer' } },
        { id: '__none__', label: 'No payee', amount: 1077, drill: { level: 'transactions', categoryId: 'c-groc', payeeId: '__none__' } },
      ]));
      const inflow = await (await get(base, token, '/spending?month=2026-11&level=payees&categoryId=c-eat')).json();
      expect(inflow.items).toEqual([]);
      expect(inflow.total).toBe(0);
    });
  });

  test('transactions: newest first, notes clipped, null payee for the bucket, total is their sum', async () => {
    const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
    await withServer(async (base) => {
      const body = await (await get(base, token, '/spending?month=2026-11&level=transactions&categoryId=c-groc&payeeId=p-grocer')).json();
      expectValid('spendingResponse', body);
      expect(body.title).toBe('Example Grocer');
      expect(body.items).toEqual([]);
      expect(body.transactions.map((t) => t.id)).toEqual(['t1', 't2']);
      expect(body.transactions[0]).toEqual({ id: 't1', date: '2026-11-11', payee: 'Example Grocer', amount: 8423, notes: null });
      expect(body.transactions[1].notes).toHaveLength(500);
      expect(body.total).toBe(9423);

      const none = await (await get(base, token, '/spending?month=2026-11&level=transactions&categoryId=c-groc&payeeId=__none__')).json();
      expectValid('spendingResponse', none);
      expect(none.title).toBe('No payee');
      expect(none.transactions).toEqual([{ id: 't3', date: '2026-11-05', payee: null, amount: 1077, notes: null }]);
    });
  });

  test('at most 100 transactions', async () => {
    for (let i = 0; i < 130; i += 1) TXS.push(tx(`bulk${i}`, '2026-11-02', -100, 'c-bulk', 'p-grocer'));
    try {
      const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
      await withServer(async (base) => {
        const body = await (await get(base, token, '/spending?month=2026-11&level=transactions&categoryId=c-bulk&payeeId=p-grocer')).json();
        expectValid('spendingResponse', body);
        expect(body.transactions).toHaveLength(100);
        expect(body.total).toBe(10000);
      });
    } finally {
      TXS.length -= 130;
    }
  });
});

describe('strict query parsing', () => {
  test('400 bad_request on unknown, repeated, missing, extra or malformed params, never echoing input', async () => {
    const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
    const manyIds = Array.from({ length: 201 }, (_, i) => `c${i}`).join(',');
    const bad = [
      '/spending',
      '/spending?level=nope&categoryId=c-groc',
      '/spending?level=categories',
      '/spending?level=categories&categoryIds=',
      '/spending?level=categories&categoryIds=a,,b',
      '/spending?level=categories&categoryIds=a%20b',
      `/spending?level=categories&categoryIds=${manyIds}`,
      '/spending?level=categories&categoryIds=a&categoryId=a',
      '/spending?level=categories&categoryIds=a&categoryIds=b',
      '/spending?level=categories&categoryIds[]=a',
      '/spending?level=payees',
      '/spending?level=payees&categoryId=c-groc&payeeId=p-grocer',
      '/spending?level=payees&categoryId=c-groc&extra=1',
      '/spending?level=payees&categoryId=c-groc&level=payees',
      '/spending?level=payees&categoryId=bad%20id',
      '/spending?level=transactions&categoryId=c-groc',
      '/spending?level=transactions&categoryId=c-groc&payeeId=bad%20id',
      '/spending?level=payees&categoryId=c-groc&month=2026-13',
      '/spending?level=payees&categoryId=c-groc&month=2026-1',
      '/spending?level=payees&categoryId=c-groc&month=2099-01',
      '/spending?level=constructor&categoryId=c-groc',
    ];
    await withServer(async (base) => {
      for (const url of bad) {
        const res = await get(base, token, url);
        expect([url, res.status]).toEqual([url, 400]);
        const text = await res.text();
        expect(text).toBe('{"error":"bad_request"}');
      }
    });
  });

  test('exactly 200 ids is accepted; duplicates are folded', async () => {
    const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
    const ids = Array.from({ length: 200 }, (_, i) => `c${i}`).join(',');
    await withServer(async (base) => {
      const res = await get(base, token, `/spending?level=categories&categoryIds=${ids}`);
      expect(res.status).toBe(200);
      expectValid('spendingResponse', await res.json());
      expect((await get(base, token, '/spending?level=categories&categoryIds=c-groc,c-groc')).status).toBe(200);
    });
  });
});

describe('caching, rate limit and failures', () => {
  test('cached per parameters for 15 seconds', async () => {
    const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
    await withServer(async (base) => {
      await get(base, token, '/spending?level=payees&categoryId=c-groc');
      await get(base, token, '/spending?level=payees&categoryId=c-groc');
      const calls = client.aqlQuery.mock.calls.length;
      await get(base, token, '/spending?level=payees&categoryId=c-fuel');
      expect(client.aqlQuery.mock.calls.length).toBeGreaterThan(calls);
      const afterFuel = client.aqlQuery.mock.calls.length;
      await get(base, token, '/spending?level=payees&categoryId=c-fuel');
      expect(client.aqlQuery.mock.calls.length).toBe(afterFuel);
    });
  });

  test('shares the read rate limit: 429 after 60 reads a minute', async () => {
    const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
    await withServer(async (base) => {
      let last;
      for (let i = 0; i < 61; i += 1) last = await get(base, token, '/spending?level=payees&categoryId=c-groc');
      expect(last.status).toBe(429);
      expect(await last.json()).toEqual({ error: 'rate_limited' });
    });
  });

  test('a failing query is a 500 internal and echoes nothing', async () => {
    const { token } = await store.createToken('phone', DATA_DIR, { scope: 'read' });
    client.aqlQuery.mockRejectedValue(new Error('secret budget detail'));
    await withServer(async (base) => {
      const res = await get(base, token, '/spending?level=payees&categoryId=c-groc');
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"internal"}');
    });
  });
});
