const { verifyToken } = require('../mobile-tokens-store');

// Bearer-token auth and per-token rate limiting for the routes a paired
// companion app can reach (/api/mobile/summary and /api/mobile/v1/*). Both
// routers are mounted BEFORE the global Actual-session guard in server.js and
// have their own auth: a revocable device token, never an Actual session.
//
// Every auth failure (no header, wrong scheme, malformed, unknown, revoked)
// gets the identical response, so a caller learns nothing about why. No CORS
// headers are ever set: a browser page can't call these, only a native app.

const RATE_WINDOW_MS = 60 * 1000;
const READ_LIMIT = 60;
const WRITE_LIMIT = 20;

const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/i;

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Bearer realm="actual-insights"');
  res.set('Cache-Control', 'no-store');
  res.status(401).json({ error: 'unauthorized' });
}

async function bearerAuth(req, res, next) {
  const match = BEARER.exec(req.get('Authorization') || '');
  const record = match ? await verifyToken(match[1]) : null;
  if (!record) {
    unauthorized(res);
    return;
  }
  req.deviceToken = record;
  next();
}

// Per-token sliding windows, one map per bucket: token id -> timestamps (ms)
// inside the window. /summary and the v1 reads share the 'read' bucket; writes
// have their own. Only requests carrying a valid token are counted, so
// garbage traffic can't use up a real device's allowance.
const windows = { read: new Map(), write: new Map() };

function rateLimit(bucket, limit, errorBody) {
  const hits = windows[bucket];
  return (req, res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.deviceToken.id) || []).filter((t) => t > now - RATE_WINDOW_MS);
    if (recent.length >= limit) {
      hits.set(req.deviceToken.id, recent);
      res.set('Retry-After', String(Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000))));
      res.set('Cache-Control', 'no-store');
      res.status(429).json({ error: errorBody });
      return;
    }
    recent.push(now);
    hits.set(req.deviceToken.id, recent);
    next();
  };
}

// Test hook: forget every rate-limit window.
function resetRateLimits() {
  windows.read.clear();
  windows.write.clear();
}

module.exports = { bearerAuth, rateLimit, resetRateLimits, READ_LIMIT, WRITE_LIMIT, RATE_WINDOW_MS };
