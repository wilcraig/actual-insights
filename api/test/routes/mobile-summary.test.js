const fs = require('fs');
const os = require('os');
const path = require('path');
const Ajv = require('ajv');

// The token store reads its data dir when first loaded.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-summary-route-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');
jest.mock('../../src/mobile/summary');

const { getActualClient, syncIfDue } = require('../../src/actual-client');
const { validateToken } = require('../../src/auth');
const { buildMobileSummary } = require('../../src/mobile/summary');
const store = require('../../src/mobile-tokens-store');

const SESSION = 'valid-session-token';
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'mobile-summary.example.json'), 'utf8'));
const NOW = new Date('2026-11-12T15:00:00.000Z');

function loadApp() {
  const router = require('../../src/routes/mobile-summary');
  router.resetMobileSummaryState();
  return require('../../src/server');
}

async function withServer(fn) {
  const app = loadApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const get = (base, token, extra = {}) => fetch(`${base}/api/mobile/summary`, { headers: token ? { Authorization: `Bearer ${token}`, ...extra } : extra });

async function newToken(label = 'phone') {
  const created = await store.createToken(label, DATA_DIR);
  return created;
}

beforeEach(async () => {
  // Through the store, not rm: a fire-and-forget lastUsedAt write from the
  // previous test may still be queued, and the store serializes with it.
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  validateToken.mockReset();
  validateToken.mockImplementation(async (token) => token === SESSION);
  getActualClient.mockReset();
  getActualClient.mockResolvedValue({});
  syncIfDue.mockReset();
  syncIfDue.mockResolvedValue(undefined);
  buildMobileSummary.mockReset();
  buildMobileSummary.mockImplementation(async () => ({ ...EXAMPLE }));
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('authentication', () => {
  test('a valid device token gets the payload', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const res = await get(base, token);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual(EXAMPLE);
    });
  });

  test('missing, garbage, wrong-scheme, malformed and revoked tokens all get the identical 401', async () => {
    const { token, id } = await newToken();
    const revoked = await newToken('old');
    await store.revokeToken(revoked.id, DATA_DIR);
    await withServer(async (base) => {
      const attempts = [
        {},
        { Authorization: '' },
        { Authorization: 'Bearer' },
        { Authorization: 'Bearer garbage' },
        { Authorization: `Bearer ${'A'.repeat(43)}` },
        { Authorization: `Basic ${token}` },
        { Authorization: token },
        { Authorization: `Bearer ${token} extra` },
        { Authorization: `Bearer ${token.slice(0, -1)}` },
        { Authorization: `Bearer ${revoked.token}` },
        { Authorization: `Bearer ${'x'.repeat(5000)}` },
      ];
      const seen = [];
      for (const headers of attempts) {
        const res = await fetch(`${base}/api/mobile/summary`, { headers });
        seen.push({ status: res.status, body: await res.text(), authenticate: res.headers.get('www-authenticate') });
      }
      expect(seen.every((r) => r.status === 401)).toBe(true);
      expect(new Set(seen.map((r) => r.body)).size).toBe(1);
      expect(new Set(seen.map((r) => r.authenticate)).size).toBe(1);
      expect(JSON.parse(seen[0].body)).toEqual({ error: 'unauthorized' });
      expect(buildMobileSummary).not.toHaveBeenCalled();
      // The good token is unaffected by the bad ones.
      expect((await get(base, token)).status).toBe(200);
      expect(id).toBeTruthy();
    });
  });

  test('revoking a token cuts it off on the very next request', async () => {
    const { token, id } = await newToken();
    await withServer(async (base) => {
      expect((await get(base, token)).status).toBe(200);
      await store.revokeToken(id, DATA_DIR);
      const res = await get(base, token);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    });
  });

  test('an Actual session token alone is NOT accepted here (decision: device token only)', async () => {
    await withServer(async (base) => {
      for (const headers of [{ 'X-ACTUAL-TOKEN': SESSION }, { Authorization: `Bearer ${SESSION}` }, { 'X-ACTUAL-TOKEN': SESSION, Authorization: `Bearer ${SESSION}` }]) {
        const res = await fetch(`${base}/api/mobile/summary`, { headers });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
      }
      expect(validateToken).not.toHaveBeenCalled();
    });
  });

  test('a valid device token does not need, and is not mistaken for, a session', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      await get(base, token);
      expect(validateToken).not.toHaveBeenCalled();
    });
  });

  test('only GET is served here; other methods and sub-paths fall through to the session guard', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      for (const [method, url] of [['POST', '/api/mobile/summary'], ['DELETE', '/api/mobile/summary'], ['GET', '/api/mobile/summary/extra'], ['GET', '/api/mobile/summary/../tokens']]) {
        const res = await fetch(`${base}${url}`, { method, headers: { Authorization: `Bearer ${token}` } });
        expect(res.status).toBe(401);
      }
    });
  });
});

describe('a device token is useless everywhere else', () => {
  // Every router server.js mounts under /api, found by reading the file, so
  // a route added later is covered without anyone remembering to list it.
  const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'server.js'), 'utf8');
  const mounts = [...serverSource.matchAll(/app\.use\('(\/api\/[^']+)'/g)].map((m) => m[1]);

  test('the mount list was found and includes the routes we know about', () => {
    expect(mounts.length).toBeGreaterThan(15);
    for (const known of ['/api/accounts', '/api/goals', '/api/channels', '/api/forecast', '/api/summaries', '/api/mobile/tokens']) expect(mounts).toContain(known);
  });

  test.each(mounts.filter((m) => m !== '/api/mobile/summary'))('%s rejects a device token in either header with 401', async (mount) => {
    const { token } = await newToken();
    await withServer(async (base) => {
      for (const headers of [{ Authorization: `Bearer ${token}` }, { 'X-ACTUAL-TOKEN': token }, { Authorization: `Bearer ${token}`, 'X-ACTUAL-TOKEN': token }]) {
        for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
          const res = await fetch(`${base}${mount}`, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
          expect(res.status).toBe(401);
        }
      }
    });
  });

  test('an unknown /api path is 401 for a device token, not a 404 that reveals routes', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/does-not-exist`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    });
  });
});

describe('rate limit', () => {
  test('60 requests a minute per token, then 429 with Retry-After', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      for (let i = 0; i < 60; i++) expect((await get(base, token)).status).toBe(200);
      const limited = await get(base, token);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: 'rate limited' });
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    });
  });

  test('the allowance is per token and refills as the window slides', async () => {
    const a = await newToken('a');
    const b = await newToken('b');
    await withServer(async (base) => {
      for (let i = 0; i < 60; i++) await get(base, a.token);
      expect((await get(base, a.token)).status).toBe(429);
      expect((await get(base, b.token)).status).toBe(200);
      jest.setSystemTime(new Date(NOW.getTime() + 61 * 1000));
      expect((await get(base, a.token)).status).toBe(200);
    });
  });

  test('bad tokens never use up a real token\'s allowance', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      for (let i = 0; i < 100; i++) await get(base, 'x'.repeat(43));
      for (let i = 0; i < 60; i++) expect((await get(base, token)).status).toBe(200);
    });
  });

  test('a rate-limited request does not rebuild the payload', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      for (let i = 0; i < 61; i++) await get(base, token);
      expect(buildMobileSummary).toHaveBeenCalledTimes(1);
    });
  });
});

describe('server-side cache', () => {
  test('the payload is computed once a minute, however many requests', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      await get(base, token);
      await get(base, token);
      jest.setSystemTime(new Date(NOW.getTime() + 59 * 1000));
      await get(base, token);
      expect(buildMobileSummary).toHaveBeenCalledTimes(1);
      jest.setSystemTime(new Date(NOW.getTime() + 61 * 1000));
      await get(base, token);
      expect(buildMobileSummary).toHaveBeenCalledTimes(2);
    });
  });

  test('simultaneous requests share one build, and one device\'s data is served to another', async () => {
    const a = await newToken('a');
    const b = await newToken('b');
    let release;
    buildMobileSummary.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ...EXAMPLE }); }));
    await withServer(async (base) => {
      const inflight = [get(base, a.token), get(base, b.token), get(base, a.token)];
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const responses = await Promise.all(inflight);
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(buildMobileSummary).toHaveBeenCalledTimes(1);
    });
  });

  test('a failed build answers 500 without internals and is not cached', async () => {
    const { token } = await newToken();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    buildMobileSummary.mockRejectedValueOnce(new Error('secret stack detail'));
    await withServer(async (base) => {
      const failed = await get(base, token);
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: 'internal error' });
      expect((await get(base, token)).status).toBe(200);
    });
    errorSpy.mockRestore();
  });

  test('syncs with Actual before building', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      await get(base, token);
      expect(syncIfDue).toHaveBeenCalledTimes(1);
    });
  });
});

describe('token bookkeeping', () => {
  test('a successful request records lastUsedAt', async () => {
    const { token, id } = await newToken();
    expect((await store.listTokens(DATA_DIR))[0].lastUsedAt).toBeNull();
    await withServer(async (base) => {
      await get(base, token);
      // touch is fire-and-forget; give it a moment
      await new Promise((resolve) => setTimeout(resolve, 100));
      const listed = (await store.listTokens(DATA_DIR)).find((t) => t.id === id);
      expect(listed.lastUsedAt).toBe(NOW.toISOString());
    });
  });

  test('a failed request does not touch lastUsedAt', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      await get(base, 'garbage');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await store.listTokens(DATA_DIR))[0].lastUsedAt).toBeNull();
      expect(token).toBeTruthy();
    });
  });
});

describe('hygiene', () => {
  test('no CORS headers on success, failure, or a preflight', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const responses = [
        await get(base, token, { Origin: 'https://evil.example.com' }),
        await get(base, 'garbage', { Origin: 'https://evil.example.com' }),
        await fetch(`${base}/api/mobile/summary`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } }),
      ];
      for (const res of responses) {
        const cors = [...res.headers.keys()].filter((h) => h.startsWith('access-control-'));
        expect(cors).toEqual([]);
      }
    });
  });

  test('the token is never logged, even when things go wrong', async () => {
    const { token } = await newToken();
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    buildMobileSummary.mockRejectedValueOnce(Object.assign(new Error(`failed for ${token}`), { code: 'ESOMETHING' }));
    await withServer(async (base) => {
      await get(base, token);
      await get(base, `${token}x`);
      await get(base, token);
    });
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toContain(token);
  });
});

describe('the real payload through the real route', () => {
  test('validates against the published schema', async () => {
    jest.dontMock('../../src/mobile/summary');
    const { buildMobileSummary: real } = jest.requireActual('../../src/mobile/summary');
    const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'mobile-summary.schema.json'), 'utf8'));
    const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
    const ORIGINAL_TZ = process.env.TZ;
    process.env.TZ = 'America/Denver';
    const client = {
      getBudgetMonth: async () => ({ totalIncome: 400000, totalSpent: -90000, categoryGroups: [{ id: 'g', name: 'Bills', categories: [{ id: 'c', name: 'Rent', budgeted: 100000, spent: -90000, balance: 10000 }] }] }),
      getAccounts: async () => [{ id: 'a1', name: 'Everyday Checking', offbudget: false, closed: false }],
      getAccountBalance: async () => 250000,
      getSchedules: async () => [],
      getRules: async () => [],
      getPayees: async () => [],
      getCategoryGroups: async () => [],
      aqlQuery: async () => ({ data: [] }),
    };
    buildMobileSummary.mockImplementation((args) => real({ ...args, dataDir: DATA_DIR }));
    getActualClient.mockResolvedValue(client);
    const { token } = await newToken();
    try {
      await withServer(async (base) => {
        const res = await get(base, token);
        expect(res.status).toBe(200);
        const payload = await res.json();
        const ok = validate(payload);
        if (!ok) throw new Error(JSON.stringify(validate.errors));
        expect(payload.accounts).toEqual([{ id: 'a1', name: 'Everyday Checking', balance: 250000, onBudget: true }]);
        expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(8 * 1024);
      });
    } finally {
      process.env.TZ = ORIGINAL_TZ;
    }
  });
});
