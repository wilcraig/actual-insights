const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// Per-transaction Insights flags for the native app: `excluded` (left out of
// budget and spending figures) and `hidden` (also left out of transaction
// lists; implies excluded). Actual has no such concept, so they live here, in
// <data dir>/mobile-transaction-flags.json as `{ "flags": { "<id>": { "excluded": bool, "hidden": bool } } }`,
// written through a temp file and a rename. A missing, unreadable or corrupt
// file means nothing is flagged; a bad entry is skipped. Nothing is ever
// pruned automatically (a flag on a deleted transaction is harmless); an entry
// is dropped only when both of its flags are switched off.

const FILE_NAME = 'mobile-transaction-flags.json';
const MAX_ENTRIES = 20000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const dataDir = () => process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';

// Hidden implies excluded, always.
const effective = (entry) => {
  const hidden = Boolean(entry && entry.hidden === true);
  return { excluded: hidden || Boolean(entry && entry.excluded === true), hidden };
};

// A plain id -> {excluded, hidden} object holding only valid, flagged entries.
function clean(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let count = 0;
  for (const [id, entry] of Object.entries(raw)) {
    if (!ID_PATTERN.test(id) || !entry || typeof entry !== 'object') continue;
    const flags = effective(entry);
    if (!flags.excluded && !flags.hidden) continue;
    out[id] = flags;
    if (++count >= MAX_ENTRIES) break;
  }
  return out;
}

// Re-read only when the file's mtime/size changed (or this process wrote it).
const cache = new Map();

async function readFlags(dir = dataDir()) {
  const file = path.join(dir, FILE_NAME);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    cache.delete(file);
    return Object.create(null);
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(file);
  if (hit && hit.stamp === stamp) return hit.flags;
  let flags;
  try {
    flags = clean(JSON.parse(await fs.readFile(file, 'utf8')).flags);
  } catch {
    flags = Object.create(null);
  }
  cache.set(file, { stamp, flags });
  return flags;
}

async function writeFlags(flags, dir = dataDir()) {
  const next = clean(flags);
  const file = path.join(dir, FILE_NAME);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ flags: next }), { mode: 0o600 });
  await fs.rename(tmp, file);
  cache.delete(file);
  return next;
}

// The flags a transaction has now (both false when it has none).
async function getFlags(id, dir = dataDir()) {
  return effective((await readFlags(dir))[id]);
}

// Set one transaction's effective flags; returns what it had before. Throws
// code 'FULL' when a new entry would exceed the cap.
async function setFlags(id, next, dir = dataDir()) {
  const all = { ...(await readFlags(dir)) };
  const before = effective(all[id]);
  const after = effective(next);
  if (!after.excluded && !after.hidden) delete all[id];
  else {
    if (!(id in all) && Object.keys(all).length >= MAX_ENTRIES) throw Object.assign(new Error('flag store full'), { code: 'FULL' });
    all[id] = after;
  }
  await writeFlags(all, dir);
  return before;
}

module.exports = { readFlags, writeFlags, getFlags, setFlags, effective, FILE_NAME, MAX_ENTRIES };
