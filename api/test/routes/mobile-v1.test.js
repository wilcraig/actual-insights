const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-route-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/mobile/v1/reports', () => ({ buildReports: jest.fn(), buildReportList: jest.fn() }));

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const { buildReports, buildReportList } = require('../../src/mobile/v1/reports');
const { HttpError } = require('../../src/mobile/v1/common');
const store = require('../../src/mobile-tokens-store');
const { expectValid, isValid, examples, makeFakeActual } = require('../helpers/native-v1');

const NOW = new Date('2026-11-12T15:00:00.000Z');
const AUDIT = path.join(DATA_DIR, 'mobile-audit.log');

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

const V1 = '/api/mobile/v1';
const call = (base, token, method, url, body, extra = {}) =>
  fetch(`${base}${V1}${url}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (base, token, url) => call(base, token, 'GET', url);

async function newToken(scope = 'read', label = 'phone') {
  return store.createToken(label, DATA_DIR, { scope });
}

async function json(res, definition) {
  const body = await res.json();
  if (definition) expectValid(definition, body);
  return body;
}

const auditLines = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
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
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
});

afterEach(() => {
  console.error.mockRestore();
  jest.useRealTimers();
});

describe('the contract examples', () => {
  test('every example response validates, and drift is rejected', () => {
    for (const name of ['me', 'accountsResponse', 'transactionsResponse', 'categoriesResponse', 'budgetMonthResponse', 'transactionDetailResponse', 'reportListResponse', 'budgetChangeResponse', 'reportsResponse', 'error']) {
      expectValid(name, examples[name]);
    }
    expect(isValid('me', { ...examples.me, extra: 1 })).toBe(false);
    expect(isValid('error', { error: 'rate limited' })).toBe(false);
  });
});

describe('authentication', () => {
  test('identical 401 with WWW-Authenticate, no-store and no CORS, on every endpoint, for every failure', async () => {
    const { token } = await newToken();
    const revoked = await newToken('read', 'old');
    await store.revokeToken(revoked.id, DATA_DIR);
    await withServer(async (base) => {
      const headersList = [{}, { Authorization: '' }, { Authorization: 'Bearer garbage' }, { Authorization: `Basic ${token}` }, { Authorization: `Bearer ${revoked.token}` }, { Authorization: `Bearer ${token.slice(0, -1)}` }, { 'X-ACTUAL-TOKEN': 'valid' }];
      const endpoints = [['GET', '/me'], ['GET', '/accounts'], ['GET', '/transactions'], ['GET', '/categories'], ['GET', '/budget/2026-11'], ['GET', '/reports'], ['PATCH', '/transactions/t-02'], ['GET', '/report-list'], ['PATCH', '/transactions/t-02'], ['POST', '/transactions/t-02'], ['PUT', '/budget/2026-11/categories/c-groc'], ['POST', '/budget/2026-11/move'], ['PUT', '/transactions/t-02/splits'], ['DELETE', '/transactions/t-05/splits'], ['GET', '/nothing']];
      const seen = [];
      for (const [method, url] of endpoints) {
        for (const headers of headersList) {
          const res = await fetch(`${base}${V1}${url}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{"category":null}' });
          seen.push({ status: res.status, body: await res.text(), authenticate: res.headers.get('www-authenticate'), cache: res.headers.get('cache-control'), cors: res.headers.get('access-control-allow-origin') });
        }
      }
      expect(seen.every((r) => r.status === 401)).toBe(true);
      expect(new Set(seen.map((r) => r.body))).toEqual(new Set(['{"error":"unauthorized"}']));
      expect(new Set(seen.map((r) => r.authenticate))).toEqual(new Set(['Bearer realm="actual-insights"']));
      expect(new Set(seen.map((r) => r.cache))).toEqual(new Set(['no-store']));
      expect(seen.every((r) => r.cors === null)).toBe(true);
      expect(client.updateTransaction).not.toHaveBeenCalled();
    });
  });

  test('an unauthenticated malformed JSON body is still just a 401', async () => {
    await withServer(async (base) => {
      const res = await call(base, null, 'PATCH', '/transactions/t-02', '{not json');
      expect(res.status).toBe(401);
    });
  });

  test('revoking a token cuts reads and writes at once', async () => {
    const { token, id } = await newToken('write');
    await withServer(async (base) => {
      expect((await get(base, token, '/me')).status).toBe(200);
      await store.revokeToken(id, DATA_DIR);
      expect((await get(base, token, '/me')).status).toBe(401);
      expect((await call(base, token, 'PATCH', '/transactions/t-02', { category: 'c-groc' })).status).toBe(401);
    });
  });

  test('unknown paths are 404 after auth; successes carry no-store and no CORS', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const res = await get(base, token, '/nothing');
      expect(res.status).toBe(404);
      expect(await json(res, 'error')).toEqual({ error: 'not_found' });
      const ok = await get(base, token, '/accounts');
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(ok.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});

describe('GET /me', () => {
  test('reports the token scope and the budget currency', async () => {
    client.state.currency = 'EUR';
    const r = await newToken('read');
    const w = await newToken('write', 'edit');
    await withServer(async (base) => {
      expect(await json(await get(base, r.token, '/me'), 'me')).toEqual({ schema: 1, scope: 'read', currency: 'EUR' });
      expect(await json(await get(base, w.token, '/me'), 'me')).toEqual({ schema: 1, scope: 'write', currency: 'EUR' });
    });
  });
});

describe('GET /accounts', () => {
  test('open accounts only, on-budget first, by name, with balances', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/accounts'), 'accountsResponse');
      expect(body.accounts).toEqual([
        { id: 'a-chk', name: 'Everyday Checking', balance: 312450, onBudget: true },
        { id: 'a-sav', name: 'Rainy Day Savings', balance: 1050000, onBudget: true },
        { id: 'a-ret', name: 'Retirement', balance: 9900000, onBudget: false },
      ]);
    });
  });

  test('a balance that cannot be read is null', async () => {
    client.getAccountBalance.mockRejectedValueOnce(new Error('boom'));
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/accounts'), 'accountsResponse');
      expect(body.accounts[0].balance).toBeNull();
    });
  });
});

describe('GET /transactions', () => {
  test('newest first, then id descending; resolved names; flags; no tombstones, split children or closed accounts', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/transactions'), 'transactionsResponse');
      expect(body.transactions.map((t) => t.id)).toEqual(['t-01', 't-04x', 't-04', 't-03', 't-02', 't-05', 't-07', 't-09', 't-10', 't-11']);
      expect(body.nextCursor).toBeNull();
      const byId = Object.fromEntries(body.transactions.map((t) => [t.id, t]));
      expect(byId['t-01']).toEqual({ id: 't-01', date: '2026-11-11', accountId: 'a-chk', accountName: 'Everyday Checking', payee: 'Example Grocer', amount: -8423, category: { id: 'c-groc', name: 'Groceries' }, categoryGroup: 'Usual Expenses', notes: null, cleared: true, transfer: false, split: false });
      expect(byId['t-04']).toMatchObject({ transfer: true, payee: 'Transfer: Everyday Checking', category: null });
      expect(byId['t-05'].split).toBe(true);
      expect(byId['t-03'].notes).toBeNull();
      expect(byId['t-02'].notes).toBe('screws #house #diy #house');
      expect(byId['t-02'].categoryGroup).toBeNull();
      expect(byId['t-09'].payee).toBeNull();
    });
  });

  test('a tombstoned row is dropped even if the data layer let it through', async () => {
    const orig = client.aqlQuery.getMockImplementation();
    client.aqlQuery.mockImplementation(async (query) => {
      const result = await orig(query);
      if (query.serialize().calculation) return result;
      return { data: [...result.data, { id: 't-dead', date: '2026-11-12', account: 'a-chk', tombstone: true, amount: 1 }] };
    });
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/transactions'), 'transactionsResponse');
      expect(body.transactions.map((t) => t.id)).not.toContain('t-dead');
    });
  });

  test('account filter, including a closed account; unknown account is 404', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const sav = await json(await get(base, token, '/transactions?account=a-sav'), 'transactionsResponse');
      expect(sav.transactions.map((t) => t.id)).toEqual(['t-04', 't-09']);
      const old = await json(await get(base, token, '/transactions?account=a-old'), 'transactionsResponse');
      expect(old.transactions.map((t) => t.id)).toEqual(['t-08']);
      expect(sav.uncategorizedCount).toBe(1);
      const res = await get(base, token, '/transactions?account=a-nope');
      expect(res.status).toBe(404);
      expect(await json(res, 'error')).toEqual({ error: 'not_found' });
    });
  });

  test('uncategorized=1 keeps expense or income rows without a category: no transfers, split parents, off-budget or closed accounts', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/transactions?uncategorized=1'), 'transactionsResponse');
      expect(body.transactions.map((t) => t.id)).toEqual(['t-03', 't-02', 't-09']);
      expect(body.uncategorizedCount).toBe(3);
      const all = await json(await get(base, token, '/transactions'), 'transactionsResponse');
      expect(all.uncategorizedCount).toBe(3);
    });
  });

  test('uncategorizedCount is on the first page only and ignores the page limit', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const first = await json(await get(base, token, '/transactions?limit=2'), 'transactionsResponse');
      expect(first.uncategorizedCount).toBe(3);
      const second = await json(await get(base, token, `/transactions?limit=2&cursor=${first.nextCursor}`), 'transactionsResponse');
      expect('uncategorizedCount' in second).toBe(false);
    });
  });

  test('cursor paging is stable: no repeats or gaps, same-date ties ordered by id, even when rows are added mid-walk', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const seen = [];
      let cursor = null;
      let pages = 0;
      do {
        const url = `/transactions?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
        const body = await json(await get(base, token, url), 'transactionsResponse');
        expect(body.transactions.length).toBeLessThanOrEqual(3);
        seen.push(...body.transactions.map((t) => t.id));
        if (pages === 0) {
          // A newer row arrives between pages: it must not shift the later pages.
          client.state.transactions.push({ id: 't-new', date: '2026-11-12', account: 'a-chk', payee: 'p-grocer', category: null, amount: -1, notes: null, cleared: false });
          require('../../src/routes/mobile-v1').resetMobileV1State();
        }
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(seen).toEqual(['t-01', 't-04x', 't-04', 't-03', 't-02', 't-05', 't-07', 't-09', 't-10', 't-11']);
      expect(new Set(seen).size).toBe(seen.length);
    });
  });

  test('the cursor looks like the contract example and a full page exactly at the end has no next cursor', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const first = await json(await get(base, token, '/transactions?limit=1'), 'transactionsResponse');
      expect(first.nextCursor).toBe('c_2026-11-11_t-01');
      const all = await json(await get(base, token, '/transactions?limit=10'), 'transactionsResponse');
      expect(all.transactions).toHaveLength(10);
      expect(all.nextCursor).toBeNull();
    });
  });

  test('strict parameter validation: 400 bad_request, never echoing input', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const bad = [
        '?limit=0', '?limit=101', '?limit=-1', '?limit=abc', '?limit=1.5', '?limit=05', '?limit=', '?limit=10&limit=20', '?limit[]=1',
        '?uncategorized=0', '?uncategorized=true', '?uncategorized=',
        '?account=', '?account=a%20b', `?account=${'a'.repeat(65)}`, '?account[$ne]=x', '?account=a&account=b',
        '?cursor=garbage', '?cursor=c_2026-13-01_t-01', '?cursor=c_2026-11-01_', `?cursor=c_2026-11-01_${'x'.repeat(65)}`, '?cursor=',
        '?unknown=1', '?Limit=5',
      ];
      for (const q of bad) {
        const res = await get(base, token, `/transactions${q}`);
        expect([q, res.status]).toEqual([q, 400]);
        const text = await res.text();
        expect(text).toBe('{"error":"bad_request"}');
      }
      expect((await get(base, token, '/accounts?x=1')).status).toBe(400);
      expect((await get(base, token, '/me?x=1')).status).toBe(400);
      const ok = await get(base, token, '/transactions?limit=100&uncategorized=1&account=a-chk');
      expect(ok.status).toBe(200);
    });
  });

  test('a cursor with a well-formed but unknown id just continues after that position', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/transactions?cursor=c_2026-11-09_zzz'), 'transactionsResponse');
      expect(body.transactions.map((t) => t.id)).toEqual(['t-05', 't-07', 't-09', 't-10', 't-11']);
    });
  });

  test('group and category filter by where the money went; at most one of uncategorized, group, category', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const group = await json(await get(base, token, '/transactions?group=g-usual'), 'transactionsResponse');
      expect(group.transactions.map((t) => t.id)).toEqual(['t-01', 't-10', 't-11']);
      expect(group.transactions.every((t) => t.categoryGroup === 'Usual Expenses')).toBe(true);
      expect(group.uncategorizedCount).toBe(3);
      const category = await json(await get(base, token, '/transactions?category=c-fuel&account=a-chk'), 'transactionsResponse');
      expect(category.transactions.map((t) => t.id)).toEqual(['t-10', 't-11']);
      const none = await json(await get(base, token, '/transactions?group=g-nope'), 'transactionsResponse');
      expect(none.transactions).toEqual([]);
      for (const q of ['?group=g-usual&category=c-fuel', '?group=g-usual&uncategorized=1', '?category=c-fuel&uncategorized=1', '?group=', '?group=a%20b', '?category=a&category=b', `?group=${'a'.repeat(65)}`]) {
        expect([q, (await get(base, token, `/transactions${q}`)).status]).toEqual([q, 400]);
      }
    });
  });
});

describe('GET /transactions/:id', () => {
  test('the detail: imported fields, recurring, tags, splits, transfer account', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const plain = (await json(await get(base, token, '/transactions/t-02'), 'transactionDetailResponse')).transaction;
      expect(plain).toEqual({ id: 't-02', date: '2026-11-10', accountId: 'a-chk', accountName: 'Everyday Checking', payee: 'Example Hardware', amount: -2399, category: null, categoryGroup: null, notes: 'screws #house #diy #house', cleared: false, reconciled: false, transfer: false, split: false, importedPayee: 'EXAMPLE HDWR #1234', importedId: 'SFIN-0001', recurring: 'Hardware club', tags: ['house', 'diy'], splits: [], transferAccountName: null });
      const manual = (await json(await get(base, token, '/transactions/t-01'), 'transactionDetailResponse')).transaction;
      expect(manual).toMatchObject({ categoryGroup: 'Usual Expenses', importedPayee: null, importedId: null, recurring: null, tags: [], reconciled: false });
      const split = (await json(await get(base, token, '/transactions/t-05'), 'transactionDetailResponse')).transaction;
      expect(split.split).toBe(true);
      expect(split.splits).toEqual([{ category: { id: 'c-groc', name: 'Groceries' }, amount: -2500, notes: 'half' }, { category: null, amount: -2500, notes: null }]);
      const xfer = (await json(await get(base, token, '/transactions/t-04'), 'transactionDetailResponse')).transaction;
      expect(xfer).toMatchObject({ transfer: true, transferAccountName: 'Everyday Checking' });
      expect((await json(await get(base, token, '/transactions/t-11'), 'transactionDetailResponse')).transaction.reconciled).toBe(true);
    });
  });

  test('clips importedId, limits tags; unknown, deleted and split-line ids are 404; bad ids and params 400', async () => {
    client.state.transactions.find((t) => t.id === 't-03').imported_id = 'x'.repeat(300);
    client.state.transactions.find((t) => t.id === 't-03').notes = `${Array.from({ length: 30 }, (_, i) => `#t${i}`).join(' ')} #${'y'.repeat(51)} a#b`;
    const { token } = await newToken();
    await withServer(async (base) => {
      const d = (await json(await get(base, token, '/transactions/t-03'), 'transactionDetailResponse')).transaction;
      expect(d.importedId).toHaveLength(200);
      expect(d.tags).toHaveLength(20);
      expect(d.tags[0]).toBe('t0');
      for (const id of ['t-nope', 't-06', 't-05c']) {
        const res = await get(base, token, `/transactions/${id}`);
        expect([id, res.status, await res.text()]).toEqual([id, 404, '{"error":"not_found"}']);
      }
      expect((await get(base, token, '/transactions/bad%20id')).status).toBe(400);
      expect((await get(base, token, '/transactions/t-02?x=1')).status).toBe(400);
    });
  });
});

describe('GET /categories and /budget/:month', () => {
  test('categories: visible groups and categories in order, hidden left out', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/categories'), 'categoriesResponse');
      expect(body.groups).toEqual([
        { id: 'g-usual', name: 'Usual Expenses', isIncome: false, categories: [{ id: 'c-groc', name: 'Groceries' }, { id: 'c-fuel', name: 'Fuel' }] },
        { id: 'g-empty', name: 'Nothing here', isIncome: false, categories: [] },
        { id: 'g-income', name: 'Income', isIncome: true, categories: [{ id: 'c-pay', name: 'Paycheck' }] },
      ]);
    });
  });

  test('budget month: expense groups only, hidden excluded, group sums from categories, totals from Actual', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const body = await json(await get(base, token, '/budget/2026-11'), 'budgetMonthResponse');
      expect(body.month).toBe('2026-11');
      expect(body.groups).toEqual([
        {
          id: 'g-usual', name: 'Usual Expenses', budgeted: 63000, spent: -12300, balance: 50700,
          categories: [
            { id: 'c-groc', name: 'Groceries', budgeted: 45000, spent: -9500, balance: 35500, carryover: false },
            { id: 'c-fuel', name: 'Fuel', budgeted: 18000, spent: -2800, balance: 15200, carryover: true },
          ],
        },
      ]);
      // Actual reports totalBudgeted negative; the contract's is the plain sum.
      expect(body.totals).toEqual({ toBudget: 163840, budgeted: 63000, spent: -12300, balance: 50700, income: 215000 });
    });
  });

  test('toBudget is null when Actual does not report it', async () => {
    client.state.toBudget = undefined;
    const { token } = await newToken();
    await withServer(async (base) => {
      expect((await json(await get(base, token, '/budget/2026-11'), 'budgetMonthResponse')).totals.toBudget).toBeNull();
    });
  });

  test('month validation: format, real month, within five years', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      for (const m of ['2026-13', '2026-00', '26-11', '2026-1', 'abc', '2026-11-01', '2019-10', '2031-12', '1999-01']) {
        expect([m, (await get(base, token, `/budget/${m}`)).status]).toEqual([m, 400]);
      }
      for (const m of ['2021-11', '2031-11', '2026-12']) expect((await get(base, token, `/budget/${m}`)).status).toBe(200);
    });
  });
});

describe('GET /reports', () => {
  test('returns what the reports builder returns, built lazily with the client and the time', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const res = await get(base, token, '/reports');
      expect(res.status).toBe(200);
      expect(await json(res, 'reportsResponse')).toEqual(examples.reportsResponse);
      expect(buildReports).toHaveBeenCalledWith({ client, now: expect.any(Date), reportId: undefined });
    });
  });

  test('?report=<id> is passed through and cached per report; bad ids and other params are 400; a builder 404 is a 404', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      expect((await get(base, token, '/reports?report=page-main')).status).toBe(200);
      expect(buildReports).toHaveBeenLastCalledWith({ client, now: expect.any(Date), reportId: 'page-main' });
      await get(base, token, '/reports');
      await get(base, token, '/reports?report=page-main');
      expect(buildReports).toHaveBeenCalledTimes(2);
      for (const q of ['?report=', '?report=a%20b', `?report=${'a'.repeat(65)}`, '?report=a&report=b', '?id=a']) {
        expect([q, (await get(base, token, `/reports${q}`)).status]).toEqual([q, 400]);
      }
      buildReports.mockRejectedValueOnce(new HttpError(404, 'not_found'));
      const res = await get(base, token, '/reports?report=gone');
      expect([res.status, await res.text()]).toEqual([404, '{"error":"not_found"}']);
    });
  });
});

describe('GET /report-list', () => {
  test('returns the report list builder result, validated', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const res = await get(base, token, '/report-list');
      expect(await json(res, 'reportListResponse')).toEqual(examples.reportListResponse);
      expect(buildReportList).toHaveBeenCalledWith({ client, now: expect.any(Date) });
      expect((await get(base, token, '/report-list?x=1')).status).toBe(400);
    });
  });
});

describe('GET /reports (failure)', () => {
  test('a failing builder is a 500 internal, not cached, and echoes nothing', async () => {
    buildReports.mockRejectedValueOnce(new Error('secret detail'));
    const { token } = await newToken();
    await withServer(async (base) => {
      const res = await get(base, token, '/reports');
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"internal"}');
      expect((await get(base, token, '/reports')).status).toBe(200);
      expect(buildReports).toHaveBeenCalledTimes(2);
    });
  });
});

describe('rate limits', () => {
  test('reads: 60 a minute per token shared with /summary, then 429 rate_limited with Retry-After', async () => {
    const a = await newToken('read', 'a');
    const b = await newToken('read', 'b');
    await withServer(async (base) => {
      for (let i = 0; i < 30; i++) expect((await get(base, a.token, '/me')).status).toBe(200);
      for (let i = 0; i < 30; i++) expect((await fetch(`${base}/api/mobile/summary`, { headers: { Authorization: `Bearer ${a.token}` } })).status).not.toBe(429);
      const limited = await get(base, a.token, '/accounts');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await json(limited, 'error')).toEqual({ error: 'rate_limited' });
      expect((await get(base, b.token, '/me')).status).toBe(200);
      jest.setSystemTime(new Date(NOW.getTime() + 61000));
      expect((await get(base, a.token, '/me')).status).toBe(200);
    });
  });

  test('writes: 20 a minute per token, separately from reads', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      for (let i = 0; i < 20; i++) expect((await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 100 + i })).status).toBe(200);
      const limited = await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 1 });
      expect(limited.status).toBe(429);
      expect(await json(limited, 'error')).toEqual({ error: 'rate_limited' });
      expect(client.state.budget['2026-11']['c-groc']).toBe(119);
      expect((await get(base, token, '/me')).status).toBe(200);
    });
  });
});

describe('caching', () => {
  test('reads are cached for 15 seconds per endpoint and parameters, a build in flight is shared, failures are not cached', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      await Promise.all([get(base, token, '/accounts'), get(base, token, '/accounts'), get(base, token, '/accounts')]);
      expect(client.getAccounts).toHaveBeenCalledTimes(1);
      await get(base, token, '/accounts');
      expect(client.getAccounts).toHaveBeenCalledTimes(1);
      await get(base, token, '/budget/2026-11');
      await get(base, token, '/budget/2026-10');
      expect(client.getBudgetMonth).toHaveBeenCalledTimes(2);
      jest.setSystemTime(new Date(NOW.getTime() + 16000));
      await get(base, token, '/accounts');
      expect(client.getAccounts).toHaveBeenCalledTimes(2);

      client.getCategoryGroups.mockRejectedValueOnce(new Error('x'));
      expect((await get(base, token, '/categories')).status).toBe(500);
      expect((await get(base, token, '/categories')).status).toBe(200);
    });
  });

  test('a successful write clears the whole read cache; a refused one does not', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const before = await json(await get(base, token, '/budget/2026-11'), 'budgetMonthResponse');
      await get(base, token, '/accounts');
      expect(before.groups[0].categories[0].budgeted).toBe(45000);

      expect((await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: -5 })).status).toBe(400);
      await get(base, token, '/accounts');
      expect(client.getAccounts).toHaveBeenCalledTimes(1);

      expect((await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 50000 })).status).toBe(200);
      const after = await json(await get(base, token, '/budget/2026-11'), 'budgetMonthResponse');
      expect(after.groups[0].categories[0].budgeted).toBe(50000);
      await get(base, token, '/accounts');
      expect(client.getAccounts).toHaveBeenCalledTimes(2);
    });
  });

  test('a read that began before a write is never served after it', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      let release;
      const gate = new Promise((r) => { release = r; });
      const real = client.getBudgetMonth.getMockImplementation();
      client.getBudgetMonth.mockImplementationOnce(async (m) => { const stale = await real(m); await gate; return stale; });
      const slow = get(base, token, '/budget/2026-11');
      await new Promise((r) => setTimeout(r, 50));
      expect((await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 7000 })).status).toBe(200);
      release();
      expect((await slow).status).toBe(200);
      const fresh = await json(await get(base, token, '/budget/2026-11'), 'budgetMonthResponse');
      expect(fresh.groups[0].categories[0].budgeted).toBe(7000);
    });
  });
});

describe('write scope', () => {
  test('a read token gets 403 read_only on every write and nothing changes', async () => {
    const { token } = await newToken('read');
    await withServer(async (base) => {
      const attempts = [
        ['PATCH', '/transactions/t-02', { category: 'c-groc' }],
        ['POST', '/transactions/t-02', { category: 'c-groc' }, { 'X-HTTP-Method-Override': 'PATCH' }],
        ['PUT', '/budget/2026-11/categories/c-groc', { budgeted: 1 }],
        ['POST', '/budget/2026-11/move', { from: 'c-fuel', to: 'c-groc', amount: 1 }],
        ['PATCH', '/transactions/t-02', 'not even json'],
        ['PUT', '/transactions/t-02/splits', examples.transactionSplitRequest],
        ['DELETE', '/transactions/t-05/splits'],
      ];
      for (const [method, url, body, extra] of attempts) {
        const res = await call(base, token, method, url, body, extra);
        expect(res.status).toBe(403);
        expect(await json(res, 'error')).toEqual({ error: 'read_only' });
      }
      expect(client.updateTransaction).not.toHaveBeenCalled();
      expect(client.setBudgetAmount).not.toHaveBeenCalled();
      expect(client.sync).not.toHaveBeenCalled();
      expect(auditLines()).toEqual([]);
    });
  });

  test('/summary works unchanged with either scope', async () => {
    const r = await newToken('read');
    const w = await newToken('write', 'w');
    jest.doMock('../../src/mobile/summary', () => ({ buildMobileSummary: async () => ({ schema: 1 }) }));
    await withServer(async (base) => {
      for (const t of [r, w]) expect((await fetch(`${base}/api/mobile/summary`, { headers: { Authorization: `Bearer ${t.token}` } })).status).not.toBe(401);
    });
    jest.dontMock('../../src/mobile/summary');
  });
});

describe('PATCH /transactions/:id', () => {
  test('sets a category, returns the transaction after the change, audits, and syncs now', async () => {
    const { token, id } = await newToken('write');
    await withServer(async (base) => {
      const res = await call(base, token, 'PATCH', '/transactions/t-02', { category: 'c-groc' });
      expect(res.status).toBe(200);
      const body = await json(res, 'transactionDetailResponse');
      expect(body.transaction).toMatchObject({ id: 't-02', category: { id: 'c-groc', name: 'Groceries' }, categoryGroup: 'Usual Expenses', notes: 'screws #house #diy #house', importedId: 'SFIN-0001' });
      expect(client.updateTransaction).toHaveBeenCalledWith('t-02', { category: 'c-groc' });
      expect(client.sync).toHaveBeenCalledTimes(1);
      expect(syncIfDue).not.toHaveBeenCalledWith(expect.anything());
      const lines = auditLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toEqual({ time: NOW.toISOString(), tokenId: id, op: 'transaction.update', ids: { transaction: 't-02' }, before: { category: null }, after: { category: 'c-groc' } });
      expect(fs.readFileSync(AUDIT, 'utf8')).not.toContain(token);
    });
  });

  test('null clears the category; repeating is harmless', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      for (let i = 0; i < 2; i++) {
        const body = await json(await call(base, token, 'PATCH', '/transactions/t-01', { category: null }), 'transactionDetailResponse');
        expect(body.transaction.category).toBeNull();
      }
      expect(auditLines()).toHaveLength(1);
      expect(auditLines()[0]).toMatchObject({ before: { category: 'c-groc' }, after: { category: null } });
    });
  });

  test('POST with X-HTTP-Method-Override: PATCH is treated exactly like PATCH; any other POST is 400', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const ok = await call(base, token, 'POST', '/transactions/t-02', { category: 'c-fuel' }, { 'X-HTTP-Method-Override': 'PATCH' });
      expect(ok.status).toBe(200);
      expect((await json(ok, 'transactionDetailResponse')).transaction.category).toEqual({ id: 'c-fuel', name: 'Fuel' });
      expect(auditLines()).toHaveLength(1);
      for (const extra of [{}, { 'X-HTTP-Method-Override': 'PUT' }, { 'X-HTTP-Method-Override': 'patch' }, { 'X-HTTP-Method-Override': 'DELETE' }, { 'X-HTTP-Method-Override': '' }]) {
        const res = await call(base, token, 'POST', '/transactions/t-03', { category: 'c-fuel' }, extra);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('{"error":"bad_request"}');
      }
      expect(client.state.transactions.find((t) => t.id === 't-03').category).toBeNull();
      // Same validation through the override.
      expect((await call(base, token, 'POST', '/transactions/t-04', { category: 'c-fuel' }, { 'X-HTTP-Method-Override': 'PATCH' })).status).toBe(400);
      expect((await call(base, token, 'POST', '/transactions/t-02', { category: 'c-fuel', x: 1 }, { 'X-HTTP-Method-Override': 'PATCH' })).status).toBe(400);
    });
  });

  test('the override shares the write rate limit', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      for (let i = 0; i < 10; i++) await call(base, token, 'PATCH', '/transactions/t-02', { category: 'c-fuel' });
      for (let i = 0; i < 10; i++) await call(base, token, 'POST', '/transactions/t-02', { category: 'c-fuel' }, { 'X-HTTP-Method-Override': 'PATCH' });
      expect((await call(base, token, 'PATCH', '/transactions/t-02', { category: 'c-fuel' })).status).toBe(429);
    });
  });

  test('refusals change nothing: transfer, split parent, closed account, unknown ids, hidden/income categories', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const cases = [
        ['t-04', { category: 'c-groc' }, 400], // transfer
        ['t-05', { category: 'c-groc' }, 400], // split parent
        ['t-08', { category: 'c-groc' }, 400], // closed account
        ['t-05c', { category: 'c-groc' }, 404], // split child: never shown
        ['t-06', { category: 'c-groc' }, 404], // tombstoned
        ['t-nope', { category: 'c-groc' }, 404],
        ['t-02', { category: 'c-nope' }, 404],
        ['t-02', { category: 'c-hid' }, 400], // hidden category
        ['t-02', { category: 'c-gone' }, 400], // category in hidden group
        ['t-02', { category: 'c-pay' }, 400], // income
        ['t-02', {}, 400],
        ['t-02', { notes: 5 }, 400],
        ['t-02', { notes: 'x'.repeat(501) }, 400],
        ['t-02', { cleared: 'yes' }, 400],
        ['t-02', { cleared: null }, 400],
        ['t-11', { cleared: false }, 400], // reconciled
        ['t-05c', { notes: 'x' }, 404],
        ['t-02', { category: 5 }, 400],
        ['t-02', { category: '' }, 400],
        ['t-02', { category: 'bad id' }, 400],
        ['t-02', { category: 'c-groc', extra: 1 }, 400],
        ['t-02', [], 400],
        ['t-02', 'null', 400],
        ['t-02', '{broken', 400],
        ['bad%20id', { category: 'c-groc' }, 400],
      ];
      for (const [id, body, status] of cases) {
        require('../../src/routes/mobile-v1').resetMobileV1State();
        const res = await call(base, token, 'PATCH', `/transactions/${id}`, body);
        expect([id, JSON.stringify(body), res.status]).toEqual([id, JSON.stringify(body), status]);
        expect(JSON.parse(await res.text())).toEqual({ error: status === 404 ? 'not_found' : 'bad_request' });
      }
      expect((await call(base, token, 'PATCH', '/transactions/t-02', undefined)).status).toBe(400);
      expect(client.updateTransaction).not.toHaveBeenCalled();
      expect(client.sync).not.toHaveBeenCalled();
      expect(auditLines()).toEqual([]);
    });
  });

  test('notes and cleared: any non-reconciled transaction, changed fields only, audited with notes clipped, answered with the detail', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const long = 'n'.repeat(500);
      const res = await call(base, token, 'PATCH', '/transactions/t-04', { notes: long, cleared: false });
      expect(res.status).toBe(200);
      const body = await json(res, 'transactionDetailResponse');
      expect(body.transaction).toMatchObject({ id: 't-04', notes: long, cleared: false, transfer: true });
      expect(client.updateTransaction).toHaveBeenCalledWith('t-04', { notes: long, cleared: false });
      expect(auditLines()[0]).toMatchObject({ op: 'transaction.update', before: { notes: null, cleared: true }, after: { notes: 'n'.repeat(80), cleared: false } });
      // Unchanged fields are not sent; null clears notes.
      client.updateTransaction.mockClear();
      const again = await json(await call(base, token, 'PATCH', '/transactions/t-04', { notes: null, cleared: false }), 'transactionDetailResponse');
      expect(again.transaction.notes).toBeNull();
      expect(client.updateTransaction).toHaveBeenCalledWith('t-04', { notes: null });
      // A reconciled row refuses cleared changes but takes notes and a category.
      const rec = await json(await call(base, token, 'PATCH', '/transactions/t-11', { notes: 'ok', category: 'c-groc', cleared: true }), 'transactionDetailResponse');
      expect(rec.transaction).toMatchObject({ notes: 'ok', category: { id: 'c-groc', name: 'Groceries' }, cleared: true, reconciled: true });
    });
  });

  test('a sync failure after the write is logged but the write still answers 200', async () => {
    client.sync.mockRejectedValueOnce(Object.assign(new Error('net'), { code: 'ECONNRESET' }));
    const { token } = await newToken('write');
    await withServer(async (base) => {
      expect((await call(base, token, 'PATCH', '/transactions/t-02', { category: 'c-groc' })).status).toBe(200);
      expect(console.error).toHaveBeenCalledWith('mobile write: sync failed:', 'ECONNRESET');
    });
  });
});

describe('PUT and DELETE /transactions/:id/splits', () => {
  const line = (category, amount, notes = null) => ({ category, amount, notes });
  const put = (base, token, id, body) => call(base, token, 'PUT', `/transactions/${id}/splits`, body);
  const del = (base, token, id) => call(base, token, 'DELETE', `/transactions/${id}/splits`);

  test('the contract example validates', () => {
    expectValid('transactionSplitRequest', examples.transactionSplitRequest);
    expect(isValid('transactionSplitRequest', { splits: [line('c-groc', -1, null)] })).toBe(false);
  });

  test('splits a plain transaction: detail in written order, parent keeps amount and loses its category, audited, synced', async () => {
    const { token, id } = await newToken('write');
    await withServer(async (base) => {
      const body = { splits: [line('c-fuel', -1399, 'gas'), line('c-groc', -1000)] };
      const res = await put(base, token, 't-02', body);
      expect(res.status).toBe(200);
      const { transaction } = await json(res, 'transactionDetailResponse');
      expect(transaction).toMatchObject({ id: 't-02', amount: -2399, split: true, category: null, categoryGroup: null });
      expect(transaction.splits).toEqual([
        { category: { id: 'c-fuel', name: 'Fuel' }, amount: -1399, notes: 'gas' },
        { category: { id: 'c-groc', name: 'Groceries' }, amount: -1000, notes: null },
      ]);
      const [, fields] = client.updateTransaction.mock.calls[0];
      expect(client.updateTransaction).toHaveBeenCalledTimes(1);
      expect(fields.subtransactions.map((l) => l.sort_order)).toEqual([-1, -2]);
      const children = client.state.transactions.filter((t) => t.parent_id === 't-02');
      expect(children.map((c) => [c.account, c.date, c.payee])).toEqual([['a-chk', '2026-11-10', 'p-hw'], ['a-chk', '2026-11-10', 'p-hw']]);
      expect(client.sync).toHaveBeenCalledTimes(1);
      expect(auditLines()).toEqual([{ time: NOW.toISOString(), tokenId: id, op: 'transaction.split', ids: { transaction: 't-02' }, amount: -2399, before: { category: null, splits: [] }, after: { splits: [{ category: 'c-fuel', amount: -1399, notesLength: 3 }, { category: 'c-groc', amount: -1000, notesLength: 0 }] } }]);
      expect(fs.readFileSync(AUDIT, 'utf8')).not.toContain('gas');
      // The list now says Split too (cache was cleared).
      const list = await json(await get(base, token, '/transactions'), 'transactionsResponse');
      expect(list.transactions.find((t) => t.id === 't-02').split).toBe(true);
    });
  });

  test('a second PUT replaces the lines (no duplicates), repeated categories are fine, empty notes become null', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      await put(base, token, 't-02', { splits: [line('c-fuel', -1399), line('c-groc', -1000)] });
      const res = await put(base, token, 't-02', { splits: [line('c-groc', -800, ''), line('c-groc', -800, 'b'), line('c-fuel', -799, null)] });
      expect(res.status).toBe(200);
      const { transaction } = await json(res, 'transactionDetailResponse');
      expect(transaction.splits.map((s) => [s.category.id, s.amount, s.notes])).toEqual([['c-groc', -800, null], ['c-groc', -800, 'b'], ['c-fuel', -799, null]]);
      expect(client.state.transactions.filter((t) => t.parent_id === 't-02')).toHaveLength(3);
      const lines = auditLines();
      expect(lines[1].before.splits).toHaveLength(2);
      expect(lines[1].after.splits).toHaveLength(3);
      // The existing split can be rewritten too.
      const again = await put(base, token, 't-05', { splits: [line('c-fuel', -3000, 'x'), line('c-groc', -2000)] });
      expect(again.status).toBe(200);
      expect(auditLines()[2].before.splits).toEqual([{ category: 'c-groc', amount: -2500, notesLength: 4 }, { category: null, amount: -2500, notesLength: 0 }]);
    });
  });

  test('positive (income-sign) transactions split with positive lines', async () => {
    const { token } = await newToken('write');
    client.state.transactions.push({ id: 't-pos', date: '2026-11-04', account: 'a-chk', payee: 'p-grocer', category: null, amount: 3000, notes: null, cleared: true });
    await withServer(async (base) => {
      expect((await put(base, token, 't-pos', { splits: [line('c-groc', 1000), line('c-fuel', 2000)] })).status).toBe(200);
      expect((await put(base, token, 't-pos', { splits: [line('c-groc', 4000), line('c-fuel', -1000)] })).status).toBe(400);
    });
  });

  test('every refusal is a 400 (404 for unknown ids) and changes nothing', async () => {
    const { token } = await newToken('write');
    const ok = [line('c-groc', -1200), line('c-fuel', -1199)]; // t-02 is -2399
    const many = (n, total) => Array.from({ length: n }, (_, i) => line('c-groc', i === 0 ? total + (n - 1) : -1));
    await withServer(async (base) => {
      const cases = [
        ['t-04', ok, 400], // transfer
        ['t-11', [line('c-groc', -800), line('c-fuel', -700)], 400], // reconciled
        ['t-08', [line('c-groc', -400), line('c-fuel', -400)], 400], // closed account
        ['t-05c', ok, 404], // split child
        ['t-06', ok, 404], // tombstoned
        ['t-nope', ok, 404],
        ['bad%20id', ok, 400],
        ['t-02', [line('c-groc', -2399)], 400], // one line
        ['t-02', [], 400],
        ['t-02', many(51, -2399), 400], // 51 lines
        ['t-02', [line('c-groc', -1200), line('c-fuel', -1000)], 400], // sum short
        ['t-02', [line('c-groc', -1200), line('c-fuel', -1300)], 400], // sum over
        ['t-02', [line('c-groc', 1200), line('c-fuel', -3599)], 400], // wrong sign on a line
        ['t-02', [line('c-groc', 1200), line('c-fuel', 1199)], 400], // all wrong sign
        ['t-02', [line('c-groc', 0), line('c-fuel', -2399), line('c-fuel', 0)], 400], // zero amounts
        ['t-02', [line('c-groc', -1200.5), line('c-fuel', -1198.5)], 400], // non-integer
        ['t-02', [line('c-groc', '-1200'), line('c-fuel', -1199)], 400],
        ['t-02', [line('c-groc', -1200), line('c-nope', -1199)], 400], // unknown category
        ['t-02', [line('c-groc', -1200), line('c-hid', -1199)], 400], // hidden
        ['t-02', [line('c-groc', -1200), line('c-gone', -1199)], 400], // hidden group
        ['t-02', [line('c-groc', -1200), line('c-pay', -1199)], 400], // income
        ['t-02', [line('c-groc', -1200), line(null, -1199)], 400],
        ['t-02', [line('c-groc', -1200), line('bad id', -1199)], 400],
        ['t-02', [line('c-groc', -1200), line('c-fuel', -1199, 'x'.repeat(501))], 400],
        ['t-02', [line('c-groc', -1200), line('c-fuel', -1199, 7)], 400],
        ['t-02', [line('c-groc', -1200), { category: 'c-fuel', amount: -1199 }], 400], // notes missing
        ['t-02', [line('c-groc', -1200), { ...line('c-fuel', -1199), extra: 1 }], 400],
        ['t-02', [line('c-groc', -1200), 'x'], 400],
        ['t-02', [line('c-groc', -1200), null], 400],
      ];
      for (const [id, splits, status] of cases) {
        require('../../src/routes/mobile-v1').resetMobileV1State();
        const res = await put(base, token, id, { splits });
        expect([id, JSON.stringify(splits).slice(0, 80), res.status]).toEqual([id, JSON.stringify(splits).slice(0, 80), status]);
        expect(JSON.parse(await res.text())).toEqual({ error: status === 404 ? 'not_found' : 'bad_request' });
      }
      const bodies = [{}, { splits: ok, extra: 1 }, { splits: 'x' }, { splits: null }, [], 'null', '{broken', { splits: ok.concat([]), other: true }];
      for (const body of bodies) {
        const res = await put(base, token, 't-02', body);
        expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
        expect(await res.text()).toBe('{"error":"bad_request"}');
      }
      expect((await put(base, token, 't-02', undefined)).status).toBe(400);
      expect(client.updateTransaction).not.toHaveBeenCalled();
      expect(client.sync).not.toHaveBeenCalled();
      expect(auditLines()).toEqual([]);
    });
  });

  test('the response never echoes input on a refusal', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const res = await put(base, token, 't-02', { splits: [line('secret-category', -1, 'secret note'), line('c-fuel', -2398)] });
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(text).not.toContain('secret');
    });
  });

  test('DELETE un-splits: lines gone, amount kept, no category, usable again; a second DELETE is a 400', async () => {
    const { token, id } = await newToken('write');
    client.state.transactions.find((t) => t.id === 't-05').category = null;
    await withServer(async (base) => {
      // A transaction that had a category before it was split must not get it back.
      await put(base, token, 't-01', { splits: [line('c-fuel', -4000), line('c-groc', -4423)] });
      const res = await del(base, token, 't-01');
      expect(res.status).toBe(200);
      const { transaction } = await json(res, 'transactionDetailResponse');
      expect(transaction).toMatchObject({ id: 't-01', amount: -8423, split: false, category: null, splits: [] });
      expect(client.state.transactions.some((t) => t.parent_id === 't-01')).toBe(false);
      expect(client.state.transactions.find((t) => t.id === 't-01').category).toBeNull();
      const unsplit = auditLines().find((l) => l.op === 'transaction.unsplit');
      expect(unsplit).toEqual({ time: NOW.toISOString(), tokenId: id, op: 'transaction.unsplit', ids: { transaction: 't-01' }, amount: -8423, before: { splits: [{ category: 'c-fuel', amount: -4000, notesLength: 0 }, { category: 'c-groc', amount: -4423, notesLength: 0 }] }, after: { category: null, splits: [] } });

      const again = await del(base, token, 't-01');
      expect(again.status).toBe(400);
      expect(await again.text()).toBe('{"error":"bad_request"}');
      // And it can be categorised and split again.
      expect((await call(base, token, 'PATCH', '/transactions/t-01', { category: 'c-fuel' })).status).toBe(200);
      expect((await put(base, token, 't-01', { splits: [line('c-fuel', -8000), line('c-groc', -423)] })).status).toBe(200);
    });
  });

  test('DELETE refusals: not split, transfer, reconciled, closed account, split child, unknown', async () => {
    const { token } = await newToken('write');
    client.state.transactions.push({ id: 't-rs', date: '2026-11-03', account: 'a-chk', payee: 'p-grocer', category: null, amount: -100, notes: null, cleared: true, reconciled: true, is_parent: true });
    client.state.transactions.push({ id: 't-rs1', date: '2026-11-03', account: 'a-chk', payee: 'p-grocer', category: 'c-groc', amount: -100, notes: null, cleared: true, is_child: true, parent_id: 't-rs', sort_order: -1 });
    await withServer(async (base) => {
      for (const [id, status] of [['t-02', 400], ['t-04', 400], ['t-rs', 400], ['t-08', 400], ['t-05c', 404], ['t-06', 404], ['t-nope', 404], ['bad%20id', 400]]) {
        const res = await del(base, token, id);
        expect([id, res.status]).toEqual([id, status]);
      }
      expect(client.updateTransaction).not.toHaveBeenCalled();
      expect(auditLines()).toEqual([]);
    });
  });

  test('a failure after the first DELETE call leaves a consistent unsplit transaction and is reported as 500', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      await put(base, token, 't-01', { splits: [line('c-fuel', -4000), line('c-groc', -4423)] });
      const original = client.updateTransaction.getMockImplementation();
      client.updateTransaction.mockImplementationOnce(original).mockImplementationOnce(async () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); });
      const res = await del(base, token, 't-01');
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('{"error":"internal"}');
      const row = client.state.transactions.find((t) => t.id === 't-01');
      expect(row.is_parent).toBe(false);
      expect(client.state.transactions.some((t) => t.parent_id === 't-01')).toBe(false);
      expect(auditLines().map((l) => l.op)).toEqual(['transaction.split', 'transaction.unsplit']);
    });
  });

  test('writes are serialised with the others and accept a body of 50 long lines', async () => {
    const { token } = await newToken('write');
    client.state.transactions.push({ id: 't-big', date: '2026-11-02', account: 'a-chk', payee: 'p-grocer', category: null, amount: -5000, notes: null, cleared: true });
    await withServer(async (base) => {
      const splits = Array.from({ length: 50 }, (_, i) => line('c-groc', -100, 'n'.repeat(100)));
      const res = await put(base, token, 't-big', { splits });
      expect(res.status).toBe(200);
      expect((await json(res, 'transactionDetailResponse')).transaction.splits).toHaveLength(50);
    });
  });
});

describe('PUT /budget/:month/categories/:id', () => {
  test('sets the amount and answers with the category line and totals; audits before and after', async () => {
    const { token, id } = await newToken('write');
    await withServer(async (base) => {
      const res = await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 47500 });
      expect(res.status).toBe(200);
      const body = await json(res, 'budgetChangeResponse');
      expect(body.month).toBe('2026-11');
      expect(body.categories).toEqual([{ id: 'c-groc', name: 'Groceries', budgeted: 47500, spent: -9500, balance: 38000, carryover: false }]);
      expect(body.totals.budgeted).toBe(65500);
      expect(client.setBudgetAmount).toHaveBeenCalledWith('2026-11', 'c-groc', 47500);
      expect(client.sync).toHaveBeenCalledTimes(1);
      expect(auditLines()).toEqual([{ time: NOW.toISOString(), tokenId: id, op: 'budget.set', ids: { month: '2026-11', category: 'c-groc' }, before: { budgeted: 45000 }, after: { budgeted: 47500 } }]);
    });
  });

  test('zero and the maximum are allowed', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      expect((await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 0 })).status).toBe(200);
      expect((await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 1000000000000 })).status).toBe(200);
    });
  });

  test('validation: amounts, month window, categories; nothing changes', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const put = (url, body) => call(base, token, 'PUT', url, body);
      const ok = '/budget/2026-11/categories/c-groc';
      const bad = [
        [ok, { budgeted: -1 }], [ok, { budgeted: 1000000000001 }], [ok, { budgeted: 1.5 }], [ok, { budgeted: '5' }], [ok, { budgeted: null }], [ok, {}], [ok, { budgeted: 1, x: 1 }], [ok, [1]],
        ['/budget/2019-10/categories/c-groc', { budgeted: 1 }], ['/budget/2031-12/categories/c-groc', { budgeted: 1 }], ['/budget/2026-13/categories/c-groc', { budgeted: 1 }],
        ['/budget/2026-11/categories/c-hid', { budgeted: 1 }], ['/budget/2026-11/categories/c-gone', { budgeted: 1 }], ['/budget/2026-11/categories/c-pay', { budgeted: 1 }],
        ['/budget/2026-11/categories/bad%20id', { budgeted: 1 }],
      ];
      for (const [url, body] of bad) expect([url, JSON.stringify(body), (await put(url, body)).status]).toEqual([url, JSON.stringify(body), 400]);
      const missing = await put('/budget/2026-11/categories/c-nope', { budgeted: 1 });
      expect(missing.status).toBe(404);
      expect(client.setBudgetAmount).not.toHaveBeenCalled();
      expect(client.sync).not.toHaveBeenCalled();
      expect(auditLines()).toEqual([]);
    });
  });
});

describe('POST /budget/:month/move', () => {
  test('moves both amounts in one batch and answers from then to', async () => {
    const { token, id } = await newToken('write');
    await withServer(async (base) => {
      const res = await call(base, token, 'POST', '/budget/2026-11/move', { from: 'c-fuel', to: 'c-groc', amount: 2500 });
      expect(res.status).toBe(200);
      const body = await json(res, 'budgetChangeResponse');
      expect(body.categories).toEqual([
        { id: 'c-fuel', name: 'Fuel', budgeted: 15500, spent: -2800, balance: 12700, carryover: true },
        { id: 'c-groc', name: 'Groceries', budgeted: 47500, spent: -9500, balance: 38000, carryover: false },
      ]);
      expect(client.batchBudgetUpdates).toHaveBeenCalledTimes(1);
      expect(client.state.calls).toEqual([['batch'], ['setBudgetAmount', '2026-11', 'c-fuel', 15500], ['setBudgetAmount', '2026-11', 'c-groc', 47500]]);
      expect(client.sync).toHaveBeenCalledTimes(1);
      expect(auditLines()).toEqual([{ time: NOW.toISOString(), tokenId: id, op: 'budget.move', ids: { month: '2026-11', from: 'c-fuel', to: 'c-groc' }, amount: 2500, before: { from: 18000, to: 45000 }, after: { from: 15500, to: 47500 } }]);
    });
  });

  test('moving exactly the whole budgeted amount is allowed; one cent more is refused with 400', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const refused = await call(base, token, 'POST', '/budget/2026-11/move', { from: 'c-fuel', to: 'c-groc', amount: 18001 });
      expect(refused.status).toBe(400);
      expect(await refused.text()).toBe('{"error":"bad_request"}');
      expect(client.setBudgetAmount).not.toHaveBeenCalled();
      expect(client.sync).not.toHaveBeenCalled();
      expect(auditLines()).toEqual([]);
      expect((await call(base, token, 'POST', '/budget/2026-11/move', { from: 'c-fuel', to: 'c-groc', amount: 18000 })).status).toBe(200);
      expect(client.state.budget['2026-11']['c-fuel']).toBe(0);
    });
  });

  test('the current amounts are read fresh inside the lock: a second move of the same money is refused', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const move = () => call(base, token, 'POST', '/budget/2026-11/move', { from: 'c-fuel', to: 'c-groc', amount: 10000 });
      const results = await Promise.all([move(), move()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(client.state.budget['2026-11']).toMatchObject({ 'c-fuel': 8000, 'c-groc': 55000 });
    });
  });

  test('validation: same category, bad amounts, hidden/income/unknown categories, month window', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      const post = (url, body) => call(base, token, 'POST', url, body);
      const m = '/budget/2026-11/move';
      const bad = [
        [m, { from: 'c-fuel', to: 'c-fuel', amount: 1 }], [m, { from: 'c-fuel', to: 'c-groc', amount: 0 }], [m, { from: 'c-fuel', to: 'c-groc', amount: -5 }],
        [m, { from: 'c-fuel', to: 'c-groc', amount: 1.5 }], [m, { from: 'c-fuel', to: 'c-groc', amount: '5' }], [m, { from: 'c-fuel', to: 'c-groc', amount: 1000000000001 }],
        [m, { from: 'c-fuel', to: 'c-groc' }], [m, { from: 'c-fuel', to: 'c-groc', amount: 1, x: 1 }], [m, { from: 1, to: 'c-groc', amount: 1 }],
        [m, { from: 'c-hid', to: 'c-groc', amount: 1 }], [m, { from: 'c-fuel', to: 'c-pay', amount: 1 }], [m, { from: 'c-gone', to: 'c-groc', amount: 1 }],
        ['/budget/2031-12/move', { from: 'c-fuel', to: 'c-groc', amount: 1 }], ['/budget/2026-14/move', { from: 'c-fuel', to: 'c-groc', amount: 1 }],
      ];
      for (const [url, body] of bad) expect([url, JSON.stringify(body), (await post(url, body)).status]).toEqual([url, JSON.stringify(body), 400]);
      expect((await post(m, { from: 'c-nope', to: 'c-groc', amount: 1 })).status).toBe(404);
      expect(client.setBudgetAmount).not.toHaveBeenCalled();
      expect(auditLines()).toEqual([]);
    });
  });
});

describe('write serialisation and the audit log', () => {
  test('concurrent writes run one at a time, in arrival order', async () => {
    const { token } = await newToken('write');
    const log = [];
    let running = 0;
    let maxRunning = 0;
    client.setBudgetAmount.mockImplementation(async (month, id, amount) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${amount}`);
      await new Promise((r) => setTimeout(r, 15));
      log.push(`end ${amount}`);
      client.state.budget[month][id] = amount;
      running -= 1;
    });
    await withServer(async (base) => {
      client.state.budget['2026-11'] = { 'c-groc': 1, 'c-fuel': 1, 'c-pay': 0 };
      const all = await Promise.all([1, 2, 3, 4].map((n) => call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: n * 100 })));
      expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(maxRunning).toBe(1);
      for (let i = 0; i < log.length; i += 2) expect(log[i].replace('start', 'end')).toBe(log[i + 1]);
      expect(auditLines().map((l) => l.after.budgeted).sort()).toEqual([100, 200, 300, 400]);
      expect(client.sync).toHaveBeenCalledTimes(4);
    });
  });

  test('a failed write does not wedge the queue', async () => {
    const { token } = await newToken('write');
    client.updateTransaction.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EBOOM' }));
    await withServer(async (base) => {
      const first = await call(base, token, 'PATCH', '/transactions/t-02', { category: 'c-groc' });
      expect(first.status).toBe(500);
      expect(await first.text()).toBe('{"error":"internal"}');
      expect((await call(base, token, 'PATCH', '/transactions/t-02', { category: 'c-groc' })).status).toBe(200);
    });
  });

  test('audit lines never contain the token, and an unwritable audit log does not fail the write', async () => {
    const { token } = await newToken('write');
    await withServer(async (base) => {
      await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 1 });
      await call(base, token, 'POST', '/budget/2026-11/move', { from: 'c-groc', to: 'c-fuel', amount: 1 });
      await call(base, token, 'PATCH', '/transactions/t-02', { category: 'c-groc' });
      const raw = fs.readFileSync(AUDIT, 'utf8');
      expect(raw.trim().split('\n')).toHaveLength(3);
      expect(raw).not.toContain(token);
      expect(raw).not.toMatch(/Bearer/i);
      expect(fs.statSync(AUDIT).mode & 0o077).toBe(0);

      fs.rmSync(AUDIT);
      fs.mkdirSync(AUDIT); // appending to a directory fails
      const res = await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 9 });
      expect(res.status).toBe(200);
      expect(console.error).toHaveBeenCalledWith('mobile audit: could not append to the audit log:', expect.any(String));
      fs.rmdirSync(AUDIT);
    });
  });

  test('the token never reaches the logs, even when things fail', async () => {
    const { token } = await newToken('write');
    client.getBudgetMonth.mockRejectedValue(Object.assign(new Error(`leak ${token}`), { code: 'EFAIL' }));
    await withServer(async (base) => {
      await get(base, token, '/budget/2026-11');
      await call(base, token, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 1 });
    });
    const logged = JSON.stringify(console.error.mock.calls);
    expect(logged).not.toContain(token);
  });
});

describe('token bookkeeping', () => {
  test('a successful v1 request records lastUsedAt', async () => {
    const { token, id } = await newToken('read');
    await withServer(async (base) => {
      await get(base, token, '/me');
      await new Promise((r) => setTimeout(r, 30));
      expect((await store.listTokens(DATA_DIR)).find((t) => t.id === id).lastUsedAt).toBe(NOW.toISOString());
    });
  });
});
