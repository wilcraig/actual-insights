const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// The ONE place that decides whether Chipmunk mode may be used. Everything that
// offers or serves it (the toggle, the settings route, the data routes) asks
// chipmunkEntitled(). The Chipmunk apps hold the store subscription and prove
// it to this server (POST /api/mobile/v1/entitlement -> submitProof); nothing
// leaves this server and there is no Chipmunk backend.
//
// State (chipmunk-entitlement.json in the Insights data dir) holds only the
// platform, product id, a sha256 of the original transaction id, the
// subscription expiry and when a proof was last accepted. A proof itself (the
// Apple JWS, the Play purchase JSON or its signature) is never stored or logged.
//
// CHIPMUNK_ENTITLEMENT_MODE: unset = strict. 'dev' = structurally valid Apple
// JWS accepted without checking the certificate chain, Play signature
// unchecked (local/Xcode testing). 'open' = always entitled (demos).

const BUNDLE_ID = 'app.chipmunkbudget.chipmunk';
const PRODUCT_IDS = ['chipmunk.monthly', 'chipmunk.yearly'];
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_IN_WINDOW_MS = 30 * DAY_MS;
const GRACE_MS = 7 * DAY_MS;
const FILE_NAME = 'chipmunk-entitlement.json';
// The library demands an App Store app id for the Production environment but
// only uses it for server notifications, never for signed transactions.
const UNUSED_APP_APPLE_ID = 1;

const dataDir = () => process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';

function entitlementMode() {
  const raw = process.env.CHIPMUNK_ENTITLEMENT_MODE;
  return raw === 'dev' || raw === 'open' ? raw : 'strict';
}

let warned = false;
// Called once at server start (and lazily on first use): a loud notice when
// the server is not strict.
function announceMode() {
  if (warned) return;
  warned = true;
  const raw = process.env.CHIPMUNK_ENTITLEMENT_MODE;
  const mode = entitlementMode();
  if (mode === 'dev') {
    console.warn('!!! CHIPMUNK_ENTITLEMENT_MODE=dev: Apple proofs are accepted WITHOUT certificate checks and Play signatures are NOT checked. Anyone with a device token can unlock Chipmunk mode. Never use this on a real server.');
  } else if (mode === 'open') {
    console.warn('!!! CHIPMUNK_ENTITLEMENT_MODE=open: Chipmunk mode is ALWAYS entitled, no subscription is checked. Demo use only.');
  } else if (raw) {
    console.warn('CHIPMUNK_ENTITLEMENT_MODE has an unknown value; using strict mode.');
  }
}
// Test hook.
const resetAnnouncement = () => { warned = false; };

// ------------------------------------------------------------------ state

const iso = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

function parseState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { platform, productId, txnHash, expiresAt, verifiedAt } = raw;
  if ((platform !== 'apple' && platform !== 'google') || typeof productId !== 'string' || typeof txnHash !== 'string') return null;
  if (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt)) return null;
  if (expiresAt !== null && !(typeof expiresAt === 'number' && Number.isFinite(expiresAt))) return null;
  return { platform, productId, txnHash, expiresAt, verifiedAt };
}

async function readState() {
  try {
    return parseState(JSON.parse(await fs.readFile(path.join(dataDir(), FILE_NAME), 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // A corrupt file means "no proof": the phone's next check-in rewrites it.
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

async function writeState(state) {
  const finalPath = path.join(dataDir(), FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const body = {
    platform: state.platform,
    productId: state.productId,
    txnHash: state.txnHash,
    expiresAt: state.expiresAt,
    verifiedAt: state.verifiedAt,
  };
  await fs.writeFile(tmpPath, JSON.stringify(body), { mode: 0o600 });
  await fs.rename(tmpPath, finalPath);
}

// One writer at a time, so two check-ins cannot interleave read and write.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// When entitlement lapses unless a new proof arrives.
function validUntilMs(state) {
  let until = state.verifiedAt + CHECK_IN_WINDOW_MS + GRACE_MS;
  if (state.platform === 'apple' && state.expiresAt !== null) until = Math.min(until, state.expiresAt + GRACE_MS);
  return until;
}

function describe(state, now, mode) {
  if (mode === 'open') {
    return { entitled: true, reason: 'verified', lastVerifiedAt: state ? iso(state.verifiedAt) : null, validUntil: null };
  }
  if (!state) return { entitled: false, reason: 'none', lastVerifiedAt: null, validUntil: null };
  const until = validUntilMs(state);
  const entitled = now <= until;
  return { entitled, reason: entitled ? 'verified' : 'expired', lastVerifiedAt: iso(state.verifiedAt), validUntil: iso(until) };
}

async function chipmunkEntitled({ now = Date.now() } = {}) {
  announceMode();
  return describe(await readState(), now, entitlementMode());
}

// The contract's entitlementResponse.
async function currentResponse(opts) {
  return { schema: 1, ...(await chipmunkEntitled(opts)) };
}

// ------------------------------------------------------------------ Apple

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// Apple's roots, vendored as DER. Their SHA-256 fingerprints are pinned here
// and checked when loaded, so a swapped file refuses to load.
const APPLE_ROOT_FILES = {
  'AppleRootCA-G3.cer': '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
  'AppleRootCA-G2.cer': 'c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050',
  'AppleIncRootCertificate.cer': 'b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024',
};

function loadAppleRoots() {
  const fsSync = require('fs');
  return Object.entries(APPLE_ROOT_FILES).map(([name, fingerprint]) => {
    const der = fsSync.readFileSync(path.join(__dirname, 'apple-roots', name));
    if (sha256Buffer(der) !== fingerprint) throw new Error(`Apple root ${name} does not match its pinned fingerprint`);
    return der;
  });
}
const sha256Buffer = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let rootsOverride = null;
let verifiers = null;
// Test hook: trust these DER roots instead of Apple's (null = back to Apple's).
function setAppleRootsForTests(roots) {
  rootsOverride = roots;
  verifiers = null;
}

function appleVerifiers() {
  if (!verifiers) {
    const { SignedDataVerifier, Environment } = require('@apple/app-store-server-library');
    const roots = rootsOverride || loadAppleRoots();
    // enableOnlineChecks=false: no OCSP, no network at runtime. Certificate
    // dates are judged at the transaction's signed date.
    verifiers = {
      Production: new SignedDataVerifier(roots, false, Environment.PRODUCTION, BUNDLE_ID, UNUSED_APP_APPLE_ID),
      Sandbox: new SignedDataVerifier(roots, false, Environment.SANDBOX, BUNDLE_ID),
    };
  }
  return verifiers;
}

const b64urlJson = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// Unverified decode of a compact JWS, only to read its payload.
function decodeUnverified(jws) {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) return null;
  try {
    const header = b64urlJson(parts[0]);
    const payload = b64urlJson(parts[1]);
    if (!header || typeof header !== 'object' || typeof header.alg !== 'string') return null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

// -> { ok: true, platform, productId, txn, expiresAt, revoked } | { ok: false, reason }
async function checkApple(proof, mode) {
  const claimed = decodeUnverified(proof);
  if (!claimed) return { ok: false, reason: 'unverified' };
  let payload;
  if (mode === 'dev') {
    payload = claimed;
  } else {
    const env = claimed.environment;
    if (env !== 'Production' && env !== 'Sandbox') return { ok: false, reason: 'unverified' };
    try {
      payload = await appleVerifiers()[env].verifyAndDecodeTransaction(proof);
    } catch {
      return { ok: false, reason: 'unverified' };
    }
  }
  if (payload.bundleId !== BUNDLE_ID || !PRODUCT_IDS.includes(payload.productId)) return { ok: false, reason: 'unverified' };
  const txn = payload.originalTransactionId;
  if (typeof txn !== 'string' && typeof txn !== 'number') return { ok: false, reason: 'unverified' };
  const expiresAt = payload.expiresDate;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return { ok: false, reason: 'unverified' };
  return { ok: true, platform: 'apple', productId: payload.productId, txn: String(txn), expiresAt, revoked: typeof payload.revocationDate === 'number' };
}

// ------------------------------------------------------------------ Google

function playKey() {
  const b64 = (process.env.CHIPMUNK_PLAY_PUBLIC_KEY || '').replace(/\s+/g, '');
  if (!b64) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

function playSignatureOk(key, proof, signature) {
  let sig;
  try {
    sig = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  // Play signs with RSASSA-PKCS1-v1_5 / SHA-1; SHA-256 is accepted too.
  return ['RSA-SHA1', 'RSA-SHA256'].some((alg) => {
    try {
      return crypto.createVerify(alg).update(proof).verify(key, sig);
    } catch {
      return false;
    }
  });
}

function checkGoogle(proof, signature, mode) {
  const configured = process.env.CHIPMUNK_PLAY_PUBLIC_KEY;
  if (mode !== 'dev') {
    if (!configured) return { ok: false, reason: 'not_configured' };
    const key = playKey();
    // A configured but unusable key can never verify anything.
    if (!key || !playSignatureOk(key, proof, signature)) return { ok: false, reason: 'unverified' };
  }
  let purchase;
  try {
    purchase = JSON.parse(proof);
  } catch {
    return { ok: false, reason: 'unverified' };
  }
  if (!purchase || typeof purchase !== 'object' || Array.isArray(purchase)) return { ok: false, reason: 'unverified' };
  if (purchase.packageName !== BUNDLE_ID || !PRODUCT_IDS.includes(purchase.productId) || purchase.purchaseState !== 0) {
    return { ok: false, reason: 'unverified' };
  }
  const id = purchase.orderId || purchase.purchaseToken || `${purchase.productId}:${purchase.purchaseTime ?? ''}`;
  return { ok: true, platform: 'google', productId: purchase.productId, txn: String(id), expiresAt: null, revoked: false };
}

// ------------------------------------------------------------------ submit

// body: an already-validated entitlementRequest. Returns the contract's
// entitlementResponse. Never throws for a bad proof, only for real I/O errors.
async function submitProof(body, { now = Date.now() } = {}) {
  announceMode();
  const mode = entitlementMode();
  if (mode === 'open') return currentResponse({ now });
  const result = body.platform === 'apple' ? await checkApple(body.proof, mode) : checkGoogle(body.proof, body.signature, mode);
  if (!result.ok) {
    return { schema: 1, entitled: false, reason: result.reason, lastVerifiedAt: null, validUntil: null };
  }
  // A genuine proof of a subscription that has run out (or was refunded) does
  // not unlock anything and does not touch the stored state.
  if (result.revoked || (result.expiresAt !== null && result.expiresAt + GRACE_MS < now)) {
    const stored = await readState();
    return { schema: 1, entitled: false, reason: 'expired', lastVerifiedAt: stored ? iso(stored.verifiedAt) : null, validUntil: stored ? iso(validUntilMs(stored)) : null };
  }
  return exclusive(async () => {
    const stored = await readState();
    const incoming = { platform: result.platform, productId: result.productId, txnHash: sha256(result.txn), expiresAt: result.expiresAt, verifiedAt: now };
    // An older proof (an earlier renewal period) never shortens or rewinds a
    // later one already on file.
    const older = stored && stored.platform === incoming.platform && stored.txnHash === incoming.txnHash
      && stored.expiresAt !== null && incoming.expiresAt !== null && incoming.expiresAt < stored.expiresAt;
    if (!older) await writeState(incoming);
    return { schema: 1, ...describe(older ? stored : incoming, now, mode) };
  });
}

module.exports = {
  chipmunkEntitled,
  currentResponse,
  submitProof,
  announceMode,
  entitlementMode,
  resetAnnouncement,
  setAppleRootsForTests,
  loadAppleRoots,
  BUNDLE_ID,
  PRODUCT_IDS,
  CHECK_IN_WINDOW_MS,
  GRACE_MS,
};
