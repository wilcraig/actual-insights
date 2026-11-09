import { isReportsPath, reportPath, reportFromPath } from '../../src/chipmunk/shell/report-routes';

const list = { reports: [
  { id: 'd1', title: 'Main', kind: 'dashboard' },
  { id: 'd2', title: 'Other', kind: 'dashboard' },
  { id: 'c1', title: 'Saved', kind: 'custom' },
] };

test('Reports paths', () => {
  expect(isReportsPath('/reports')).toBe(true);
  expect(isReportsPath('/reports/d1')).toBe(true);
  expect(isReportsPath('/reportsx')).toBe(false);
  expect(isReportsPath('/budget')).toBe(false);
  expect(isReportsPath(undefined)).toBe(false);
});

test('a dashboard is /reports/<id>, a saved report /reports/custom/<id>', () => {
  expect(reportPath(list.reports[0])).toBe('/reports/d1');
  expect(reportPath(list.reports[2])).toBe('/reports/custom/c1');
  expect(reportPath(null)).toBe('/reports');
  expect(reportPath({ id: 'a b', kind: 'dashboard' })).toBe('/reports/a%20b');
});

test('the entry Actual is showing', () => {
  expect(reportFromPath(list, '/reports/d2').title).toBe('Other');
  expect(reportFromPath(list, '/reports/d2/').title).toBe('Other');
  expect(reportFromPath(list, '/reports/custom/c1').title).toBe('Saved');
  expect(reportFromPath(list, '/reports/c1')?.kind).toBeUndefined(); // c1 is a saved report, not a dashboard route
  expect(reportFromPath(list, '/reports/custom/d1')).toBeNull();
  expect(reportFromPath(list, '/reports')).toBeNull();
  expect(reportFromPath(list, '/reports/unknown')).toBeNull();
  expect(reportFromPath(list, '/reports/custom')).toBeNull();
  expect(reportFromPath(null, '/reports/d1')).toBeNull();
  expect(reportFromPath(list, '/reports/%E0%A4%A')).toBeNull();
});
