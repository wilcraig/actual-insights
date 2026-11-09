const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v1-ent-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');

const { validateToken } = require('../../src/auth');
const store = require('../../src/mobile-tokens-store');
const ent = require('../../src/chipmunk/entitlement');
const { makeChain, signTransaction } = require('../helpers/apple-test-chain');
const { expectValid, examples } = require('../helpers/native-v1');

const STATE_FILE = path.join(DATA_DIR, 'chipmunk-entitlement.json');
const V1 = '/api/mobile/v1';
let chain;
let logs;

async function withServer(fn) {
  require('../../src/routes/mobile-v1').resetMobileV1State();
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
  fetch(`${base}${V1}${url}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const newToken = async (scope = 'read') => store.createToken('phone', DATA_DIR, { scope });

beforeAll(() => { chain = makeChain('route'); });
beforeEach(async () => {
  for (const t of await store.listTokens(DATA_DIR)) await store.revokeToken(t.id, DATA_DIR);
  fs.rmSync(STATE_FILE, { force: true });
  delete process.env.CHIPMUNK_ENTITLEMENT_MODE;
  delete process.env.CHIPMUNK_PLAY_PUBLIC_KEY;
  ent.setAppleRootsForTests([chain.rootDer]);
  ent.resetAnnouncement();
  validateToken.mockReset();
  validateToken.mockResolvedValue(false);
  logs = [];
  for (const m of ['log', 'warn', 'error', 'info']) jest.spyOn(console, m).mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => {
  for (const m of ['log', 'warn', 'error', 'info']) console[m].mockRestore();
});

describe('POST/GET /entitlement', () => {
  test('need a device token', async () => {
    await withServer(async (base) => {
      expect((await call(base, null, 'GET', '/entitlement')).status).toBe(401);
      expect((await call(base, null, 'POST', '/entitlement', examples.entitlementRequest)).status).toBe(401);
      expect((await call(base, 'nope', 'GET', '/entitlement')).status).toBe(401);
    });
  });

  test('GET before any proof answers none, per contract, uncached', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const res = await call(base, token, 'GET', '/entitlement');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expectValid('entitlementResponse', body);
      expect(body).toEqual(examples.entitlementResponseNone);
    });
  });

  test('a read-scope token can post a valid proof; GET then reflects it and the web mode sees it', async () => {
    const { token } = await newToken('read');
    const proof = signTransaction(chain);
    await withServer(async (base) => {
      const res = await call(base, token, 'POST', '/entitlement', { platform: 'apple', proof });
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('entitlementResponse', body);
      expect(body).toMatchObject({ entitled: true, reason: 'verified' });
      const got = await (await call(base, token, 'GET', '/entitlement')).json();
      expect(got).toEqual(body);
      expect((await ent.chipmunkEntitled()).entitled).toBe(true);
    });
    expect(logs.join('\n')).not.toContain(proof.split('.')[2]);
    expect(fs.readFileSync(STATE_FILE, 'utf8')).not.toContain(proof.split('.')[2]);
  });

  test('a bad signature is 200 unverified; an expired genuine proof is 200 expired; response never echoes input', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const forged = signTransaction(makeChain('forger'));
      let res = await call(base, token, 'POST', '/entitlement', { platform: 'apple', proof: forged });
      expect(res.status).toBe(200);
      const bad = await res.json();
      expectValid('entitlementResponse', bad);
      expect(bad).toEqual({ schema: 1, entitled: false, reason: 'unverified', lastVerifiedAt: null, validUntil: null });
      expect(JSON.stringify(bad)).not.toContain(forged.slice(0, 20));

      res = await call(base, token, 'POST', '/entitlement', { platform: 'apple', proof: signTransaction(chain, { expiresDate: Date.now() - 30 * 24 * 3600 * 1000 }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ entitled: false, reason: 'expired' });
    });
  });

  test('google without a configured key answers not_configured (200)', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const res = await call(base, token, 'POST', '/entitlement', examples.entitlementRequestGoogle);
      expect(res.status).toBe(200);
      const body = await res.json();
      expectValid('entitlementResponse', body);
      expect(body.reason).toBe('not_configured');
    });
  });

  test('invalid bodies are 400 { error: bad_request } and never echoed', async () => {
    const { token } = await newToken();
    const long = 'x'.repeat(16385);
    const bodies = [
      '{nope',
      '[]',
      'null',
      {},
      { platform: 'apple' },
      { platform: 'apple', proof: '' },
      { platform: 'apple', proof: 5 },
      { platform: 'apple', proof: long },
      { platform: 'apple', proof: 'a.b.c', signature: 'x' },
      { platform: 'apple', proof: 'a.b.c', extra: 1 },
      { platform: 'google', proof: '{}' },
      { platform: 'google', proof: '{}', signature: '' },
      { platform: 'google', proof: '{}', signature: 'y'.repeat(2049) },
      { platform: 'windows', proof: 'a' },
      { proof: 'a.b.c' },
    ];
    await withServer(async (base) => {
      for (const body of bodies) {
        const res = await call(base, token, 'POST', '/entitlement', body);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'bad_request' });
      }
      // Wrong content type -> no parsed body -> 400.
      const res = await fetch(`${base}${V1}/entitlement`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'platform=apple' });
      expect(res.status).toBe(400);
      // Too large for the parser.
      expect((await call(base, token, 'POST', '/entitlement', JSON.stringify({ platform: 'apple', proof: 'z'.repeat(70000) }))).status).toBe(400);
      expect((await call(base, token, 'GET', '/entitlement?x=1')).status).toBe(400);
    });
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  test('a maximum-size proof within the contract limit is processed, not rejected', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      const res = await call(base, token, 'POST', '/entitlement', { platform: 'apple', proof: 'a'.repeat(16384) });
      expect(res.status).toBe(200);
      expect((await res.json()).reason).toBe('unverified');
    });
  });

  test('POST shares the write rate limit (20 a minute), GET the read limit', async () => {
    const { token } = await newToken();
    await withServer(async (base) => {
      for (let i = 0; i < 20; i++) expect((await call(base, token, 'POST', '/entitlement', { platform: 'apple', proof: 'a.b.c' })).status).toBe(200);
      const limited = await call(base, token, 'POST', '/entitlement', { platform: 'apple', proof: 'a.b.c' });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: 'rate_limited' });
      expect(limited.headers.get('retry-after')).toBeTruthy();
      // Reads are a separate bucket.
      expect((await call(base, token, 'GET', '/entitlement')).status).toBe(200);
    });
  });

  test('dev mode accepts an Xcode-style unsigned proof; open mode is entitled', async () => {
    const { token } = await newToken();
    const { b64url } = require('../helpers/apple-test-chain');
    const unsigned = `${b64url({ alg: 'ES256' })}.${b64url({ bundleId: 'app.chipmunkbudget.chipmunk', productId: 'chipmunk.monthly', originalTransactionId: '1', expiresDate: Date.now() + 86400000 })}.c2ln`;
    process.env.CHIPMUNK_ENTITLEMENT_MODE = 'dev';
    await withServer(async (base) => {
      expect(await (await call(base, token, 'POST', '/entitlement', { platform: 'apple', proof: unsigned })).json()).toMatchObject({ entitled: true, reason: 'verified' });
    });
    fs.rmSync(STATE_FILE, { force: true });
    process.env.CHIPMUNK_ENTITLEMENT_MODE = 'open';
    await withServer(async (base) => {
      const body = await (await call(base, token, 'GET', '/entitlement')).json();
      expectValid('entitlementResponse', body);
      expect(body).toMatchObject({ entitled: true, reason: 'verified', lastVerifiedAt: null });
    });
  });
});
