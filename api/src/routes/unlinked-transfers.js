const express = require('express');

const { getActualClient, syncIfDue } = require('../actual-client');
const { loadUnlinkedTransfers, findUnlinkedTransferCandidates } = require('../unlinked-transfers-data');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const client = await getActualClient();
    await syncIfDue(client);

    res.status(200).json(await loadUnlinkedTransfers(client));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.findUnlinkedTransferCandidates = findUnlinkedTransferCandidates;
