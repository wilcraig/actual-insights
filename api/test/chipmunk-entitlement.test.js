const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chipmunk-ent-'));
process.env.INSIGHTS_DATA_DIR = DATA_DIR;

const ent = require('../src/chipmunk/entitlement');
const { makeChain, signTransaction, b64url } = require('./helpers/apple-test-chain');
const { expectValid, examples } = require('./helpers/native-v1');

const DAY = 24 * 3600 * 1000;
const STATE_FILE = path.join(DATA_DIR, 'chipmunk-entitlement.json');
const apple = (proof) => ({ platform: 'apple', proof });

let chain;
let otherChain;
let logs;

beforeAll(() => {
  chain = makeChain('good');
  otherChain = makeChain('other');
});

beforeEach(() => {
  fs.rmSync(STATE_FILE, { force: true });
  delete process.env.CHIPMUNK_ENTITLEMENT_MODE;
  delete process.env.CHIPMUNK_PLAY_PUBLIC_KEY;
  ent.setAppleRootsForTests([chain.rootDer]);
  ent.resetAnnouncement();
  logs = [];
  for (const m of ['log', 'warn', 'error', 'info']) jest.spyOn(console, m).mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => {
  for (const m of ['log', 'warn', 'error', 'info']) console[m].mockRestore();
});

describe('the contract examples', () => {
  test('entitlement examples are valid and bad shapes are not', () => {
    for (const name of ['entitlementRequest', 'entitlementRequestGoogle', 'entitlementResponse', 'entitlementResponseNone']) expectValid(name, examples[name]);
  });
});

describe('Apple verification (test root injected)', () => {
  test('a valid proof is accepted, answers per contract and persists only hashes', async () => {
    const now = Date.now();
    const proof = signTransaction(chain);
    const res = await ent.submitProof(apple(proof), { now });
    expectValid('entitlementResponse', res);
    expect(res).toMatchObject({ entitled: true, reason: 'verified', lastVerifiedAt: new Date(now).toISOString() });
    // validUntil is the earlier of check-in window+grace and expiry+grace: here 30d expiry + 7d.
    expect(Date.parse(res.validUntil)).toBeGreaterThan(now + 36 * DAY);
    expect(Date.parse(res.validUntil)).toBeLessThanOrEqual(now + 37 * DAY + 5000);
    expect(await ent.chipmunkEntitled({ now })).toEqual({ entitled: true, reason: 'verified', lastVerifiedAt: res.lastVerifiedAt, validUntil: res.validUntil });

    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    expect(Object.keys(state).sort()).toEqual(['expiresAt', 'platform', 'productId', 'txnHash', 'verifiedAt']);
    expect(state.txnHash).toBe(crypto.createHash('sha256').update('2000000000000000').digest('hex'));
    for (const secret of [proof, proof.split('.')[1], proof.split('.')[2], '2000000000000000', chain.x5c[0].slice(0, 40)]) expect(raw).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(proof.split('.')[2]);
    expect(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('the yearly product and the Sandbox environment are accepted', async () => {
    expect((await ent.submitProof(apple(signTransaction(chain, { productId: 'chipmunk.yearly' })))).reason).toBe('verified');
    expect((await ent.submitProof(apple(signTransaction(chain, { environment: 'Sandbox' })))).reason).toBe('verified');
  });

  test('an expired genuine proof answers expired and unlocks nothing', async () => {
    const now = Date.now();
    const proof = signTransaction(chain, { expiresDate: now - 8 * DAY });
    const res = await ent.submitProof(apple(proof), { now });
    expectValid('entitlementResponse', res);
    expect(res).toMatchObject({ entitled: false, reason: 'expired' });
    expect(fs.existsSync(STATE_FILE)).toBe(false);
    expect((await ent.chipmunkEntitled({ now })).reason).toBe('none');
  });

  test('a subscription that expired less than the grace ago still counts', async () => {
    const now = Date.now();
    const res = await ent.submitProof(apple(signTransaction(chain, { expiresDate: now - 3 * DAY })), { now });
    expect(res).toMatchObject({ entitled: true, reason: 'verified' });
    expect(Date.parse(res.validUntil)).toBe(now + 4 * DAY);
  });

  test('a refunded transaction is expired', async () => {
    const res = await ent.submitProof(apple(signTransaction(chain, { revocationDate: Date.now() })));
    expect(res).toMatchObject({ entitled: false, reason: 'expired' });
  });

  test.each([
    ['wrong bundle id', { bundleId: 'com.example.other' }],
    ['wrong product', { productId: 'chipmunk.lifetime' }],
    ['xcode environment', { environment: 'Xcode' }],
    ['no expiry', { expiresDate: undefined }],
  ])('%s is unverified', async (_name, override) => {
    const res = await ent.submitProof(apple(signTransaction(chain, override)));
    expectValid('entitlementResponse', res);
    expect(res).toEqual({ schema: 1, entitled: false, reason: 'unverified', lastVerifiedAt: null, validUntil: null });
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  test('a tampered payload or signature is unverified', async () => {
    const proof = signTransaction(chain);
    const [h, p, s] = proof.split('.');
    const body = JSON.parse(Buffer.from(p, 'base64url').toString());
    body.expiresDate += 365 * DAY;
    expect((await ent.submitProof(apple(`${h}.${b64url(body)}.${s}`))).reason).toBe('unverified');
    const flipped = Buffer.from(s, 'base64url');
    flipped[5] ^= 0xff;
    expect((await ent.submitProof(apple(`${h}.${p}.${flipped.toString('base64url')}`))).reason).toBe('unverified');
    expect((await ent.submitProof(apple('not-a-jws'))).reason).toBe('unverified');
    expect((await ent.submitProof(apple('a.b.c'))).reason).toBe('unverified');
  });

  test('a chain that does not lead to the trusted root is unverified', async () => {
    const res = await ent.submitProof(apple(signTransaction(otherChain)));
    expect(res.reason).toBe('unverified');
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  test('a signature by a different key than the leaf is unverified', async () => {
    const forged = signTransaction({ x5c: chain.x5c, key: otherChain.key });
    expect((await ent.submitProof(apple(forged))).reason).toBe('unverified');
  });

  test('strict verification needs no network', async () => {
    const original = global.fetch;
    global.fetch = () => { throw new Error('network used'); };
    try {
      expect((await ent.submitProof(apple(signTransaction(chain)))).reason).toBe('verified');
    } finally {
      global.fetch = original;
    }
  });
});

describe('Apple root certificates', () => {
  test('are vendored, match their pinned fingerprints, and are Apple roots', () => {
    ent.setAppleRootsForTests(null);
    const roots = ent.loadAppleRoots();
    expect(roots).toHaveLength(3);
    const subjects = roots.map((der) => new crypto.X509Certificate(der).subject).join('|');
    expect(subjects).toMatch(/Apple Root CA - G3/);
    expect(subjects).toMatch(/Apple Root CA - G2/);
    const sums = roots.map((der) => crypto.createHash('sha256').update(der).digest('hex'));
    expect(sums).toEqual(expect.arrayContaining([
      '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
      'c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050',
      'b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024',
    ]));
  });

  test('the real Apple roots (not the test root) reject a test-chain proof', async () => {
    ent.setAppleRootsForTests(null);
    expect((await ent.submitProof(apple(signTransaction(chain)))).reason).toBe('unverified');
  });
});

describe('staleness, grace and renewal', () => {
  test('none until a proof arrives', async () => {
    const res = await ent.chipmunkEntitled();
    expect(res).toEqual({ entitled: false, reason: 'none', lastVerifiedAt: null, validUntil: null });
    expectValid('entitlementResponse', { schema: 1, ...res });
  });

  test('entitled for 30 days + 7 days grace after the last proof, then expired', async () => {
    const t0 = Date.now();
    const proof = signTransaction(chain, { productId: 'chipmunk.yearly', expiresDate: t0 + 365 * DAY });
    await ent.submitProof(apple(proof), { now: t0 });
    expect((await ent.chipmunkEntitled({ now: t0 + 29 * DAY })).entitled).toBe(true);
    expect((await ent.chipmunkEntitled({ now: t0 + 37 * DAY })).entitled).toBe(true);
    const late = await ent.chipmunkEntitled({ now: t0 + 37 * DAY + 1 });
    expect(late).toMatchObject({ entitled: false, reason: 'expired' });
    expect(late.lastVerifiedAt).toBe(new Date(t0).toISOString());
    expectValid('entitlementResponse', { schema: 1, ...late });
  });

  test("the subscription's own expiry plus grace also ends it, even inside the check-in window", async () => {
    const t0 = Date.now();
    await ent.submitProof(apple(signTransaction(chain, { expiresDate: t0 + 2 * DAY })), { now: t0 });
    expect((await ent.chipmunkEntitled({ now: t0 + 9 * DAY })).entitled).toBe(true);
    expect((await ent.chipmunkEntitled({ now: t0 + 9 * DAY + 5000 })).reason).toBe('expired');
  });

  test('a newer proof extends the window', async () => {
    const t0 = Date.now();
    await ent.submitProof(apple(signTransaction(chain, { expiresDate: t0 + 30 * DAY })), { now: t0 });
    const t1 = t0 + 25 * DAY;
    const res = await ent.submitProof(apple(signTransaction(chain, { expiresDate: t1 + 30 * DAY })), { now: t1 });
    expect(res.entitled).toBe(true);
    expect(res.lastVerifiedAt).toBe(new Date(t1).toISOString());
    expect((await ent.chipmunkEntitled({ now: t0 + 60 * DAY })).entitled).toBe(true);
    expect((await ent.chipmunkEntitled({ now: t1 + 38 * DAY })).entitled).toBe(false);
  });

  test('an older renewal period never rewinds a later one', async () => {
    const t0 = Date.now();
    await ent.submitProof(apple(signTransaction(chain, { expiresDate: t0 + 30 * DAY })), { now: t0 });
    const t1 = t0 + 5 * DAY;
    const res = await ent.submitProof(apple(signTransaction(chain, { expiresDate: t0 + 10 * DAY })), { now: t1 });
    expect(res.lastVerifiedAt).toBe(new Date(t0).toISOString());
    expect(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).expiresAt).toBe(t0 + 30 * DAY);
  });

  test('a corrupt state file reads as no proof', async () => {
    fs.writeFileSync(STATE_FILE, '{nope');
    expect((await ent.chipmunkEntitled()).reason).toBe('none');
    fs.writeFileSync(STATE_FILE, JSON.stringify({ platform: 'apple' }));
    expect((await ent.chipmunkEntitled()).reason).toBe('none');
  });
});

describe('Google verification', () => {
  let pair;
  const purchase = (over = {}) => JSON.stringify({ orderId: 'GPA.0000-0000-0000-00000', productId: 'chipmunk.monthly', packageName: 'app.chipmunkbudget.chipmunk', purchaseState: 0, purchaseTime: 1767225600000, autoRenewing: true, ...over });
  const sign = (text, alg = 'RSA-SHA1', key = pair.privateKey) => crypto.createSign(alg).update(text).sign(key).toString('base64');
  const google = (proof, signature) => ({ platform: 'google', proof, signature });

  beforeAll(() => {
    pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  });
  beforeEach(() => {
    process.env.CHIPMUNK_PLAY_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  });

  test('a validly signed purchase is accepted (SHA1 and SHA256), validity from the 30+7 window only', async () => {
    const now = Date.now();
    const p = purchase();
    const res = await ent.submitProof(google(p, sign(p)), { now });
    expectValid('entitlementResponse', res);
    expect(res).toMatchObject({ entitled: true, reason: 'verified' });
    expect(Date.parse(res.validUntil)).toBe(now + 37 * DAY);
    expect((await ent.submitProof(google(p, sign(p, 'RSA-SHA256')), { now })).reason).toBe('verified');
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    expect(raw).not.toContain('GPA.0000');
    expect(JSON.parse(raw)).toMatchObject({ platform: 'google', expiresAt: null });
  });

  test('a bad signature, altered purchase or wrong key is unverified', async () => {
    const p = purchase();
    expect((await ent.submitProof(google(p, sign(p).replace(/.{4}$/, 'AAAA')))).reason).toBe('unverified');
    expect((await ent.submitProof(google(purchase({ autoRenewing: false }), sign(p)))).reason).toBe('unverified');
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect((await ent.submitProof(google(p, sign(p, 'RSA-SHA1', other.privateKey)))).reason).toBe('unverified');
    expect((await ent.submitProof(google(p, '%%%'))).reason).toBe('unverified');
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  test.each([
    ['wrong package', { packageName: 'com.example' }],
    ['wrong product', { productId: 'other' }],
    ['pending purchase', { purchaseState: 1 }],
  ])('signed but %s is unverified', async (_n, over) => {
    const p = purchase(over);
    expect((await ent.submitProof(google(p, sign(p)))).reason).toBe('unverified');
  });

  test('without CHIPMUNK_PLAY_PUBLIC_KEY the answer is not_configured', async () => {
    delete process.env.CHIPMUNK_PLAY_PUBLIC_KEY;
    const p = purchase();
    const res = await ent.submitProof(google(p, sign(p)));
    expectValid('entitlementResponse', res);
    expect(res).toEqual({ schema: 1, entitled: false, reason: 'not_configured', lastVerifiedAt: null, validUntil: null });
  });

  test('a garbage configured key never verifies', async () => {
    process.env.CHIPMUNK_PLAY_PUBLIC_KEY = 'AAAA';
    const p = purchase();
    expect((await ent.submitProof(google(p, sign(p)))).reason).toBe('unverified');
  });
});

describe('modes', () => {
  test('dev accepts an unverifiable but well-formed Apple JWS, still checks bundle/product/expiry, warns once', async () => {
    process.env.CHIPMUNK_ENTITLEMENT_MODE = 'dev';
    expect(ent.entitlementMode()).toBe('dev');
    ent.announceMode();
    ent.announceMode();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toMatch(/dev/);
    const unsigned = `${b64url({ alg: 'none' })}.${b64url({ bundleId: 'app.chipmunkbudget.chipmunk', productId: 'chipmunk.yearly', originalTransactionId: 'dev-1', expiresDate: Date.now() + DAY })}.c2ln`;
    expect(await ent.submitProof(apple(unsigned))).toMatchObject({ entitled: true, reason: 'verified' });
    const bad = `${b64url({ alg: 'none' })}.${b64url({ bundleId: 'x', productId: 'chipmunk.yearly', originalTransactionId: 'dev-1', expiresDate: Date.now() + DAY })}.c2ln`;
    expect((await ent.submitProof(apple(bad))).reason).toBe('unverified');
    expect((await ent.submitProof(apple('garbage'))).reason).toBe('unverified');
    const expired = `${b64url({ alg: 'none' })}.${b64url({ bundleId: 'app.chipmunkbudget.chipmunk', productId: 'chipmunk.yearly', originalTransactionId: 'dev-1', expiresDate: Date.now() - 30 * DAY })}.c2ln`;
    expect((await ent.submitProof(apple(expired))).reason).toBe('expired');
  });

  test('dev accepts a Google purchase with an unchecked signature, even without a key', async () => {
    process.env.CHIPMUNK_ENTITLEMENT_MODE = 'dev';
    const p = JSON.stringify({ productId: 'chipmunk.monthly', packageName: 'app.chipmunkbudget.chipmunk', purchaseState: 0 });
    expect((await ent.submitProof({ platform: 'google', proof: p, signature: 'x' })).reason).toBe('verified');
  });

  test('open is always entitled (reason verified, lastVerifiedAt null) and ignores proofs', async () => {
    process.env.CHIPMUNK_ENTITLEMENT_MODE = 'open';
    ent.announceMode();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(await ent.chipmunkEntitled()).toEqual({ entitled: true, reason: 'verified', lastVerifiedAt: null, validUntil: null });
    const res = await ent.submitProof(apple('garbage'));
    expectValid('entitlementResponse', res);
    expect(res.entitled).toBe(true);
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  test('strict is the default, and an unknown value is strict with a warning', async () => {
    expect(ent.entitlementMode()).toBe('strict');
    process.env.CHIPMUNK_ENTITLEMENT_MODE = 'sure';
    expect(ent.entitlementMode()).toBe('strict');
    ent.announceMode();
    expect(logs.join('\n')).toMatch(/unknown/);
    expect((await ent.chipmunkEntitled()).entitled).toBe(false);
  });
});

describe('tools/mint-dev-proof', () => {
  const { mint } = require('../tools/mint-dev-proof');
  test('mints a proof only dev mode accepts', async () => {
    const proof = mint({ product: 'yearly', days: 10 });
    process.env.CHIPMUNK_ENTITLEMENT_MODE = 'dev';
    expect(await ent.submitProof({ platform: 'apple', proof })).toMatchObject({ entitled: true, reason: 'verified' });
    delete process.env.CHIPMUNK_ENTITLEMENT_MODE;
    expect((await ent.submitProof({ platform: 'apple', proof })).reason).toBe('unverified');
    expect(() => mint({ product: 'lifetime' })).toThrow();
  });
});
