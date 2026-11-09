import { initialState, drillInto, zoomOut, buildBreakdownParams } from '../src/widgets/breakdown-nav';

const OPEN = { categoryId: 'catA', categoryName: 'Groceries', groupId: 'group1', groupName: 'Everyday Expenses' };

test('starts at level 3 (payees) for the clicked category', () => {
  const state = initialState(OPEN);
  expect(state).toMatchObject({
    level: 'payees',
    categoryId: 'catA',
    categoryName: 'Groceries',
    groupId: 'group1',
    groupName: 'Everyday Expenses',
  });
});

test('zooming out from payees goes to categories in the same group', () => {
  const state = initialState(OPEN);
  const zoomed = zoomOut(state);
  expect(zoomed).toMatchObject({ level: 'categories', groupId: 'group1', groupName: 'Everyday Expenses' });
});

test('zooming out from categories goes to groups', () => {
  const state = zoomOut(zoomOut(initialState(OPEN)));
  expect(state).toMatchObject({ level: 'groups' });
});

test('zooming out from groups is a no-op (stays at groups)', () => {
  const state = zoomOut(zoomOut(zoomOut(initialState(OPEN))));
  expect(state).toMatchObject({ level: 'groups' });
});

test('drilling into a group slice at level groups moves to categories for that group', () => {
  const groupsState = zoomOut(zoomOut(initialState(OPEN)));
  const drilled = drillInto(groupsState, { id: 'group2', label: 'Housing' });
  expect(drilled).toMatchObject({ level: 'categories', groupId: 'group2', groupName: 'Housing' });
});

test('drilling into a category slice at level categories moves to payees for that category', () => {
  const categoriesState = zoomOut(initialState(OPEN));
  const drilled = drillInto(categoriesState, { id: 'catB', label: 'Dining' });
  expect(drilled).toMatchObject({ level: 'payees', categoryId: 'catB', categoryName: 'Dining', groupId: 'group1' });
});

test('drilling into a payee slice at level payees moves to transactions for that payee', () => {
  const payeesState = initialState(OPEN);
  const drilled = drillInto(payeesState, { id: 'payeeX', label: 'Trader Joes' });
  expect(drilled).toMatchObject({
    level: 'transactions',
    categoryId: 'catA',
    categoryName: 'Groceries',
    payeeId: 'payeeX',
    payeeName: 'Trader Joes',
  });
});

test('drilling into a transaction slice at level transactions is a no-op (leaf level)', () => {
  const transactionsState = drillInto(initialState(OPEN), { id: 'payeeX', label: 'Trader Joes' });
  const drilled = drillInto(transactionsState, { id: 't1', label: 'irrelevant' });
  expect(drilled).toEqual(transactionsState);
});

test('zooming out from transactions goes back to payees for the same category', () => {
  const transactionsState = drillInto(initialState(OPEN), { id: 'payeeX', label: 'Trader Joes' });
  const zoomed = zoomOut(transactionsState);
  expect(zoomed).toMatchObject({ level: 'payees', categoryId: 'catA', categoryName: 'Groceries' });
});

test('clicking the same slice twice from the same state produces the same resulting state (no duplicate history)', () => {
  const groupsState = zoomOut(zoomOut(initialState(OPEN)));
  const first = drillInto(groupsState, { id: 'group2', label: 'Housing' });
  const second = drillInto(groupsState, { id: 'group2', label: 'Housing' });
  expect(second).toEqual(first);
});

describe('rollup entry (a PacingBars rollup bar, scoped to an arbitrary category id list)', () => {
  const ROLLUP_OPEN = { categoryIds: ['catA', 'catB', 'catC'], rollupTitle: 'Elizabeth Personal Care' };

  test('starts at level categories, scoped to the rollup\'s member categories', () => {
    const state = initialState(ROLLUP_OPEN);
    expect(state).toMatchObject({ level: 'categories', categoryIds: ['catA', 'catB', 'catC'], groupName: 'Elizabeth Personal Care' });
  });

  test('drilling into one of the rollup\'s categories moves to payees for it, keeping categoryIds as sticky context', () => {
    const drilled = drillInto(initialState(ROLLUP_OPEN), { id: 'catA', label: 'Botox' });
    expect(drilled).toMatchObject({ level: 'payees', categoryId: 'catA', categoryName: 'Botox', categoryIds: ['catA', 'catB', 'catC'] });
  });

  test('zooming out from that payees view returns to the SAME rollup\'s categories, not a real group', () => {
    const payeesState = drillInto(initialState(ROLLUP_OPEN), { id: 'catA', label: 'Botox' });
    const zoomed = zoomOut(payeesState);
    expect(zoomed).toMatchObject({ level: 'categories', categoryIds: ['catA', 'catB', 'catC'], groupName: 'Elizabeth Personal Care' });
  });

  test('drilling all the way to transactions and back still carries the rollup context', () => {
    let state = initialState(ROLLUP_OPEN);
    state = drillInto(state, { id: 'catA', label: 'Botox' });
    state = drillInto(state, { id: 'payeeX', label: 'Spa Co' });
    expect(state).toMatchObject({ level: 'transactions', categoryIds: ['catA', 'catB', 'catC'], categoryId: 'catA', payeeId: 'payeeX' });

    state = zoomOut(zoomOut(state));
    expect(state).toMatchObject({ level: 'categories', categoryIds: ['catA', 'catB', 'catC'] });
  });
});

describe('group-filtered entry (a standalone "pick your own groups" donut widget)', () => {
  const GROUPS_OPEN = { groupIds: ['group1', 'group2'] };

  test('starts at level groups, scoped to the curated group id list', () => {
    const state = initialState(GROUPS_OPEN);
    expect(state).toMatchObject({ level: 'groups', groupIds: ['group1', 'group2'] });
  });

  test('zooming out from groups is still a no-op, preserving the curated list', () => {
    const state = zoomOut(initialState(GROUPS_OPEN));
    expect(state).toMatchObject({ level: 'groups', groupIds: ['group1', 'group2'] });
  });

  test('drilling into one of the curated groups and back preserves groupIds as sticky context', () => {
    const categoriesState = drillInto(initialState(GROUPS_OPEN), { id: 'group1', label: 'Shopping' });
    expect(categoriesState).toMatchObject({ level: 'categories', groupId: 'group1', groupName: 'Shopping', groupIds: ['group1', 'group2'] });

    const backToGroups = zoomOut(categoriesState);
    expect(backToGroups).toMatchObject({ level: 'groups', groupIds: ['group1', 'group2'] });
  });
});

describe('buildBreakdownParams', () => {
  test('groups level with no curated list omits groupIds (every expense group)', () => {
    const params = buildBreakdownParams(initialState({ groupIds: [] }), '2026-10');
    expect(params.toString()).toBe('month=2026-10&level=groups');
  });

  test('groups level with a curated list sends a comma-joined groupIds', () => {
    const params = buildBreakdownParams(initialState({ groupIds: ['group1', 'group2'] }), '2026-10');
    expect(params.get('groupIds')).toBe('group1,group2');
  });

  test('categories level for a real group sends groupId', () => {
    const state = drillInto(initialState({ groupIds: [] }), { id: 'group1', label: 'Shopping' });
    const params = buildBreakdownParams(state, '2026-10');
    expect(params.get('groupId')).toBe('group1');
    expect(params.has('categoryIds')).toBe(false);
  });

  test('categories level for a rollup sends categoryIds instead of groupId', () => {
    const state = initialState({ categoryIds: ['catA', 'catB'], rollupTitle: 'Rollup' });
    const params = buildBreakdownParams(state, '2026-10');
    expect(params.get('categoryIds')).toBe('catA,catB');
    expect(params.has('groupId')).toBe(false);
  });

  test('transactions level sends categoryId and payeeId, using the sentinel for the no-payee bucket', () => {
    const state = drillInto(initialState(OPEN), { id: null, label: '(No payee)' });
    const params = buildBreakdownParams(state, '2026-10');
    expect(params.get('categoryId')).toBe('catA');
    expect(params.get('payeeId')).toBe('__none__');
  });
});

import {
  shiftMonth,
  stepMonth,
  clampMonth,
  earliestAllowedMonth,
  canStepBack,
  canStepForward,
  monthLabel,
  parseDonutConfig,
  FALLBACK_MONTHS_BACK,
} from '../src/widgets/breakdown-nav';

describe('month helpers', () => {
  test('shiftMonth crosses year boundaries both ways', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-11', -11)).toBe('2025-12');
    expect(shiftMonth('2026-11', 0)).toBe('2026-11');
  });

  test('monthLabel', () => {
    expect(monthLabel('2026-11')).toBe('November 2026');
    expect(monthLabel('2025-01')).toBe('January 2025');
  });

  test('earliestAllowedMonth uses the API value, bounded by current, else falls back 24 months', () => {
    expect(earliestAllowedMonth('2025-08', '2026-11')).toBe('2025-08');
    expect(earliestAllowedMonth('2027-01', '2026-11')).toBe('2026-11');
    expect(earliestAllowedMonth(undefined, '2026-11')).toBe('2024-11');
    expect(earliestAllowedMonth('garbage', '2026-11')).toBe(shiftMonth('2026-11', -FALLBACK_MONTHS_BACK));
  });

  test('stepMonth/clampMonth stay within [earliest, current]', () => {
    expect(stepMonth('2026-11', -1, '2025-01', '2026-11')).toBe('2026-10');
    expect(stepMonth('2026-11', 1, '2025-01', '2026-11')).toBe('2026-11');
    expect(stepMonth('2025-01', -1, '2025-01', '2026-11')).toBe('2025-01');
    expect(clampMonth('2030-01', '2025-01', '2026-11')).toBe('2026-11');
    expect(clampMonth('2020-01', '2025-01', '2026-11')).toBe('2025-01');
  });

  test('canStepBack / canStepForward', () => {
    expect(canStepBack('2025-01', '2025-01')).toBe(false);
    expect(canStepBack('2025-02', '2025-01')).toBe(true);
    expect(canStepForward('2026-11', '2026-11')).toBe(false);
    expect(canStepForward('2026-10', '2026-11')).toBe(true);
  });
});

describe('parseDonutConfig', () => {
  test('legacy array: ids, month arrows on', () => {
    expect(parseDonutConfig([])).toEqual({ groupIds: [], monthNav: true });
    expect(parseDonutConfig(['a', 'b'])).toEqual({ groupIds: ['a', 'b'], monthNav: true });
  });

  test('object form: groupIds and monthNav, missing key means on', () => {
    expect(parseDonutConfig({ groupIds: ['a'], monthNav: false })).toEqual({ groupIds: ['a'], monthNav: false });
    expect(parseDonutConfig({ groupIds: ['a'], monthNav: true })).toEqual({ groupIds: ['a'], monthNav: true });
    expect(parseDonutConfig({ groupIds: ['a'] })).toEqual({ groupIds: ['a'], monthNav: true });
    expect(parseDonutConfig({ monthNav: false })).toEqual({ groupIds: [], monthNav: false });
  });

  test('null, junk and non-array groupIds fall back to defaults', () => {
    expect(parseDonutConfig(null)).toEqual({ groupIds: [], monthNav: true });
    expect(parseDonutConfig(undefined)).toEqual({ groupIds: [], monthNav: true });
    expect(parseDonutConfig({ groupIds: 'x', monthNav: 'no' })).toEqual({ groupIds: [], monthNav: true });
    expect(parseDonutConfig([1, 'a'])).toEqual({ groupIds: ['a'], monthNav: true });
  });
});
