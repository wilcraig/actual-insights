const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const store = require('../src/mobile-tokens-store');

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mobile-tokens-test-'));
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('listTokens is empty before anything is created', async () => {
  const dir = await tmpDir();
  expect(await store.listTokens(dir)).toEqual([]);
});

test('createToken returns the plain token once: 32 random bytes as base64url', async () => {
  const dir = await tmpDir();
  const result = await store.createToken('My phone', dir);
  expect(result.ok).toBe(true);
  expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(result.token, 'base64url')).toHaveLength(32);
  expect(result.id).toEqual(expect.any(String));
  expect(result.label).toBe('My phone');
  expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
});

test('two tokens never match', async () => {
  const dir = await tmpDir();
  const a = await store.createToken('a', dir);
  const b = await store.createToken('b', dir);
  expect(a.token).not.toBe(b.token);
  expect(a.id).not.toBe(b.id);
});

test('the plain token never appears in the store file; only its SHA-256 hash does', async () => {
  const dir = await tmpDir();
  const { token } = await store.createToken('phone', dir);
  const raw = await fs.readFile(path.join(dir, 'mobile-tokens.json'), 'utf8');
  expect(raw).not.toContain(token);
  expect(raw).toContain(sha256(token));
  const stored = JSON.parse(raw).tokens[0];
  expect(Object.keys(stored).sort()).toEqual(['createdAt', 'hash', 'id', 'label', 'lastUsedAt']);
  expect(stored.lastUsedAt).toBeNull();
});

test('the store file is private to its owner', async () => {
  const dir = await tmpDir();
  await store.createToken('phone', dir);
  const stat = await fs.stat(path.join(dir, 'mobile-tokens.json'));
  expect(stat.mode & 0o077).toBe(0);
});

test('listTokens never includes a hash or a token', async () => {
  const dir = await tmpDir();
  const { token } = await store.createToken('phone', dir);
  const list = await store.listTokens(dir);
  expect(list).toHaveLength(1);
  expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'id', 'label', 'lastUsedAt']);
  expect(JSON.stringify(list)).not.toContain(token);
  expect(JSON.stringify(list)).not.toContain(sha256(token));
});

test('labels are trimmed, required, and at most 60 characters', async () => {
  const dir = await tmpDir();
  expect((await store.createToken('  Ann  ', dir)).label).toBe('Ann');
  expect(await store.createToken('', dir)).toEqual({ ok: false, error: 'label is required', status: 400 });
  expect(await store.createToken('   ', dir)).toEqual({ ok: false, error: 'label is required', status: 400 });
  expect(await store.createToken(undefined, dir)).toEqual({ ok: false, error: 'label is required', status: 400 });
  expect(await store.createToken(42, dir)).toEqual({ ok: false, error: 'label is required', status: 400 });
  expect((await store.createToken('x'.repeat(61), dir)).ok).toBe(false);
  expect((await store.createToken('x'.repeat(60), dir)).ok).toBe(true);
  expect((await store.listTokens(dir)).map((t) => t.label)).toEqual(['Ann', 'x'.repeat(60)]);
});

test('at most 10 tokens', async () => {
  const dir = await tmpDir();
  for (let i = 0; i < 10; i++) expect((await store.createToken(`d${i}`, dir)).ok).toBe(true);
  const eleventh = await store.createToken('one too many', dir);
  expect(eleventh).toEqual({ ok: false, error: 'token limit reached (10)', status: 409 });
  expect(await store.listTokens(dir)).toHaveLength(10);
});

test('concurrent creation never exceeds 10 tokens and never loses one that succeeded', async () => {
  const dir = await tmpDir();
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => store.createToken(`d${i}`, dir)));
  const created = results.filter((r) => r.ok);
  expect(created).toHaveLength(10);
  expect(results.filter((r) => !r.ok).every((r) => r.status === 409)).toBe(true);
  const listed = await store.listTokens(dir);
  expect(listed).toHaveLength(10);
  expect(new Set(listed.map((t) => t.id))).toEqual(new Set(created.map((t) => t.id)));
});

test('verifyToken accepts a valid token and returns its record without secrets', async () => {
  const dir = await tmpDir();
  const { token, id } = await store.createToken('phone', dir);
  const record = await store.verifyToken(token, dir);
  expect(record).toEqual({ id, label: 'phone', createdAt: expect.any(String), lastUsedAt: null });
});

test('verifyToken rejects missing, empty, garbage, wrong-length, and non-string input', async () => {
  const dir = await tmpDir();
  const { token } = await store.createToken('phone', dir);
  for (const bad of [undefined, null, '', 'garbage', token.slice(0, -1), `${token}x`, 42, {}, [token], 'a'.repeat(10000)]) {
    expect(await store.verifyToken(bad, dir)).toBeNull();
  }
});

test('verifyToken rejects everything when no token file exists', async () => {
  const dir = await tmpDir();
  expect(await store.verifyToken('x'.repeat(43), dir)).toBeNull();
});

test('a revoked token stops verifying at once', async () => {
  const dir = await tmpDir();
  const { token, id } = await store.createToken('phone', dir);
  expect(await store.verifyToken(token, dir)).not.toBeNull();
  expect(await store.revokeToken(id, dir)).toBe(true);
  expect(await store.verifyToken(token, dir)).toBeNull();
  expect(await store.listTokens(dir)).toEqual([]);
});

test('revokeToken reports an unknown id', async () => {
  const dir = await tmpDir();
  expect(await store.revokeToken('nope', dir)).toBe(false);
});

test('revoking frees a slot under the 10 token limit', async () => {
  const dir = await tmpDir();
  const made = [];
  for (let i = 0; i < 10; i++) made.push(await store.createToken(`d${i}`, dir));
  await store.revokeToken(made[3].id, dir);
  expect((await store.createToken('replacement', dir)).ok).toBe(true);
});

test('touchToken records lastUsedAt, and only writes again after a minute', async () => {
  const dir = await tmpDir();
  const { id } = await store.createToken('phone', dir);
  const t0 = new Date('2026-11-02T08:00:00.000Z');
  await store.touchToken(id, t0, dir);
  expect((await store.listTokens(dir))[0].lastUsedAt).toBe(t0.toISOString());

  await store.touchToken(id, new Date(t0.getTime() + 30 * 1000), dir);
  expect((await store.listTokens(dir))[0].lastUsedAt).toBe(t0.toISOString());

  const t2 = new Date(t0.getTime() + 61 * 1000);
  await store.touchToken(id, t2, dir);
  expect((await store.listTokens(dir))[0].lastUsedAt).toBe(t2.toISOString());
});

test('touching a token that was revoked meanwhile does nothing and does not resurrect it', async () => {
  const dir = await tmpDir();
  const { id } = await store.createToken('phone', dir);
  await store.revokeToken(id, dir);
  await store.touchToken(id, new Date(), dir);
  expect(await store.listTokens(dir)).toEqual([]);
});

test('a corrupt store file fails closed: nothing verifies, and the error is not swallowed on create', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'mobile-tokens.json'), '{not json');
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  expect(await store.verifyToken('x'.repeat(43), dir)).toBeNull();
  expect(errorSpy).toHaveBeenCalledTimes(1);
  errorSpy.mockRestore();
  await expect(store.createToken('phone', dir)).rejects.toThrow();
});

test('no temp files are left behind', async () => {
  const dir = await tmpDir();
  await Promise.all([store.createToken('a', dir), store.createToken('b', dir), store.createToken('c', dir)]);
  expect(await fs.readdir(dir)).toEqual(['mobile-tokens.json']);
});
