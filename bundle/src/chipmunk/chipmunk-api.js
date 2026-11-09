import { fetchApi } from '../api-client';

export class ChipmunkApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function call(path, options) {
  let response;
  try {
    response = await fetchApi(path, options);
  } catch {
    throw new ChipmunkApiError('Could not reach insights-api.');
  }
  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body.
    }
    throw new ChipmunkApiError(body?.error || `Request failed (${response.status})`, response.status);
  }
  return response.json();
}

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const getMode = () => call('/api/chipmunk-mode');
export const setMode = (enabled) => call('/api/chipmunk-mode', json('PUT', { enabled }));

export const getReportList = () => call('/api/chipmunk/report-list');
export function getReports({ report, month } = {}) {
  const p = new URLSearchParams();
  if (report) p.set('report', report);
  if (month) p.set('month', month);
  const qs = p.toString();
  return call(`/api/chipmunk/reports${qs ? `?${qs}` : ''}`);
}
export const getAccounts = () => call('/api/chipmunk/accounts');
export const getTransactions = (query) => call(`/api/chipmunk/transactions${query ? `?${query}` : ''}`);
export const suggest = (q, limit = 8) => call(`/api/chipmunk/transactions/suggest?${new URLSearchParams({ q, limit: String(limit) })}`);
export const getBudget = (month) => call(`/api/chipmunk/budget/${month}`);
export const getSeriesList = () => call('/api/chipmunk/budget-series');
export const saveSeries = (body, id = null) =>
  call(id ? `/api/chipmunk/budget-series/${encodeURIComponent(id)}` : '/api/chipmunk/budget-series', json(id ? 'PUT' : 'POST', body));
export const stopSeries = (id) => call(`/api/chipmunk/budget-series/${encodeURIComponent(id)}`, { method: 'DELETE' });

// Writes (the owner's web view; audited as 'web'). Bulk transaction edit:
// ids (at most 50) and one set of changes; answers { updated, unchanged, skipped }.
export const patchTransactions = (ids, changes) => call('/api/chipmunk/transactions', json('PATCH', { ids, changes }));
export const setBudgeted = (month, categoryId, budgeted) =>
  call(`/api/chipmunk/budget/${month}/categories/${encodeURIComponent(categoryId)}`, json('PUT', { budgeted }));
export const moveBudget = (month, { from, to, amount }) => call(`/api/chipmunk/budget/${month}/move`, json('POST', { from, to, amount }));
