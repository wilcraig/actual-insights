import { buildPlaceholder, pacingBody } from '../../src/widget-builder/placeholder';

test('a single-field widget emits the raw value, not a keyed object', () => {
  const result = buildPlaceholder(
    'pacing-bars',
    [{ key: 'categoryIds' }],
    { categoryIds: ['catA', 'catB'] }
  );
  expect(result).toBe('{{INSIGHTS:pacing-bars:["catA","catB"]}}');
});

test('a multi-field widget emits a keyed object', () => {
  const result = buildPlaceholder(
    'some-widget',
    [{ key: 'accountIds' }, { key: 'rangeMonths' }],
    { accountIds: ['acc1'], rangeMonths: 3 }
  );
  expect(result).toBe('{{INSIGHTS:some-widget:{"accountIds":["acc1"],"rangeMonths":3}}}');
});

test('a zero-field widget emits an empty object', () => {
  expect(buildPlaceholder('month-end-net', [], {})).toBe('{{INSIGHTS:month-end-net:{}}}');
});

test('a value needing JSON escaping round-trips through JSON.parse unchanged', () => {
  const id = 'cat"with\\quote';
  const result = buildPlaceholder('pacing-bars', [{ key: 'categoryIds' }], { categoryIds: [id] });
  const jsonBody = result.slice('{{INSIGHTS:pacing-bars:'.length, -'}}'.length);
  expect(JSON.parse(jsonBody)).toEqual([id]);
});

test('pacingBody: legacy bare array unless Category Groups is ticked, then the object', () => {
  expect(pacingBody({ categoryIds: ['a', 'b'], allGroups: false })).toEqual(['a', 'b']);
  expect(pacingBody({ categoryIds: ['a'] })).toEqual(['a']);
  expect(pacingBody({ categoryIds: ['a'], allGroups: true })).toEqual({ categoryIds: ['a'], allGroups: true });
  expect(pacingBody({ categoryIds: [], allGroups: true })).toEqual({ categoryIds: [], allGroups: true });
});

test('a widget-supplied body function overrides the generic rule', () => {
  const result = buildPlaceholder('pacing-bars', [{ key: 'categoryIds' }, { key: 'allGroups' }], { categoryIds: ['a'], allGroups: true }, pacingBody);
  expect(result).toBe('{{INSIGHTS:pacing-bars:{"categoryIds":["a"],"allGroups":true}}}');
});
