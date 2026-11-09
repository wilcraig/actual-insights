import { WIDGET_REGISTRY } from '../../src/widget-builder/registry';
import { defaultValues, isComplete, configFor, placeholderFor, showsGroupList } from '../../src/widget-builder/builder-state';

const widget = (id) => WIDGET_REGISTRY.find((w) => w.id === id);

test('defaultValues: pickers start empty, checkboxes off, selects on their first option', () => {
  expect(defaultValues(widget('account-balances'))).toEqual({ accountIds: [], labelContent: 'both', chart: 'stacked', range: '1M' });
  expect(defaultValues(widget('account-balance-list'))).toEqual({ accountIds: [], showTotal: false });
  expect(defaultValues(widget('month-end-net'))).toEqual({});
  expect(defaultValues(null)).toEqual({});
});

test('isComplete: required pickers need a pick; optional ones, checkboxes and selects do not', () => {
  expect(isComplete(widget('savings-goals-thermometers'), { categoryIds: [] })).toBe(false);
  expect(isComplete(widget('savings-goals-thermometers'), { categoryIds: ['c1'] })).toBe(true);
  expect(isComplete(widget('savings-rate-gauge'), { investmentGroupIds: [] })).toBe(true);
  expect(isComplete(widget('account-balance-list'), defaultValues(widget('account-balance-list')))).toBe(true);
  expect(isComplete(widget('month-end-net'), {})).toBe(true);
  expect(isComplete(null, {})).toBe(false);
});

test('isComplete: pacing bars with Category Groups ticked needs a checked group or a picked category', () => {
  const pacing = widget('pacing-bars');
  const values = { categoryIds: [], allGroups: true };
  expect(showsGroupList(pacing, values)).toBe(true);
  expect(isComplete(pacing, values, null)).toBe(false);
  expect(isComplete(pacing, values, [{ id: 'g1', checked: false }])).toBe(false);
  expect(isComplete(pacing, values, [{ id: 'g1', checked: true }])).toBe(true);
  expect(isComplete(pacing, { categoryIds: ['c1'], allGroups: true }, [{ id: 'g1', checked: false }])).toBe(true);
});

test('configFor and placeholderFor agree, and are empty while incomplete', () => {
  const pacing = widget('pacing-bars');
  expect(configFor(pacing, { categoryIds: [], allGroups: false })).toBeNull();
  expect(placeholderFor(pacing, { categoryIds: [], allGroups: false })).toBe('');

  expect(configFor(pacing, { categoryIds: ['c1'], allGroups: false })).toEqual({ body: ['c1'] });
  expect(placeholderFor(pacing, { categoryIds: ['c1'], allGroups: false })).toBe('{{INSIGHTS:pacing-bars:["c1"]}}');

  const rows = [{ id: 'g2', checked: true }, { id: 'g1', checked: false }, { id: 'g3', checked: true }];
  const values = { categoryIds: [], allGroups: true };
  expect(configFor(pacing, values, rows).body).toEqual({ categoryIds: [], allGroups: true, groupIds: ['g2', 'g3'] });
  expect(placeholderFor(pacing, values, rows)).toBe('{{INSIGHTS:pacing-bars:{"categoryIds":[],"allGroups":true,"groupIds":["g2","g3"]}}}');
});

test('a single-field widget\'s body is the bare value, even when that value is an empty array', () => {
  const gauge = widget('savings-rate-gauge');
  expect(configFor(gauge, { investmentGroupIds: [] })).toEqual({ body: [] });
  expect(placeholderFor(gauge, { investmentGroupIds: ['g1'] })).toBe('{{INSIGHTS:savings-rate-gauge:["g1"]}}');
});

describe('spending-breakdown-donut Month arrows', () => {
  const donut = widget('spending-breakdown-donut');

  test('the checkbox starts checked via the field default; other checkboxes stay off', () => {
    expect(defaultValues(donut)).toEqual({ monthNav: true });
    expect(defaultValues(widget('account-balance-list')).showTotal).toBe(false);
  });

  test('checked emits the legacy-compatible [], unchecked the object form', () => {
    expect(placeholderFor(donut, { monthNav: true })).toBe('{{INSIGHTS:spending-breakdown-donut:[]}}');
    expect(configFor(donut, { monthNav: true })).toEqual({ body: [] });
    expect(placeholderFor(donut, { monthNav: false })).toBe('{{INSIGHTS:spending-breakdown-donut:{"groupIds":[],"monthNav":false}}}');
    expect(configFor(donut, { monthNav: false })).toEqual({ body: { groupIds: [], monthNav: false } });
  });

  test('never blocks generation', () => {
    expect(isComplete(donut, { monthNav: false })).toBe(true);
    expect(isComplete(donut, defaultValues(donut))).toBe(true);
  });
});
