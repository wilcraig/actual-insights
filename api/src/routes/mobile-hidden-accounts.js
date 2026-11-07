const express = require('express');

const { getActualClient } = require('../actual-client');
const { readHiddenIds, writeHiddenIds, MAX_HIDDEN } = require('../mobile-hidden-accounts-store');
const { clearMobileV1Cache } = require('./mobile-v1');
const { clearMobileSummaryCache } = require('./mobile-summary');

// The owner's list of accounts the native app must not see at all. Behind the
// ordinary Actual session auth (server.js mounts it after requireAuth), like
// the device-token admin: a device token never reaches it.
const router = express.Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Every account (closed and off budget too, so any of them can be hidden).
async function listAccounts() {
  const hidden = new Set(await readHiddenIds());
  return ((await (await getActualClient()).getAccounts()) || [])
    .filter((a) => a && typeof a.id === 'string')
    .map((a) => ({ id: a.id, name: String(a.name ?? ''), closed: Boolean(a.closed), offBudget: Boolean(a.offbudget), hidden: hidden.has(a.id) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

router.get('/', async (req, res, next) => {
  try {
    res.status(200).json({ accounts: await listAccounts() });
  } catch (err) {
    next(err);
  }
});

// { hiddenIds: [...] } and nothing else; replaces the list. Ids that are not
// accounts are dropped, so the stored list never outlives a deleted account.
router.put('/', async (req, res, next) => {
  try {
    const body = req.body;
    const valid =
      body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 &&
      Array.isArray(body.hiddenIds) && body.hiddenIds.length <= MAX_HIDDEN && body.hiddenIds.every((id) => typeof id === 'string');
    if (!valid) {
      res.status(400).json({ error: 'hiddenIds must be a list of account ids' });
      return;
    }
    const known = new Set(((await (await getActualClient()).getAccounts()) || []).map((a) => a.id));
    await writeHiddenIds(body.hiddenIds.filter((id) => known.has(id)));
    clearMobileV1Cache();
    clearMobileSummaryCache();
    res.status(200).json({ accounts: await listAccounts() });
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, next) => {
  console.error('mobile hidden accounts route failed:', err && err.code ? err.code : 'unexpected error');
  res.status(500).json({ error: 'internal error' });
});

module.exports = router;
