const express = require('express');

const { createToken, listTokens, revokeToken } = require('../mobile-tokens-store');

// Manages the companion app's device tokens. These routes sit behind the
// ordinary Actual session auth (server.js mounts them after requireAuth), so
// only someone signed in to Actual can create, list, or revoke a device. The
// plain token comes back from the POST and nowhere else.
const router = express.Router();

// A response carrying a secret must never be cached by anything on the way.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/', async (req, res, next) => {
  try {
    res.status(200).json({ tokens: await listTokens() });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const result = await createToken(req.body && req.body.label);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const { id, token, label, createdAt } = result;
    res.status(201).json({ id, token, label, createdAt });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!(await revokeToken(req.params.id))) {
      res.status(404).json({ error: 'token not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Never echo internals, and never log the request (it may carry a token).
router.use((err, req, res, next) => {
  console.error('mobile tokens route failed:', err && err.code ? err.code : 'unexpected error');
  res.status(500).json({ error: 'internal error' });
});

module.exports = router;
