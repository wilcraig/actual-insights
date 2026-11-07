const express = require('express');

const { getActualClient, syncIfDue } = require('../actual-client');
const { assertTimezoneConfigured } = require('../month-days');
const { loadAccountBalances } = require('../account-balances-data');

const RANGE_PATTERN = /^(1M|3M|6M|1Y|all)$/;

// Same comma-separated-ids convention as budget-pacing.js's `categories`
// query parameter.
function parseAccountIds(accounts) {
  if (typeof accounts !== 'string' || accounts.length === 0) {
    return [];
  }
  return accounts
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    assertTimezoneConfigured();

    const { range, accounts: accountsParam } = req.query;

    if (typeof range !== 'string' || !RANGE_PATTERN.test(range)) {
      res.status(400).json({ error: 'range query parameter must be one of 1M, 3M, 6M, 1Y, all' });
      return;
    }

    const client = await getActualClient();
    await syncIfDue(client);

    res.status(200).json(await loadAccountBalances(client, range, parseAccountIds(accountsParam)));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
