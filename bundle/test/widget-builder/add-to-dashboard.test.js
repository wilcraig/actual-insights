import { dashboardIdFromPath, addTextWidget, countText, refreshUntilVisible, actualApi } from '../../src/widget-builder/add-to-dashboard';

const ID = '0a1b2c3d-1111-2222-3333-444455556666';

test('dashboardIdFromPath only accepts a dashboard page, not Actual\'s own report routes', () => {
  expect(dashboardIdFromPath(`/reports/${ID}`)).toBe(ID);
  expect(dashboardIdFromPath(`/reports/${ID}/`)).toBe(ID);
  expect(dashboardIdFromPath('/reports')).toBeNull();
  expect(dashboardIdFromPath('/reports/net-worth')).toBeNull();
  expect(dashboardIdFromPath('/reports/balance-forecast')).toBeNull();
  expect(dashboardIdFromPath(`/reports/${ID}/extra`)).toBeNull();
  expect(dashboardIdFromPath(undefined)).toBeNull();
});

test('addTextWidget sends a markdown-card with the text, size and dashboard, and throws on an error result', async () => {
  const send = vi.fn(async () => undefined);
  await addTextWidget({ send, dashboardId: ID, text: '{{INSIGHTS:burn-rate:null}}', size: { w: 6, h: 4 } });
  expect(send).toHaveBeenCalledWith('dashboard-add-widget', {
    type: 'markdown-card',
    width: 6,
    height: 4,
    meta: { content: '{{INSIGHTS:burn-rate:null}}' },
    dashboard_page_id: ID,
  });
  await expect(addTextWidget({ send: async () => ({ error: { type: 'InternalError' } }), dashboardId: ID, text: 'x', size: { w: 1, h: 1 } })).rejects.toThrow();
});

test('countText counts text nodes carrying the text', () => {
  document.body.innerHTML = '<p>a {{X}} b</p><div><span>{{X}}</span><span>nope</span></div>';
  expect(countText(document, '{{X}}')).toBe(2);
});

test('refreshUntilVisible nudges a refetch and resolves true once one more copy appears', async () => {
  document.body.innerHTML = '<p>{{X}}</p>';
  const seen = vi.fn();
  window.addEventListener('visibilitychange', seen);
  setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>{{X}}</p>'), 40);
  expect(await refreshUntilVisible({ doc: document, win: window, text: '{{X}}', before: 1, waitMs: 1000, stepMs: 10 })).toBe(true);
  expect(seen).toHaveBeenCalled();
  window.removeEventListener('visibilitychange', seen);
});

test('refreshUntilVisible gives up false when no new copy appears (an identical widget already there does not count)', async () => {
  document.body.innerHTML = '<p>{{X}}</p>';
  expect(await refreshUntilVisible({ doc: document, win: window, text: '{{X}}', before: 1, waitMs: 60, stepMs: 10 })).toBe(false);
});

test('actualApi needs all of $send, $query and $q', () => {
  const send = () => {};
  expect(actualApi({ $send: send, $query: send, $q: send })).toEqual({ send, query: send, q: send });
  expect(actualApi({ $send: send, $query: send })).toBeNull();
  expect(actualApi({})).toBeNull();
});
