const fs = require('fs');
const os = require('os');
const path = require('path');

const { PALETTE_KEYS, createColorResolver, colorIndexes } = require('../src/mobile/v1/colors');
const { readColors, writeColors, setColor, FILE_NAME } = require('../src/mobile-colors-store');
const { schema } = require('./helpers/native-v1');

const groups = [
  { id: 'g0', name: 'First', categories: [{ id: 'c0a' }, { id: 'c0b', hidden: true }] },
  { id: 'gh', name: 'Hidden', hidden: true, categories: [{ id: 'chh' }] },
  { id: 'g1', name: 'Second', categories: [{ id: 'c1a' }] },
  { id: 'g2', name: 'Income', is_income: true, categories: [{ id: 'c2a' }] },
];

test('the palette is the contract enum, in order', () => {
  expect(PALETTE_KEYS).toEqual(schema.definitions.colorKey.enum);
});

describe('colour helper', () => {
  test('groups default by position among non-hidden groups (hidden ones never shift anyone; income counts)', () => {
    expect([...colorIndexes(groups)]).toEqual([['g0', 0], ['g1', 1], ['g2', 2]]);
    const colors = createColorResolver(groups);
    expect(['g0', 'g1', 'g2'].map(colors.group)).toEqual(['blue', 'teal', 'green']);
    expect(colors.groupExplicit('g0')).toBe(false);
  });

  test('the rotation wraps after 12 groups', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `g${i}`, categories: [] }));
    const colors = createColorResolver(many);
    expect(colors.group('g11')).toBe('gray');
    expect(colors.group('g12')).toBe('blue');
    expect(colors.group('g13')).toBe('teal');
  });

  test('explicit colours override; a category inherits its group, explicit or default', () => {
    const colors = createColorResolver(groups, { groups: { g1: 'red' }, categories: { c0a: 'pink' } });
    expect(colors.group('g1')).toBe('red');
    expect(colors.groupExplicit('g1')).toBe(true);
    expect(colors.category('c1a')).toBe('red');
    expect(colors.categoryExplicit('c1a')).toBe(false);
    expect(colors.category('c0a')).toBe('pink');
    expect(colors.categoryExplicit('c0a')).toBe(true);
    expect(colors.category('c2a')).toBe('green');
    // The other categories of the group are untouched by one explicit category.
    expect(colors.category('c0b')).toBe('blue');
  });

  test('a position never changes when only colours change; hidden group and unknown ids fall back to gray', () => {
    const colors = createColorResolver(groups, { groups: { g0: 'brown' } });
    expect(colors.group('g1')).toBe('teal');
    expect(colors.group('gh')).toBe('gray');
    expect(colors.category('chh')).toBe('gray');
    expect(colors.category('nope')).toBe('gray');
    expect(colors.group('nope')).toBe('gray');
  });

  test('explicit colours for ids that no longer exist are ignored', () => {
    const colors = createColorResolver(groups, { categories: { gone: 'red' } });
    expect(colors.categoryExplicit('gone')).toBe(false);
    expect(colors.hasCategory('gone')).toBe(false);
  });
});

describe('colours store', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colors-store-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('missing file = no explicit colours', async () => {
    expect(await readColors(dir)).toEqual({ groups: {}, categories: {} });
  });

  test('corrupt or oddly shaped files = no explicit colours', async () => {
    for (const text of ['{nope', '[]', 'null', '"x"', '{"groups":[1],"categories":"x"}']) {
      fs.writeFileSync(path.join(dir, FILE_NAME), text);
      expect(await readColors(dir)).toEqual({ groups: {}, categories: {} });
    }
  });

  test('entries with a bad id or key are dropped, good ones kept', async () => {
    fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify({ groups: { ok: 'red', 'bad id': 'red', alsobad: 'magenta', n: 5 }, categories: { ['x'.repeat(65)]: 'red', fine_1: 'gray' } }));
    expect(await readColors(dir)).toEqual({ groups: { ok: 'red' }, categories: { fine_1: 'gray' } });
  });

  test('setColor writes atomically (no temp files left, private mode), returns the previous key, null removes', async () => {
    expect(await setColor('groups', 'g1', 'red', dir)).toBeNull();
    expect(await setColor('groups', 'g1', 'blue', dir)).toBe('red');
    expect(await setColor('categories', 'c1', 'lime', dir)).toBeNull();
    expect(await readColors(dir)).toEqual({ groups: { g1: 'blue' }, categories: { c1: 'lime' } });
    expect(await setColor('groups', 'g1', null, dir)).toBe('blue');
    expect(await readColors(dir)).toEqual({ groups: {}, categories: { c1: 'lime' } });
    expect(fs.readdirSync(dir)).toEqual([FILE_NAME]);
    expect(fs.statSync(path.join(dir, FILE_NAME)).mode & 0o777).toBe(0o600);
  });

  test('concurrent sets do not lose each other', async () => {
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => setColor('groups', id, 'teal', dir)));
    expect(Object.keys((await readColors(dir)).groups).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('setColor and writeColors refuse bad input', async () => {
    expect(() => setColor('groups', 'g1', 'magenta', dir)).toThrow();
    expect(() => setColor('groups', 'bad id', 'red', dir)).toThrow();
    expect(() => setColor('payees', 'g1', 'red', dir)).toThrow();
    expect(await writeColors({ groups: { g: 'nope', h: 'red' } }, dir)).toEqual({ groups: { h: 'red' }, categories: {} });
  });
});
