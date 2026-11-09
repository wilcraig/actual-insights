vi.mock('../../src/api-client', () => ({ fetchApi: vi.fn() }));
import { fetchApi } from '../../src/api-client';
import * as api from '../../src/chipmunk/chipmunk-api';

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
beforeEach(() => {
  fetchApi.mockReset();
});

test('paths and bodies', async () => {
  fetchApi.mockResolvedValue(ok({}));
  await api.getReports({ report: 'r1', month: '2026-10' });
  await api.getReports();
  await api.getTransactions('q=a');
  await api.suggest('a b', 5);
  await api.setMode(true);
  await api.saveSeries({ amount: 1 });
  await api.saveSeries({ amount: 1 }, 'ser 1');
  await api.stopSeries('ser-1');
  const calls = fetchApi.mock.calls.map((c) => [c[0], c[1]?.method, c[1]?.body]);
  expect(calls).toEqual([
    ['/api/chipmunk/reports?report=r1&month=2026-10', undefined, undefined],
    ['/api/chipmunk/reports', undefined, undefined],
    ['/api/chipmunk/transactions?q=a', undefined, undefined],
    ['/api/chipmunk/transactions/suggest?q=a+b&limit=5', undefined, undefined],
    ['/api/chipmunk-mode', 'PUT', '{"enabled":true}'],
    ['/api/chipmunk/budget-series', 'POST', '{"amount":1}'],
    ['/api/chipmunk/budget-series/ser%201', 'PUT', '{"amount":1}'],
    ['/api/chipmunk/budget-series/ser-1', 'DELETE', undefined],
  ]);
});

const caught = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
};

test('errors carry the status and the server error code', async () => {
  fetchApi.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'conflict' }) });
  let e = await caught(() => api.saveSeries({}));
  expect([e.message, e.status]).toEqual(['conflict', 409]);
  fetchApi.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('html'); } });
  e = await caught(() => api.getAccounts());
  expect([e.message, e.status]).toEqual(['Request failed (502)', 502]);
});

test('an unreachable API throws "Could not reach insights-api."', async () => {
  fetchApi.mockRejectedValue(new TypeError('network'));
  const err = await api.getAccounts().catch((e) => e);
  expect(err).toBeInstanceOf(api.ChipmunkApiError);
  expect(err.message).toBe('Could not reach insights-api.');
});

test('write calls', async () => {
  fetchApi.mockResolvedValue(ok({}));
  await api.patchTransactions(['t1', 't2'], { hidden: true });
  await api.setBudgeted('2026-11', 'c 1', 5000);
  await api.moveBudget('2026-11', { from: 'a', to: 'b', amount: 100 });
  expect(fetchApi.mock.calls.map((c) => [c[0], c[1]?.method, c[1]?.body])).toEqual([
    ['/api/chipmunk/transactions', 'PATCH', '{"ids":["t1","t2"],"changes":{"hidden":true}}'],
    ['/api/chipmunk/budget/2026-11/categories/c%201', 'PUT', '{"budgeted":5000}'],
    ['/api/chipmunk/budget/2026-11/move', 'POST', '{"from":"a","to":"b","amount":100}'],
  ]);
});
