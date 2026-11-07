import { computeBarState, collectCategoryIds, buildPacingRows, parsePacingConfig, buildPacingItems } from '../src/widgets/pacing-data';

test('budgeted: 0 never produces NaN or Infinity', () => {
  const r = computeBarState({ budgeted: 0, spent: 500 }, { daysElapsed: 10, daysInMonth: 30 });
  expect(r.fillPct).toBe(0);
  expect(Number.isFinite(r.fillPct)).toBe(true);
});

test('over budget is flagged and fill is capped at 100', () => {
  const r = computeBarState({ budgeted: 10000, spent: 15000 }, { daysElapsed: 10, daysInMonth: 30 });
  expect(r.status).toBe('over');
  expect(r.fillPct).toBe(100);
});

test('tick position reflects elapsed days', () => {
  const r = computeBarState({ budgeted: 10000, spent: 4000 }, { daysElapsed: 15, daysInMonth: 30 });
  expect(r.tickPct).toBe(50);
});

test('$40 spent on a $100 budget shows under, 40% fill, non-negative', () => {
  const r = computeBarState({ budgeted: 10000, spent: 4000 }, { daysElapsed: 15, daysInMonth: 30 });
  expect(r.fillPct).toBe(40);
  expect(r.status).toBe('under');
});

test('a refund-heavy category (negative spent = net inflow) clamps fill to 0, not negative', () => {
  const r = computeBarState({ budgeted: 10000, spent: -2000 }, { daysElapsed: 15, daysInMonth: 30 });
  expect(r.fillPct).toBe(0);
  expect(r.fillPct).toBeGreaterThanOrEqual(0);
  expect(r.status).toBe('under');
});

describe('collectCategoryIds', () => {
  test('returns plain category id strings unchanged', () => {
    expect(collectCategoryIds(['catA', 'catB'])).toEqual(['catA', 'catB']);
  });

  test('flattens a rollup\'s budgets list in alongside plain ids', () => {
    const ids = collectCategoryIds(['catA', { title: 'Elizabeth Personal Care', budgets: ['catB', 'catC'] }]);
    expect(ids).toEqual(['catA', 'catB', 'catC']);
  });

  test('dedupes an id that appears both standalone and inside a rollup', () => {
    const ids = collectCategoryIds(['catA', { title: 'Rollup', budgets: ['catA', 'catB'] }]);
    expect(ids).toEqual(['catA', 'catB']);
  });
});

describe('buildPacingRows', () => {
  const CATEGORIES = [
    { id: 'catA', name: 'Hair', groupId: 'g1', groupName: 'Personal Care', spent: 4000, balance: 6000 },
    { id: 'catB', name: 'Spa', groupId: 'g1', groupName: 'Personal Care', spent: 1000, balance: -1000 },
    { id: 'catC', name: 'Skincare', groupId: 'g1', groupName: 'Personal Care', spent: 500, balance: 500 },
  ];

  test('a plain category id becomes its own row with rollover-aware budgeted (balance + spent)', () => {
    const rows = buildPacingRows(['catA'], CATEGORIES);
    expect(rows).toEqual([
      { kind: 'category', id: 'catA', name: 'Hair', groupId: 'g1', groupName: 'Personal Care', spent: 4000, budgeted: 10000 },
    ]);
  });

  test('a rollup sums spent and rollover-aware budgeted across its member categories', () => {
    const rows = buildPacingRows([{ title: 'Elizabeth Personal Care', budgets: ['catA', 'catB', 'catC'] }], CATEGORIES);
    // spent: 4000+1000+500=5500; budgeted (balance+spent per member): (6000+4000)+(-1000+1000)+(500+500)=10000+0+1000=11000
    expect(rows).toEqual([
      { kind: 'rollup', id: 'rollup:Elizabeth Personal Care', name: 'Elizabeth Personal Care', spent: 5500, budgeted: 11000, memberIds: ['catA', 'catB', 'catC'] },
    ]);
  });

  test('a rollup with some members missing from the API response sums only the present ones, and memberIds reflects only those', () => {
    const rows = buildPacingRows([{ title: 'Partial', budgets: ['catA', 'does-not-exist'] }], CATEGORIES);
    expect(rows).toEqual([{ kind: 'rollup', id: 'rollup:Partial', name: 'Partial', spent: 4000, budgeted: 10000, memberIds: ['catA'] }]);
  });

  test('a rollup with no resolvable members is omitted rather than shown as an empty bar', () => {
    const rows = buildPacingRows([{ title: 'All Missing', budgets: ['does-not-exist'] }], CATEGORIES);
    expect(rows).toEqual([]);
  });

  test('preserves the order of mixed plain ids and rollups as given', () => {
    const rows = buildPacingRows(['catC', { title: 'Rollup', budgets: ['catA', 'catB'] }, 'catA'], CATEGORIES);
    expect(rows.map((r) => r.id)).toEqual(['catC', 'rollup:Rollup', 'catA']);
  });

  test('a malformed item (neither a string nor a well-formed rollup) is skipped, not thrown', () => {
    const rows = buildPacingRows(['catA', { oops: true }, null, 42], CATEGORIES);
    expect(rows.map((r) => r.id)).toEqual(['catA']);
  });
});

describe('parsePacingConfig', () => {
  test('legacy array, new object, and junk', () => {
    expect(parsePacingConfig(['a'])).toEqual({ items: ['a'], allGroups: false });
    expect(parsePacingConfig({ categoryIds: ['a'], allGroups: true })).toEqual({ items: ['a'], allGroups: true });
    expect(parsePacingConfig({ categoryIds: ['a'] })).toEqual({ items: ['a'], allGroups: false });
    expect(parsePacingConfig({ categoryIds: [], allGroups: true, groupIds: ['g1', 3, 'g2'] })).toEqual({ items: [], allGroups: true, groupIds: ['g1', 'g2'] });
    expect(parsePacingConfig({ categoryIds: [], allGroups: true, groupIds: 'g1' })).toEqual({ items: [], allGroups: true });
    expect(parsePacingConfig({ allGroups: 'yes' })).toEqual({ items: [], allGroups: false });
    expect(parsePacingConfig(null)).toEqual({ items: [], allGroups: false });
    expect(parsePacingConfig('x')).toEqual({ items: [], allGroups: false });
  });
});

describe('buildPacingItems', () => {
  const groups = [
    { id: 'g1', name: 'Usual', isIncome: false, isTransfer: false, categoryIds: ['c1', 'c2'] },
    { id: 'g2', name: 'Personal Income', isIncome: true, isTransfer: false, categoryIds: ['c3'] },
    { id: 'g3', name: 'Transfers', isIncome: false, isTransfer: true, categoryIds: ['c4'] },
    { id: 'g4', name: 'Empty', isIncome: false, isTransfer: false, categoryIds: [] },
    { id: 'g5', name: 'Fun', categoryIds: ['c5'] },
  ];

  test('without allGroups the items pass through untouched', () => {
    const items = ['c1', { title: 'T', budgets: ['c2'] }];
    expect(buildPacingItems({ items, allGroups: false }, groups)).toBe(items);
  });

  test('allGroups: one rollup per visible expense group with categories, then the picked items', () => {
    expect(buildPacingItems({ items: ['c9'], allGroups: true }, groups)).toEqual([
      { title: 'Usual', budgets: ['c1', 'c2'] },
      { title: 'Fun', budgets: ['c5'] },
      'c9',
    ]);
  });

  test('groupIds: only those groups, in exactly that order; unknown ids and duplicates ignored; later groups not added', () => {
    expect(buildPacingItems({ items: ['c9'], allGroups: true, groupIds: ['g5', 'gone', 'g1', 'g5', 'g2', 'g3'] }, groups)).toEqual([
      { title: 'Fun', budgets: ['c5'] },
      { title: 'Usual', budgets: ['c1', 'c2'] },
      'c9',
    ]);
    expect(buildPacingItems({ items: ['c9'], allGroups: true, groupIds: [] }, groups)).toEqual(['c9']);
    expect(buildPacingItems({ items: [], allGroups: true, groupIds: ['g1'] }, [...groups, { id: 'gNew', name: 'New', categoryIds: ['c7'] }])).toEqual([{ title: 'Usual', budgets: ['c1', 'c2'] }]);
  });

  test('allGroups without groupIds is every visible group in the given order (existing placeholders)', () => {
    expect(buildPacingItems({ items: [], allGroups: true }, groups).map((i) => i.title)).toEqual(['Usual', 'Fun']);
  });

  test('allGroups tolerates a missing group list', () => {
    expect(buildPacingItems({ items: ['c9'], allGroups: true }, undefined)).toEqual(['c9']);
  });

  test('group rollups feed buildPacingRows and collectCategoryIds unchanged; same-named groups get unique row ids', () => {
    const items = buildPacingItems({ items: [], allGroups: true }, [
      { name: 'Same', categoryIds: ['c1'] },
      { name: 'Same', categoryIds: ['c2'] },
    ]);
    expect(collectCategoryIds(items)).toEqual(['c1', 'c2']);
    const cats = [
      { id: 'c1', name: 'A', spent: 100, balance: 900 },
      { id: 'c2', name: 'B', spent: 50, balance: 150 },
    ];
    const rows = buildPacingRows(items, cats);
    expect(rows.map((r) => [r.kind, r.name, r.spent, r.budgeted, r.memberIds])).toEqual([
      ['rollup', 'Same', 100, 1000, ['c1']],
      ['rollup', 'Same', 50, 200, ['c2']],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });
});
