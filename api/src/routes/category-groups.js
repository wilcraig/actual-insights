const express = require('express');

const { getActualClient, syncIfDue } = require('../actual-client');
const { isIncomeGroup, isTransferGroup } = require('../cash-flow-data');

const router = express.Router();

// Flattens Actual's category groups into a plain { id, name } list for the
// widget-builder's group-multiselect picker. Mirrors categories.js's own
// hidden-group filtering exactly -- a dedicated endpoint rather than a
// client-side dedup of /api/categories' groupName, since that route already
// drops hidden groups (and the hidden flag itself) entirely, which would
// make a hidden group silently indistinguishable from a non-existent one.
router.get('/', async (req, res, next) => {
  try {
    const client = await getActualClient();
    // Same throttled-refresh reasoning as categories.js: keep the list from
    // going stale for up to an hour without syncing on every request.
    await syncIfDue(client);
    const categoryGroups = await client.getCategoryGroups();

    const groups = [];
    for (const group of categoryGroups || []) {
      if (group.hidden) {
        continue;
      }
      // Beyond { id, name }: what the pacing widget's "Category Groups" mode
      // needs to build one rollup per group (visible categories only, and
      // whether the group is income or transfers, which it leaves out).
      groups.push({
        id: group.id,
        name: group.name,
        isIncome: isIncomeGroup(group),
        isTransfer: isTransferGroup(group),
        categoryIds: (group.categories || []).filter((category) => !category.hidden).map((category) => category.id),
      });
    }

    res.status(200).json({ groups });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
