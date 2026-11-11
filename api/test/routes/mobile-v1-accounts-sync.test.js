const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-sync-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const store = require('../../src/mobile-tokens-store');
const { expectValid, examples, makeFakeActual } = require('../helpers/native-v1');

const NOW = new Date(2026, 10, 12, 15, 0, 0);
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
const call = (base, token, method, url, body, extra = {}) =>
  fetch(`${base}/api/mobile/v1${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (base, token, url) => call(base, token, 'GET', url);
async function json(res, definition) {
  const body = await res.json();
  if (definition) expectValid(definition, body);
  return body;
}
const auditLines = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
let writeToken;
let readToken;

beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  fs.rmSync(AUDIT, { force: true });
  writeToken = (await store.createToken('w', DATA_DIR, { scope: 'write' })).token;
  readToken = (await store.createToken('r', DATA_DIR, { scope: 'read' })).token;
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



const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  client.runBankSync = jest.fn(async () => {});
  delete process.env.INSIGHTS_BANK_SYNC_TIMEOUT_MS;
});

describe('POST /accounts/sync', () => {
  test('runs the bank sync for all accounts (no account id), syncs, audits and answers the contract shape', async () => {
    await withServer(async (base) => {
      const res = await call(base, writeToken, 'POST', '/accounts/sync', {});
      expect(res.status).toBe(200);
      const body = await json(res, 'accountsSyncResponse');
      expect(body).toEqual({ schema: 1, ok: true, syncedAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(body.syncedAt))).toBe(false);
      expect(client.runBankSync).toHaveBeenCalledTimes(1);
      expect(client.runBankSync).toHaveBeenCalledWith();
      expect(client.sync).toHaveBeenCalled();
      const lines = auditLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ op: 'accounts.sync', tokenId: expect.any(String) });
      expect(Object.keys(lines[0]).sort()).toEqual(['op', 'time', 'tokenId']);
      expect(JSON.stringify(lines[0])).not.toContain(writeToken);
    });
  });

  test('the example request validates and the example response matches the schema', () => {
    expectValid('accountsSyncRequest', examples.accountsSyncRequest);
    expectValid('accountsSyncResponse', examples.accountsSyncResponse);
  });

  test('a read token is 403 read_only and nothing runs', async () => {
    await withServer(async (base) => {
      const res = await call(base, readToken, 'POST', '/accounts/sync', {});
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'read_only' });
      expect(client.runBankSync).not.toHaveBeenCalled();
    });
  });

  test('no token is 401', async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/mobile/v1/accounts/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(401);
    });
  });

  test.each([[{ a: 1 }], [[]], [null], ['x'], [1]])('body %j is 400 bad_request and nothing runs', async (bad) => {
    await withServer(async (base) => {
      const res = await call(base, writeToken, 'POST', '/accounts/sync', bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
      expect(client.runBankSync).not.toHaveBeenCalled();
    });
  });

  test('a second request while one is running is 409 busy at once; afterwards a new one works', async () => {
    const gate = deferred();
    client.runBankSync.mockImplementationOnce(() => gate.promise);
    await withServer(async (base) => {
      const first = call(base, writeToken, 'POST', '/accounts/sync', {});
      await tick();
      const second = await call(base, writeToken, 'POST', '/accounts/sync', {});
      expect(second.status).toBe(409);
      expect(await json(second, 'error')).toEqual({ error: 'busy' });
      expect(client.runBankSync).toHaveBeenCalledTimes(1);
      gate.resolve();
      expect((await first).status).toBe(200);
      expect((await call(base, writeToken, 'POST', '/accounts/sync', {})).status).toBe(200);
      expect(client.runBankSync).toHaveBeenCalledTimes(2);
    });
  });

  test('runBankSync throwing is 502 bank_sync_failed, nothing echoed, not audited, flag cleared', async () => {
    client.runBankSync.mockRejectedValueOnce(Object.assign(new Error('SECRET bank detail Acct 12345'), { code: 'ITEM_LOGIN_REQUIRED' }));
    await withServer(async (base) => {
      const res = await call(base, writeToken, 'POST', '/accounts/sync', {});
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'bank_sync_failed' });
      expectValid('error', JSON.parse(text));
      expect(text).not.toMatch(/SECRET|12345/);
      expect(auditLines()).toEqual([]);
      const logged = JSON.stringify(console.error.mock.calls);
      expect(logged).toContain('ITEM_LOGIN_REQUIRED');
      expect(logged).not.toMatch(/SECRET|12345/);
      // imported transactions are picked up even after an error
      expect(client.sync).toHaveBeenCalled();
      expect((await call(base, writeToken, 'POST', '/accounts/sync', {})).status).toBe(200);
    });
  });

  test('the server-side timeout answers 502 bank_sync_failed, frees the flag and the write lock', async () => {
    process.env.INSIGHTS_BANK_SYNC_TIMEOUT_MS = '60';
    client.runBankSync.mockImplementationOnce(() => new Promise(() => {}));
    await withServer(async (base) => {
      const res = await call(base, writeToken, 'POST', '/accounts/sync', {});
      expect(res.status).toBe(502);
      expect(await json(res, 'error')).toEqual({ error: 'bank_sync_failed' });
      expect(JSON.stringify(console.error.mock.calls)).toContain('timeout');
      // flag cleared and the write lock released: the next sync and another write both go through
      expect((await call(base, writeToken, 'POST', '/accounts/sync', {})).status).toBe(200);
      expect((await call(base, writeToken, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 777 })).status).toBe(200);
    });
  });

  test('a late rejection after the timeout is swallowed (no unhandled rejection)', async () => {
    process.env.INSIGHTS_BANK_SYNC_TIMEOUT_MS = '30';
    const gate = deferred();
    client.runBankSync.mockImplementationOnce(() => gate.promise);
    await withServer(async (base) => {
      expect((await call(base, writeToken, 'POST', '/accounts/sync', {})).status).toBe(502);
      gate.reject(new Error('late'));
      await tick();
    });
  });

  test('clears the read cache on success and on failure (partial imports show up at once)', async () => {
    await withServer(async (base) => {
      const total = async () => JSON.stringify(await (await get(base, writeToken, '/accounts')).json());
      const chk = () => client.state.accounts.find((a) => a.id === 'a-chk');
      const first = await total();
      chk().balance += 5000; // cached: the read still shows the old figure
      expect(await total()).toBe(first);
      client.runBankSync.mockImplementationOnce(async () => {});
      expect((await call(base, writeToken, 'POST', '/accounts/sync', {})).status).toBe(200);
      const second = await total();
      expect(second).not.toBe(first);
      chk().balance += 5000;
      expect(await total()).toBe(second);
      client.runBankSync.mockRejectedValueOnce(new Error('x'));
      expect((await call(base, writeToken, 'POST', '/accounts/sync', {})).status).toBe(502);
      expect(await total()).not.toBe(second);
    });
  });

  test('is counted against the write rate limit (20 a minute)', async () => {
    await withServer(async (base) => {
      for (let i = 0; i < 20; i++) expect((await call(base, writeToken, 'POST', '/accounts/sync', {})).status).toBe(200);
      const limited = await call(base, writeToken, 'POST', '/accounts/sync', {});
      expect(limited.status).toBe(429);
      expect(await json(limited, 'error')).toEqual({ error: 'rate_limited' });
      expect(client.runBankSync).toHaveBeenCalledTimes(20);
    });
  });

  test('is serialised with other writes: a budget write sent during a sync waits for it', async () => {
    const gate = deferred();
    client.runBankSync.mockImplementationOnce(() => gate.promise);
    await withServer(async (base) => {
      const sync = call(base, writeToken, 'POST', '/accounts/sync', {});
      await tick();
      let putDone = false;
      const put = call(base, writeToken, 'PUT', '/budget/2026-11/categories/c-groc', { budgeted: 4242 }).then((r) => { putDone = true; return r; });
      await tick();
      await tick();
      expect(putDone).toBe(false);
      expect(client.setBudgetAmount).not.toHaveBeenCalled();
      gate.resolve();
      expect((await sync).status).toBe(200);
      expect((await put).status).toBe(200);
      expect(client.setBudgetAmount).toHaveBeenCalled();
    });
  });

  test('existing routes are unchanged: /accounts still answers the accounts contract', async () => {
    await withServer(async (base) => {
      const res = await get(base, readToken, '/accounts');
      expect(res.status).toBe(200);
      await json(res, 'accountsResponse');
    });
  });
});
