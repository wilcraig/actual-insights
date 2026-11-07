const express = require('express');

const { getActualClient, syncIfDue } = require('../actual-client');
const { assertTimezoneConfigured } = require('../month-days');
const { loadPaycheckAlerts } = require('../paycheck-alerts-data');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    assertTimezoneConfigured();

    const client = await getActualClient();
    await syncIfDue(client);

    const { alerts } = await loadPaycheckAlerts(client);
    res.status(200).json({ alerts });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
