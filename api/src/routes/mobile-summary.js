const express = require('express');

const { getActualClient, syncIfDue } = require('../actual-client');
const { buildMobileSummary } = require('../mobile/summary');
const { verifyToken, touchToken } = require('../mobile-tokens-store');

// GET /api/mobile/summary: the one endpoint a paired companion app can reach.
//
// Auth is a device token in `Authorization: Bearer <token>` and nothing else.
// This router is mounted BEFORE the global Actual-session guard in server.js,
// so everything else under /api still requires an Actual session token, which
// a device token is not. The reverse holds too, by choice: an Actual session
// token alone is NOT accepted here. The companion app never holds one, and
// keeping this endpoint device-token-only means revoking a device always cuts
// its access, whatever else is signed in.
//
// Every auth failure (no header, wrong scheme, malformed, unknown, revoked)
// gets the identical response, so a caller learns nothing about why. No CORS
// headers are ever set: a browser page can't call this, only a native app.

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;

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

// Per-token sliding window. Only requests carrying a valid token are counted,
// so garbage traffic can't use up a real device's allowance.
const hits = new Map(); // token id -> timestamps (ms) inside the window

function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.deviceToken.id) || []).filter((t) => t > now - RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(req.deviceToken.id, recent);
    res.set('Retry-After', String(Math.max(1, Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000))));
    res.set('Cache-Control', 'no-store');
    res.status(429).json({ error: 'rate limited' });
    return;
  }
  recent.push(now);
  hits.set(req.deviceToken.id, recent);
  next();
}

// One budget, one payload: computed at most once a minute no matter how many
// devices or widgets ask. A build in flight is shared, a failed one is not
// cached.
let cached = null; // { payload, expiresAt }
let building = null;

async function currentPayload() {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.payload;
  if (!building) {
    building = (async () => {
      const client = await getActualClient();
      await syncIfDue(client);
      const payload = await buildMobileSummary({ client, now: new Date() });
      cached = { payload, expiresAt: Date.now() + CACHE_TTL_MS };
      return payload;
    })().finally(() => {
      building = null;
    });
  }
  return building;
}

const router = express.Router();

router.get('/', bearerAuth, rateLimit, async (req, res) => {
  try {
    const payload = await currentPayload();
    // lastUsedAt is bookkeeping: never let it slow or fail a response.
    touchToken(req.deviceToken.id).catch(() => {});
    res.set('Cache-Control', 'no-store');
    res.status(200).json(payload);
  } catch (err) {
    // Never echo internals, and never log the request: it carries a token.
    console.error('mobile summary failed:', err && err.code ? err.code : 'unexpected error');
    res.status(500).json({ error: 'internal error' });
  }
});

// Test hook: forget the rate-limit windows and the cached payload.
function resetMobileSummaryState() {
  hits.clear();
  cached = null;
  building = null;
}

module.exports = router;
module.exports.resetMobileSummaryState = resetMobileSummaryState;
