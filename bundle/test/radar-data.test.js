import { parseRadarConfig, excludeCategories, truncateToWidth, layoutVertical } from '../src/widgets/radar-data';

describe('parseRadarConfig', () => {
  test('null and junk give the horizontal default', () => {
    for (const c of [null, undefined, 'x', 3, [], {}]) {
      expect(parseRadarConfig(c)).toEqual({ layout: 'horizontal', excludeCategoryIds: [] });
    }
  });
  test('vertical, unknown layout, and non-string ids', () => {
    expect(parseRadarConfig({ layout: 'vertical', excludeCategoryIds: ['a', 2, null, 'b'] })).toEqual({ layout: 'vertical', excludeCategoryIds: ['a', 'b'] });
    expect(parseRadarConfig({ layout: 'diagonal' }).layout).toBe('horizontal');
    expect(parseRadarConfig({ excludeCategoryIds: 'a' }).excludeCategoryIds).toEqual([]);
  });
});

describe('excludeCategories', () => {
  const items = [{ id: 1, categoryId: 'a' }, { id: 2, categoryId: 'b' }, { id: 3, categoryId: null }, { id: 4 }];
  test('removes excluded categories, never ones with an unknown category', () => {
    expect(excludeCategories(items, ['a']).map((i) => i.id)).toEqual([2, 3, 4]);
    expect(excludeCategories(items, ['a', 'b']).map((i) => i.id)).toEqual([3, 4]);
  });
  test('nothing excluded returns everything', () => {
    expect(excludeCategories(items, [])).toBe(items);
  });
});

const measure = (t) => t.length * 6;

describe('truncateToWidth', () => {
  test('fits unchanged, else ellipsised to fit', () => {
    expect(truncateToWidth('Gym', 100, measure)).toBe('Gym');
    const out = truncateToWidth('A very long subscription name', 60, measure);
    expect(out.endsWith('…')).toBe(true);
    expect(measure(out)).toBeLessThanOrEqual(60);
  });
});

describe('layoutVertical', () => {
  const today = new Date(2026, 10, 1);
  const opts = { today, windowDays: 30, width: 300, measure, amountText: (c) => `$${Math.abs(c) / 100}` };
  const item = (date, name = 'Name', cents = -1000) => ({ date, payeeName: name, amountCents: cents });

  test('dots follow dates down a single axis; spread-out items sit level with their dots', () => {
    const l = layoutVertical([item('2026-11-01'), item('2026-11-11'), item('2026-12-01')], opts);
    expect(l.rows.map((r) => r.dotY)).toEqual([12, 12 + 10 * 12, 12 + 30 * 12]);
    expect(l.rows.some((r) => r.displaced)).toBe(false);
    expect(l.ticks.map((t) => t.day)).toEqual([0, 7, 14, 21, 28]);
  });

  test('renewals on the same or nearby days are stacked so labels never overlap', () => {
    const l = layoutVertical([item('2026-11-05'), item('2026-11-05'), item('2026-11-05'), item('2026-11-06')], opts);
    for (let i = 1; i < l.rows.length; i += 1) expect(l.rows[i].rowTop - l.rows[i - 1].rowTop).toBeGreaterThanOrEqual(34);
    expect(l.rows.some((r) => r.displaced)).toBe(true);
    expect(l.height).toBeGreaterThan(l.rows[l.rows.length - 1].rowTop);
  });

  test('dates outside the window are clamped; long names are truncated to the width', () => {
    const l = layoutVertical([item('2026-10-01'), item('2027-03-01', 'x'.repeat(80))], { ...opts, width: 200 });
    expect(l.rows[0].dotY).toBe(12);
    expect(l.rows[1].dotY).toBe(12 + 30 * 12);
    expect(l.rows[1].name.endsWith('…')).toBe(true);
    expect(measure(l.rows[1].name) + measure(' $10')).toBeLessThanOrEqual(200 - l.labelX - 12);
  });

  test('no items still gives an axis', () => {
    const l = layoutVertical([], opts);
    expect(l.rows).toEqual([]);
    expect(l.height).toBeGreaterThan(300);
  });
});
