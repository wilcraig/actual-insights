const express = require('express');

const { getActualClient, syncIfDue } = require('../actual-client');
const { chipmunkEntitled } = require('../chipmunk/entitlement');
const { readSettings, writeSettings } = require('../chipmunk/settings-store');
const { MONTH_PATTERN, isValidId, monthWithinWindow } = require('../mobile/v1/common');
const { MAX_LIMIT, DEFAULT_LIMIT, CURSOR_PATTERN, buildAccounts, buildTransactions, buildTransactionSuggest, SUGGEST_MAX_LIMIT, SUGGEST_DEFAULT_LIMIT, buildBudgetMonth } = require('../mobile/v1/read');
const { saveSeries, deleteSeries, buildSeriesList } = require('../mobile/v1/budget-series');
const { HttpError, ID_PATTERN } = require('../mobile/v1/common');

// Web side of Chipmunk mode, behind the normal Actual-session guard. The data
// routes are thin: they validate, then call the same builders the phone API
// uses (api/src/mobile/v1/*). This is the owner's web view, so the phone's
// "hidden accounts" scoping is deliberately not applied.

const mode = express.Router();
const data = express.Router();

class BadRequest extends Error {}
const bad = () => new BadRequest('bad_request');

async function state() {
  const stored = await readSettings();
  const ent = await chipmunkEntitled();
  return {
    enabled: stored.enabled === true && ent.entitled === true,
    entitled: ent.entitled === true,
    reason: ent.reason,
    lastVerifiedAt: ent.lastVerifiedAt ?? null,
  };
}

mode.get('/', async (req, res, next) => {
  try {
    res.status(200).json(await state());
  } catch (err) {
    next(err);
  }
});

mode.put('/', async (req, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be true or false', field: 'enabled' });
      return;
    }
    const ent = await chipmunkEntitled();
    if (body.enabled && !ent.entitled) {
      res.status(403).json({ error: 'Chipmunk mode is not available', reason: ent.reason });
      return;
    }
    await writeSettings({ enabled: body.enabled });
    res.status(200).json(await state());
  } catch (err) {
    next(err);
  }
});

// Every data route needs the mode to be available (entitled), whether or not
// it is switched on.
data.use(async (req, res, next) => {
  try {
    if (!(await chipmunkEntitled()).entitled) {
      res.status(403).json({ error: 'chipmunk_unavailable' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
});

function wrap(handler) {
  return async (req, res, next) => {
    try {
      const client = await getActualClient();
      await syncIfDue(client);
      res.status(200).json(await handler(req, client));
    } catch (err) {
      if (err instanceof BadRequest) {
        res.status(400).json({ error: 'bad_request' });
        return;
      }
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code });
        return;
      }
      if (err && err.code === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      next(err);
    }
  };
}

function only(req, allowed) {
  for (const [key, value] of Object.entries(req.query)) {
    if (!allowed.includes(key) || typeof value !== 'string') throw bad();
  }
}

function idList(value) {
  if (value === undefined) return undefined;
  const parts = value.split(',');
  if (parts.length > 20 || !parts.every(isValidId)) throw bad();
  return [...new Set(parts)].sort();
}

data.get('/report-list', wrap(async (req, client) => {
  only(req, []);
  const { buildReportList } = require('../mobile/v1/reports');
  return buildReportList({ client, now: new Date() });
}));

data.get('/reports', wrap(async (req, client) => {
  only(req, ['report', 'month']);
  const { report, month } = req.query;
  if (report !== undefined && !isValidId(report)) throw bad();
  let asOf;
  if (month !== undefined) {
    const now = new Date();
    const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (!MONTH_PATTERN.test(month) || !monthWithinWindow(month) || month > current) throw bad();
    if (month < current) asOf = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 23, 59, 59);
  }
  const { buildReports } = require('../mobile/v1/reports');
  return buildReports({ client, now: new Date(), reportId: report, asOf });
}));

data.get('/accounts', wrap(async (req, client) => {
  only(req, []);
  return buildAccounts(client);
}));

data.get('/transactions', wrap(async (req, client) => {
  only(req, ['account', 'uncategorized', 'group', 'category', 'payees', 'categories', 'q', 'limit', 'cursor', 'showHidden']);
  const { account, uncategorized, group, category, limit, cursor, showHidden } = req.query;
  for (const id of [account, group, category]) if (id !== undefined && !isValidId(id)) throw bad();
  const payees = idList(req.query.payees);
  const categories = idList(req.query.categories);
  let q;
  if (req.query.q !== undefined) {
    q = req.query.q.trim();
    if (q.length < 1 || q.length > 100) throw bad();
  }
  if ([uncategorized, group, category].filter((v) => v !== undefined).length > 1) throw bad();
  if (categories !== undefined && [uncategorized, group, category].some((v) => v !== undefined)) throw bad();
  if (uncategorized !== undefined && uncategorized !== '1') throw bad();
  if (showHidden !== undefined && showHidden !== '1') throw bad();
  if (limit !== undefined && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > MAX_LIMIT)) throw bad();
  if (cursor !== undefined && (cursor.length > 256 || !CURSOR_PATTERN.test(cursor))) throw bad();
  return buildTransactions(client, {
    account,
    uncategorized: uncategorized === '1',
    group,
    category,
    payees,
    categories,
    q,
    limit: limit === undefined ? DEFAULT_LIMIT : Number(limit),
    cursor,
    showHidden: showHidden === '1',
  });
}));

// Registered before any /transactions/:id so "suggest" is never read as an id.
data.get('/transactions/suggest', wrap(async (req, client) => {
  only(req, ['q', 'limit']);
  const { limit } = req.query;
  const text = (req.query.q ?? '').trim();
  if (text.length > 100) throw bad();
  if (limit !== undefined && (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > SUGGEST_MAX_LIMIT)) throw bad();
  return buildTransactionSuggest(client, text, limit === undefined ? SUGGEST_DEFAULT_LIMIT : Number(limit));
}));

// Budget screen and budget series. Same builders and the same series logic as
// the phone (dry run first, one series per category, writes audit-logged);
// the audit trail names the writer 'web'. The 'web' caller is the signed-in
// Actual user, so there is no read/write scope to check.
data.get('/budget/:month', wrap(async (req, client) => {
  only(req, []);
  const { month } = req.params;
  if (!MONTH_PATTERN.test(month) || !monthWithinWindow(month)) throw bad();
  return buildBudgetMonth(client, month);
}));

data.get('/budget-series', wrap(async (req, client) => {
  only(req, []);
  return buildSeriesList(client);
}));

const sendSeries = (run) => async (req, res, next) => {
  try {
    const { body } = await run(req);
    res.status(200).json(body);
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    next(err);
  }
};

data.post('/budget-series', sendSeries((req) => saveSeries({ tokenId: 'web', id: null, body: req.body })));
data.put('/budget-series/:id', sendSeries((req) => {
  if (!ID_PATTERN.test(req.params.id)) throw new HttpError(400, 'bad_request');
  return saveSeries({ tokenId: 'web', id: req.params.id, body: req.body });
}));
data.delete('/budget-series/:id', sendSeries(async (req) => {
  if (!ID_PATTERN.test(req.params.id)) throw new HttpError(400, 'bad_request');
  return { body: await deleteSeries({ tokenId: 'web', id: req.params.id }) };
}));

module.exports = { modeRouter: mode, dataRouter: data };
