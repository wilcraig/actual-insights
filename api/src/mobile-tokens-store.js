const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// Device tokens for the companion mobile app: scoped, revocable credentials
// that unlock exactly one read-only endpoint (/api/mobile/summary). The plain
// token is 32 random bytes as base64url and is handed out once, at creation;
// only its SHA-256 hash is stored, with a label and two timestamps. Same data
// dir and temp-file-then-rename persistence as goals-store.js.
const DATA_DIR = process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';

const FILE_NAME = 'mobile-tokens.json';
const MAX_TOKENS = 10;
const MAX_LABEL_LENGTH = 60;
// lastUsedAt is bookkeeping for the person reading the token list, not a
// security log, so a busy widget refreshing every few seconds must not turn
// into a disk write per request.
const TOUCH_INTERVAL_MS = 60 * 1000;

// 32 bytes, base64url, no padding.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

async function readFile(dataDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dataDir, FILE_NAME), 'utf8'));
    return Array.isArray(parsed && parsed.tokens) ? parsed.tokens : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Mode 0600: the hashes can't be reversed, but there's no reason for anyone
// else on the host to read them. rename() keeps the temp file's mode.
async function writeFile(tokens, dataDir) {
  const finalPath = path.join(dataDir, FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ tokens }), { mode: 0o600 });
  await fs.rename(tmpPath, finalPath);
}

// Read-modify-write calls are chained per data dir, so concurrent creates
// can't each see "9 tokens" and all succeed, and a touch can't clobber a
// create. A rejected step doesn't wedge the chain for the next caller.
const queues = new Map();
function update(dataDir, mutate) {
  const prior = queues.get(dataDir) || Promise.resolve();
  const run = prior.then(async () => {
    const tokens = await readFile(dataDir);
    const result = await mutate(tokens);
    if (result && result.write) await writeFile(result.write, dataDir);
    return result ? result.value : undefined;
  });
  const settled = run.catch(() => {});
  queues.set(dataDir, settled);
  settled.then(() => {
    if (queues.get(dataDir) === settled) queues.delete(dataDir);
  });
  return run;
}

// The public shape of a token: never the hash.
const publicRecord = ({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt });

async function listTokens(dataDir = DATA_DIR) {
  return (await readFile(dataDir)).map(publicRecord);
}

// -> { ok: true, id, token, label, createdAt } | { ok: false, error, status }.
// `token` is the only copy of the secret there will ever be.
async function createToken(label, dataDir = DATA_DIR) {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (trimmed.length === 0) return { ok: false, error: 'label is required', status: 400 };
  if (trimmed.length > MAX_LABEL_LENGTH) {
    return { ok: false, error: `label must be at most ${MAX_LABEL_LENGTH} characters`, status: 400 };
  }

  return update(dataDir, (tokens) => {
    if (tokens.length >= MAX_TOKENS) {
      return { value: { ok: false, error: `token limit reached (${MAX_TOKENS})`, status: 409 } };
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const record = {
      id: crypto.randomUUID(),
      label: trimmed,
      hash: sha256(token).toString('hex'),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    return {
      write: [...tokens, record],
      value: { ok: true, id: record.id, token, label: record.label, createdAt: record.createdAt },
    };
  });
}

// Revocation takes effect on the very next request: verifyToken reads the
// file every time. -> true when something was removed.
async function revokeToken(id, dataDir = DATA_DIR) {
  return update(dataDir, (tokens) => {
    const remaining = tokens.filter((t) => t.id !== id);
    if (remaining.length === tokens.length) return { value: false };
    return { write: remaining, value: true };
  });
}

// The record for a presented token, or null. Compares against every stored
// hash with timingSafeEqual and doesn't stop at the first match, so timing
// reveals nothing about which (or whether any) stored token was close. A
// corrupt or unreadable file fails closed.
async function verifyToken(presented, dataDir = DATA_DIR) {
  if (typeof presented !== 'string' || !TOKEN_PATTERN.test(presented)) return null;

  let tokens;
  try {
    tokens = await readFile(dataDir);
  } catch (err) {
    console.error('mobile tokens: could not read the token file:', err && err.code ? err.code : 'unexpected error');
    return null;
  }

  const presentedHash = sha256(presented);
  let match = null;
  for (const record of tokens) {
    const stored = Buffer.from(String(record.hash), 'hex');
    if (stored.length === presentedHash.length && crypto.timingSafeEqual(stored, presentedHash)) match = record;
  }
  return match ? publicRecord(match) : null;
}

// Marks a token as used at `now`, at most once a minute per token. Quietly
// does nothing for a token that was revoked in the meantime.
function touchToken(id, now = new Date(), dataDir = DATA_DIR) {
  return update(dataDir, (tokens) => {
    const record = tokens.find((t) => t.id === id);
    if (!record) return { value: false };
    if (record.lastUsedAt && now.getTime() - new Date(record.lastUsedAt).getTime() < TOUCH_INTERVAL_MS) {
      return { value: false };
    }
    return { write: tokens.map((t) => (t.id === id ? { ...t, lastUsedAt: now.toISOString() } : t)), value: true };
  });
}

module.exports = { listTokens, createToken, revokeToken, verifyToken, touchToken, MAX_TOKENS, DATA_DIR };
