import { fetchApi } from '../api-client';

// Thrown for any non-ok response; `status` is the HTTP status (0 when the
// API was unreachable). Messages come from the server's `{ error }` and
// never include request bodies.
export class MobileApiError extends Error {
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
    throw new MobileApiError('Could not reach insights-api.');
  }

  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON error body: fall back to the status below.
    }
    throw new MobileApiError(body?.error || `Request failed (${response.status})`, response.status);
  }
  // 204 No Content (revoke) has no body to parse.
  if (response.status === 204) return null;
  return response.json();
}

// -> { tokens: [{ id, label, scope, createdAt, lastUsedAt }] }; never has secrets.
// `scope` is 'read' or 'write'.
export function listTokens() {
  return call('/api/mobile/tokens');
}

// -> { id, token, label, scope, createdAt }. `token` is the plain secret,
// returned only by this call. scope is 'read' (default) or 'write' (the device
// may also change categories and budget amounts).
export function createToken(label, scope = 'read') {
  return call('/api/mobile/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, scope }),
  });
}

// -> null (204)
export function revokeToken(id) {
  return call(`/api/mobile/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
