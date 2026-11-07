const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// Accounts the owner has chosen to COMPLETELY hide from the native app (the
// device-token API: /api/mobile/summary and /api/mobile/v1/*). A small JSON
// file in the data dir, `{ "hiddenIds": [account ids] }`, written through a
// temp file and a rename. A missing, unreadable or corrupt file means nothing
// is hidden. Hidden is independent of an account being closed or off budget.

const FILE_NAME = 'mobile-hidden-accounts.json';
const MAX_HIDDEN = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const dataDir = () => process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';

// Ids that fit the schema, once each, at most MAX_HIDDEN.
function cleanIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) {
    if (typeof id === 'string' && ID_PATTERN.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_HIDDEN) break;
  }
  return out;
}

async function readHiddenIds(dir = dataDir()) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, FILE_NAME), 'utf8'));
    return cleanIds(parsed && parsed.hiddenIds);
  } catch {
    return [];
  }
}

async function writeHiddenIds(ids, dir = dataDir()) {
  const clean = cleanIds(ids);
  const finalPath = path.join(dir, FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ hiddenIds: clean }), { mode: 0o600 });
  await fs.rename(tmpPath, finalPath);
  return clean;
}

module.exports = { readHiddenIds, writeHiddenIds, cleanIds, MAX_HIDDEN, ID_PATTERN, FILE_NAME };
