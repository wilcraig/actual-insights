vi.mock('../src/api-client', () => ({ fetchApi: vi.fn() }));

import { fetchApi } from '../src/api-client';
import { listTokens, createToken, revokeToken, MobileApiError } from '../src/insights-page/mobile-api';

beforeEach(() => fetchApi.mockReset());

test('listTokens GETs /api/mobile/tokens', async () => {
  const body = { tokens: [{ id: 't1', label: 'Phone', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null }] };
  fetchApi.mockResolvedValue({ ok: true, status: 200, json: async () => body });
  expect(await listTokens()).toEqual(body);
  expect(fetchApi).toHaveBeenCalledWith('/api/mobile/tokens', undefined);
});

test('createToken POSTs the label as JSON and accepts 201', async () => {
  const body = { id: 't1', token: 'secret', label: 'Phone', createdAt: '2026-01-01T00:00:00Z' };
  fetchApi.mockResolvedValue({ ok: true, status: 201, json: async () => body });
  expect(await createToken('Phone')).toEqual(body);
  const [path, options] = fetchApi.mock.calls[0];
  expect(path).toBe('/api/mobile/tokens');
  expect(options.method).toBe('POST');
  expect(options.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(options.body)).toEqual({ label: 'Phone' });
});

test('revokeToken DELETEs the encoded id and handles the empty 204 body', async () => {
  const json = vi.fn();
  fetchApi.mockResolvedValue({ ok: true, status: 204, json });
  expect(await revokeToken('a/b')).toBeNull();
  expect(fetchApi).toHaveBeenCalledWith('/api/mobile/tokens/a%2Fb', { method: 'DELETE' });
  expect(json).not.toHaveBeenCalled();
});

test('error responses carry the server message and status', async () => {
  fetchApi.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: 'Too many tokens' }) });
  const err = await createToken('x').catch((e) => e);
  expect(err).toBeInstanceOf(MobileApiError);
  expect(err.message).toBe('Too many tokens');
  expect(err.status).toBe(409);
});

test('a non-JSON error body falls back to the status', async () => {
  fetchApi.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('x'); } });
  await expect(listTokens()).rejects.toThrow('Request failed (502)');
});

test('an unreachable API maps to a friendly message without leaking the label', async () => {
  fetchApi.mockRejectedValue(new TypeError('Failed to fetch'));
  const err = await createToken('Secret label').catch((e) => e);
  expect(err.message).toBe('Could not reach insights-api.');
  await expect(revokeToken('t1')).rejects.toThrow('Could not reach insights-api.');
});
