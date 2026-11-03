const express = require('express');

const { getActualClient, syncIfDue } = require('../actual-client');
const { computeMonthEndProjection } = require('../month-end-data');

const MONTH_PATTERN = /^\d{4}-\d{2}$/;

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { month } = req.query;

    if (typeof month !== 'string' || !MONTH_PATTERN.test(month)) {
      res.status(400).json({ error: 'month query parameter must be in YYYY-MM format' });
      return;
    }

    const client = await getActualClient();
    await syncIfDue(client);

    res.status(200).json(await computeMonthEndProjection(client, month));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
