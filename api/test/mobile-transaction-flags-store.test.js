const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/mobile-transaction-flags-store');

let dir;
const file = () => path.join(dir, store.FILE_NAME);
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-flags-'));
});

test('a missing file means nothing is flagged', async () => {
  expect({ ...(await store.readFlags(dir)) }).toEqual({});
  expect(await store.getFlags('t1', dir)).toEqual({ excluded: false, hidden: false });
});

test.each([['not json'], ['null'], ['[]'], ['{"flags":[1,2]}'], ['{"flags":"x"}'], ['']])('a corrupt file (%j) reads as empty', async (text) => {
  fs.writeFileSync(file(), text);
  expect({ ...(await store.readFlags(dir)) }).toEqual({});
});

test('bad entries are skipped, hidden implies excluded, unflagged entries are dropped', async () => {
  fs.writeFileSync(
    file(),
    JSON.stringify({ flags: { good: { excluded: true, hidden: false }, h: { hidden: true }, 'bad id!': { excluded: true }, str: 'x', nul: null, both_off: { excluded: false, hidden: false }, loose: { excluded: 'yes' } } })
  );
  expect({ ...(await store.readFlags(dir)) }).toEqual({ good: { excluded: true, hidden: false }, h: { excluded: true, hidden: true } });
});

test('setFlags writes atomically (no temp files left), returns the before-flags, and drops an entry when both flags go off', async () => {
  expect(await store.setFlags('t1', { excluded: true, hidden: false }, dir)).toEqual({ excluded: false, hidden: false });
  expect(await store.setFlags('t1', { excluded: false, hidden: true }, dir)).toEqual({ excluded: true, hidden: false });
  expect(await store.getFlags('t1', dir)).toEqual({ excluded: true, hidden: true });
  expect(fs.readdirSync(dir)).toEqual([store.FILE_NAME]);
  expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  await store.setFlags('t1', { excluded: false, hidden: false }, dir);
  expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ flags: {} });
});

test('an outside change to the file is picked up (mtime cache)', async () => {
  await store.setFlags('t1', { excluded: true, hidden: false }, dir);
  expect((await store.getFlags('t1', dir)).excluded).toBe(true);
  fs.writeFileSync(file(), JSON.stringify({ flags: { t2: { excluded: true, hidden: false } } }));
  expect((await store.getFlags('t1', dir)).excluded).toBe(false);
  expect((await store.getFlags('t2', dir)).excluded).toBe(true);
});

test('at most 20000 entries: reading keeps the first 20000, adding a new one is refused, changing an existing one is fine', async () => {
  const flags = {};
  for (let i = 0; i < store.MAX_ENTRIES + 5; i += 1) flags[`t${i}`] = { excluded: true, hidden: false };
  fs.writeFileSync(file(), JSON.stringify({ flags }));
  expect(Object.keys(await store.readFlags(dir))).toHaveLength(store.MAX_ENTRIES);
  await expect(store.setFlags('brand-new', { excluded: true, hidden: false }, dir)).rejects.toMatchObject({ code: 'FULL' });
  await store.setFlags('t0', { excluded: true, hidden: true }, dir);
  expect((await store.getFlags('t0', dir)).hidden).toBe(true);
});

test('nothing is pruned: flags for ids that no longer exist stay', async () => {
  await store.setFlags('gone-1', { excluded: true, hidden: false }, dir);
  await store.setFlags('t2', { excluded: true, hidden: false }, dir);
  expect(Object.keys(await store.readFlags(dir)).sort()).toEqual(['gone-1', 't2']);
});
