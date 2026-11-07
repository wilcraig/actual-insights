const express = require('express');

const { getActualClient, syncIfDue } = require('../actual-client');
const { buildMobileSummary } = require('../mobile/summary');
const { touchToken } = require('../mobile-tokens-store');
const { bearerAuth, rateLimit, resetRateLimits, READ_LIMIT } = require('../mobile/http');

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

const CACHE_TTL_MS = 60 * 1000;

// Bearer auth and the shared per-token read rate limit live in ../mobile/http
// (the v1 router uses the same ones).
const readLimit = rateLimit('read', READ_LIMIT, 'rate limited');

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

router.get('/', bearerAuth, readLimit, async (req, res) => {
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
  resetRateLimits();
  cached = null;
  building = null;
}

module.exports = router;
module.exports.resetMobileSummaryState = resetMobileSummaryState;
