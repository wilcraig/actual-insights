const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// Per-account settings of the native app that Actual has no place for: which
// accounts the owner marked as investment accounts. A small JSON file in the
// data dir, `{ "investmentIds": [account ids] }`, written through a temp file
// and a rename. A missing, unreadable or corrupt file means no account is
// marked. Ids are validated on every read.

const FILE_NAME = 'mobile-account-settings.json';
const MAX_INVESTMENT_IDS = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const dataDir = () => process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';

function cleanIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) {
    if (typeof id === 'string' && ID_PATTERN.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_INVESTMENT_IDS) break;
  }
  return out;
}

async function readInvestmentIds(dir = dataDir()) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, FILE_NAME), 'utf8'));
    return cleanIds(parsed && parsed.investmentIds);
  } catch {
    return [];
  }
}

async function writeInvestmentIds(ids, dir = dataDir()) {
  const clean = cleanIds(ids);
  const finalPath = path.join(dir, FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ investmentIds: clean }), { mode: 0o600 });
  await fs.rename(tmpPath, finalPath);
  return clean;
}

// One read-modify-write at a time. Resolves to { before, ok }: the previous
// flag, and false when marking one more account would pass the limit.
let tail = Promise.resolve();
function setInvestment(id, investment, dir = dataDir()) {
  if (!ID_PATTERN.test(id)) throw new Error('bad account id');
  const run = tail.then(async () => {
    const current = await readInvestmentIds(dir);
    const before = current.includes(id);
    if (before === investment) return { before, ok: true };
    if (investment && current.length >= MAX_INVESTMENT_IDS) return { before, ok: false };
    await writeInvestmentIds(investment ? [...current, id] : current.filter((x) => x !== id), dir);
    return { before, ok: true };
  });
  tail = run.catch(() => {});
  return run;
}

module.exports = { readInvestmentIds, writeInvestmentIds, setInvestment, cleanIds, FILE_NAME, MAX_INVESTMENT_IDS };
