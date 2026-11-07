const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// The owner's explicit colours for category groups and categories, shown in
// the native app. A small JSON file in the data dir,
// `{ "groups": { <id>: <colorKey> }, "categories": { <id>: <colorKey> } }`,
// written through a temp file and a rename. A missing, unreadable or corrupt
// file (or entry) means "no explicit colour": the automatic defaults apply.
// Ids and keys are validated on every read, so nothing odd in the file can
// reach a response.

const FILE_NAME = 'mobile-colors.json';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ENTRIES = 2000;
// Keep in step with PALETTE_KEYS in mobile/v1/colors.js (the contract's colorKey).
const COLOR_KEYS = ['blue', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'pink', 'purple', 'indigo', 'brown', 'gray'];

const dataDir = () => process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';

function cleanMap(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [id, key] of Object.entries(map)) {
    if (Object.keys(out).length >= MAX_ENTRIES) break;
    if (ID_PATTERN.test(id) && typeof key === 'string' && COLOR_KEYS.includes(key)) out[id] = key;
  }
  return out;
}

const clean = (parsed) => ({ groups: cleanMap(parsed && parsed.groups), categories: cleanMap(parsed && parsed.categories) });

async function readColors(dir = dataDir()) {
  try {
    return clean(JSON.parse(await fs.readFile(path.join(dir, FILE_NAME), 'utf8')));
  } catch {
    return clean(null);
  }
}

async function writeColors(colors, dir = dataDir()) {
  const value = clean(colors);
  const finalPath = path.join(dir, FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmpPath, finalPath);
  return value;
}

// One read-modify-write at a time, so two quick PUTs can't lose each other.
let tail = Promise.resolve();

// kind: 'groups' | 'categories'; color: a key, or null to remove. Returns the
// previous key (or null) so the caller can audit it.
function setColor(kind, id, color, dir = dataDir()) {
  if ((kind !== 'groups' && kind !== 'categories') || !ID_PATTERN.test(id)) throw new Error('bad colour target');
  if (color !== null && !COLOR_KEYS.includes(color)) throw new Error('bad colour key');
  const run = tail.then(async () => {
    const current = await readColors(dir);
    const before = current[kind][id] || null;
    if (color === null) delete current[kind][id];
    else current[kind][id] = color;
    await writeColors(current, dir);
    return before;
  });
  tail = run.catch(() => {});
  return run;
}

module.exports = { readColors, writeColors, setColor, FILE_NAME, COLOR_KEYS };
