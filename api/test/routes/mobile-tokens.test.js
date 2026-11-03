const fs = require('fs');
const os = require('os');
const path = require('path');

// The store reads its data dir when it is first loaded.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-tokens-route-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

jest.mock('../../src/actual-client');
jest.mock('../../src/auth');

const { validateToken } = require('../../src/auth');

const SESSION = 'valid-session-token';
const SESSION_HEADERS = { 'X-ACTUAL-TOKEN': SESSION };
const JSON_HEADERS = { ...SESSION_HEADERS, 'Content-Type': 'application/json' };

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

const post = (base, body, headers = JSON_HEADERS) => fetch(`${base}/api/mobile/tokens`, { method: 'POST', headers, body: JSON.stringify(body) });

beforeEach(() => {
  validateToken.mockReset();
  validateToken.mockImplementation(async (token) => token === SESSION);
  fs.rmSync(path.join(DATA_DIR, 'mobile-tokens.json'), { force: true });
});

test('every management route needs an Actual session token', async () => {
  await withServer(async (base) => {
    for (const [method, url] of [['GET', '/api/mobile/tokens'], ['POST', '/api/mobile/tokens'], ['DELETE', '/api/mobile/tokens/abc']]) {
      const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{"label":"x"}' : undefined });
      expect(res.status).toBe(401);
    }
  });
});

test('POST creates a token and returns the plain secret once, uncached', async () => {
  await withServer(async (base) => {
    const res = await post(base, { label: 'Ann phone' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'id', 'label', 'token']);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.label).toBe('Ann phone');
  });
});

test('GET lists tokens without any secret, and the plain token is not on disk', async () => {
  await withServer(async (base) => {
    const { token, id } = await (await post(base, { label: 'phone' })).json();
    const res = await fetch(`${base}/api/mobile/tokens`, { headers: SESSION_HEADERS });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual({ tokens: [{ id, label: 'phone', createdAt: expect.any(String), lastUsedAt: null }] });
    expect(fs.readFileSync(path.join(DATA_DIR, 'mobile-tokens.json'), 'utf8')).not.toContain(token);
  });
});

test('POST validates the label and caps tokens at 10', async () => {
  await withServer(async (base) => {
    expect((await post(base, {})).status).toBe(400);
    expect((await post(base, { label: '' })).status).toBe(400);
    expect((await post(base, { label: 'x'.repeat(61) })).status).toBe(400);
    for (let i = 0; i < 10; i++) expect((await post(base, { label: `d${i}` })).status).toBe(201);
    const res = await post(base, { label: 'eleventh' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'token limit reached (10)' });
  });
});

test('DELETE revokes at once; an unknown id is 404', async () => {
  await withServer(async (base) => {
    const { id } = await (await post(base, { label: 'phone' })).json();
    const res = await fetch(`${base}/api/mobile/tokens/${id}`, { method: 'DELETE', headers: SESSION_HEADERS });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect((await (await fetch(`${base}/api/mobile/tokens`, { headers: SESSION_HEADERS })).json()).tokens).toEqual([]);
    expect((await fetch(`${base}/api/mobile/tokens/${id}`, { method: 'DELETE', headers: SESSION_HEADERS })).status).toBe(404);
  });
});

test('a device token cannot manage device tokens, in either header', async () => {
  await withServer(async (base) => {
    const { token } = await (await post(base, { label: 'phone' })).json();
    for (const headers of [{ 'X-ACTUAL-TOKEN': token }, { Authorization: `Bearer ${token}` }]) {
      expect((await fetch(`${base}/api/mobile/tokens`, { headers })).status).toBe(401);
      expect((await fetch(`${base}/api/mobile/tokens`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"label":"x"}' })).status).toBe(401);
      expect((await fetch(`${base}/api/mobile/tokens/x`, { method: 'DELETE', headers })).status).toBe(401);
    }
  });
});
