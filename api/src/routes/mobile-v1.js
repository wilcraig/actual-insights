const express = require('express');

const { syncIfDue } = require('../actual-client');
const { scopedClient } = require('../mobile/v1/hidden');
const { touchToken } = require('../mobile-tokens-store');
const { bearerAuth, rateLimit, resetRateLimits, READ_LIMIT, WRITE_LIMIT } = require('../mobile/http');
const { createReadCache } = require('../mobile/v1/cache');
const { MONTH_PATTERN, ID_PATTERN, MAX_NOTE, MAX_MONEY, HttpError, badRequest, notFound, isValidId, monthWithinWindow } = require('../mobile/v1/common');
const { MAX_LIMIT, DEFAULT_LIMIT, CURSOR_PATTERN, buildCurrency, buildAccounts, buildTransactions, buildCategories, buildBudgetMonth, buildTransactionDetail } = require('../mobile/v1/read');
const { RANGES, buildAccountDetail, putAccountSettings } = require('../mobile/v1/accounts');
const { buildColors, putColor, isColorKey } = require('../mobile/v1/colors');
const { buildSpending } = require('../mobile/v1/spending');
const { updateTransactionFields, splitTransactionLines, removeSplit, setBudgetedAmount, moveBudget, createGroup, createCategory } = require('../mobile/v1/write');

// /api/mobile/v1: the native client API (contract: native-v1.schema.json in
// the Chipmunk repo, copied under api/test/fixtures). Mounted BEFORE the
// global Actual-session guard in server.js, like /api/mobile/summary, with the
// same device-token auth. A token has a scope: 'read' reaches the GETs,
// 'write' may also change categories and budget amounts. Errors are always
// `{ error: code }`; a body, query or path value is never echoed back.

const router = express.Router();
const cache = createReadCache();

const readLimit = rateLimit('read', READ_LIMIT, 'rate_limited');
const writeLimit = rateLimit('write', WRITE_LIMIT, 'rate_limited');

// Nothing here is ever cacheable by anything on the way, and no CORS headers
// are ever set (a browser page can't call this, only a native app).
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.use(bearerAuth);
// Bodies are parsed per write route, after auth, rate limit and the scope
// check, so an unauthenticated caller always gets the 401 and a read token
// always gets the 403, whatever it sends.
const parseJson = express.json({ limit: '2kb' });

function fail(res, err) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code });
    return;
  }
  // Never echo internals, and never log the request: it carries a token.
  console.error('mobile v1 failed:', err && err.code ? err.code : 'unexpected error');
  res.status(500).json({ error: 'internal' });
}

// Only these query parameters, each a single plain string.
function strictQuery(req, allowed) {
  for (const [key, value] of Object.entries(req.query)) {
    if (!allowed.includes(key) || typeof value !== 'string' || value === '') throw badRequest();
  }
}

function pathMonth(req) {
  const { month } = req.params;
  if (!MONTH_PATTERN.test(month) || !monthWithinWindow(month)) throw badRequest();
  return month;
}

function pathId(value) {
  if (!ID_PATTERN.test(value)) throw badRequest();
  return value;
}

// A body that is exactly a JSON object with exactly these keys.
function strictBody(req, keys) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  const present = Object.keys(body);
  if (present.length !== keys.length || !keys.every((k) => present.includes(k))) throw badRequest();
  return body;
}

const isCents = (v, min, max) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;

// A read endpoint: validate, then answer from the cache or build once (with an
// Actual sync first, throttled like the other routes).
function read(handler) {
  return async (req, res) => {
    try {
      const { key, build, respond } = handler(req);
      const payload = await cache.get(key, async () => {
        const client = await scopedClient();
        await syncIfDue(client);
        return build(client);
      });
      touchToken(req.deviceToken.id).catch(() => {});
      res.status(200).json(respond ? respond(payload) : payload);
    } catch (err) {
      fail(res, err);
    }
  };
}

router.get('/me', readLimit, read((req) => {
  strictQuery(req, []);
  return {
    key: 'me',
    build: buildCurrency,
    // The scope is this token's own, so it is never part of what is cached.
    respond: ({ currency }) => ({ schema: 1, scope: req.deviceToken.scope, currency }),
  };
}));

router.get('/accounts', readLimit, read((req) => {
  strictQuery(req, []);
  return { key: 'accounts', build: (client) => buildAccounts(client) };
}));

router.get('/accounts/:id', readLimit, read((req) => {
  strictQuery(req, ['range']);
  const id = pathId(req.params.id);
  const range = req.query.range === undefined ? '1y' : req.query.range;
  if (!RANGES.includes(range)) throw badRequest();
  return { key: `account|${id}|${range}`, build: (client) => buildAccountDetail(client, id, range) };
}));

router.get('/transactions', readLimit, read((req) => {
  strictQuery(req, ['account', 'uncategorized', 'group', 'category', 'limit', 'cursor', 'showHidden']);
  const { account, uncategorized, group, category, limit, cursor, showHidden } = req.query;
  if (account !== undefined && !isValidId(account)) throw badRequest();
  if (group !== undefined && !isValidId(group)) throw badRequest();
  if (category !== undefined && !isValidId(category)) throw badRequest();
  // Where the money went: at most one way of saying it.
  if ([uncategorized, group, category].filter((v) => v !== undefined).length > 1) throw badRequest();
  if (uncategorized !== undefined && uncategorized !== '1') throw badRequest();
  // Only the value 1 asks for hidden transactions too.
  if (showHidden !== undefined && showHidden !== '1') throw badRequest();
  if (limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(limit)) throw badRequest();
  if (limit !== undefined && Number(limit) > MAX_LIMIT) throw badRequest();
  if (cursor !== undefined && (cursor.length > 256 || !CURSOR_PATTERN.test(cursor))) throw badRequest();
  const params = {
    account,
    uncategorized: uncategorized === '1',
    group,
    category,
    limit: limit === undefined ? DEFAULT_LIMIT : Number(limit),
    cursor,
    showHidden: showHidden === '1',
  };
  const key = `transactions|${params.showHidden ? 1 : 0}|${params.account ?? ''}|${params.uncategorized ? 1 : 0}|${params.group ?? ''}|${params.category ?? ''}|${params.limit}|${params.cursor ?? ''}`;
  return {
    key,
    build: (client) => {
      // An account the owner hid does not exist as far as the app can tell.
      if (params.account && client.hiddenIds && client.hiddenIds.has(params.account)) throw notFound();
      return buildTransactions(client, params);
    },
  };
}));

router.get('/categories', readLimit, read((req) => {
  strictQuery(req, []);
  return { key: 'categories', build: (client) => buildCategories(client) };
}));

router.get('/colors', readLimit, read((req) => {
  strictQuery(req, []);
  return { key: 'colors', build: (client) => buildColors(client) };
}));

router.get('/budget/:month', readLimit, read((req) => {
  strictQuery(req, []);
  const month = pathMonth(req);
  return { key: `budget|${month}`, build: (client) => buildBudgetMonth(client, month) };
}));

router.get('/reports', readLimit, read((req) => {
  strictQuery(req, ['report']);
  const reportId = req.query.report;
  if (reportId !== undefined && !isValidId(reportId)) throw badRequest();
  return {
    key: `reports|${reportId ?? ''}`,
    build: async (client) => {
      // Loaded lazily so a problem in the reports code can only ever break this endpoint.
      const { buildReports } = require('../mobile/v1/reports');
      return buildReports({ client, now: new Date(), reportId });
    },
  };
}));

router.get('/report-list', readLimit, read((req) => {
  strictQuery(req, []);
  return {
    key: 'report-list',
    build: async (client) => {
      const { buildReportList } = require('../mobile/v1/reports');
      return buildReportList({ client, now: new Date() });
    },
  };
}));

router.get('/transactions/:id', readLimit, read((req) => {
  strictQuery(req, []);
  const id = pathId(req.params.id);
  return {
    key: `transaction|${id}`,
    build: async (client) => {
      const transaction = await buildTransactionDetail(client, id);
      if (!transaction) throw notFound();
      return { schema: 1, transaction };
    },
  };
}));

// The drill-down behind a pacing row. Exactly the fields its level needs, each
// a single plain string; categoryIds is a comma list of at most 200 ids.
const SPENDING_LEVELS = {
  categories: ['categoryIds'],
  payees: ['categoryId'],
  transactions: ['categoryId', 'payeeId'],
};
const PAYEE_ID = /^([A-Za-z0-9_-]{1,64}|__none__)$/;

function currentMonthKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

router.get('/spending', readLimit, read((req) => {
  strictQuery(req, ['month', 'level', 'categoryIds', 'categoryId', 'payeeId']);
  const { level, categoryIds, categoryId, payeeId } = req.query;
  if (!Object.prototype.hasOwnProperty.call(SPENDING_LEVELS, level)) throw badRequest();
  const needed = SPENDING_LEVELS[level];
  for (const field of ['categoryIds', 'categoryId', 'payeeId']) {
    if ((req.query[field] !== undefined) !== needed.includes(field)) throw badRequest();
  }
  const month = req.query.month === undefined ? currentMonthKey() : req.query.month;
  if (!MONTH_PATTERN.test(month) || !monthWithinWindow(month)) throw badRequest();

  const scope = { level };
  if (level === 'categories') {
    const ids = categoryIds.split(',');
    if (ids.length > 200 || !ids.every(isValidId)) throw badRequest();
    scope.categoryIds = [...new Set(ids)];
  } else {
    if (!isValidId(categoryId)) throw badRequest();
    scope.categoryId = categoryId;
    if (level === 'transactions') {
      if (!PAYEE_ID.test(payeeId)) throw badRequest();
      scope.payeeId = payeeId;
    }
  }
  const key = `spending|${month}|${level}|${scope.categoryIds ? scope.categoryIds.join(',') : ''}|${scope.categoryId ?? ''}|${scope.payeeId ?? ''}`;
  return { key, build: (client) => buildSpending(client, month, scope, new Date()) };
}));

// Writes: rate limited on their own, then scope-checked (a read token changes
// nothing), then validated. A success clears the whole read cache.
function requireWrite(req, res, next) {
  if (req.deviceToken.scope !== 'write') {
    res.status(403).json({ error: 'read_only' });
    return;
  }
  next();
}

function write(handler) {
  return async (req, res) => {
    try {
      const run = handler(req);
      const body = await run();
      cache.clear();
      touchToken(req.deviceToken.id).catch(() => {});
      res.status(200).json(body);
    } catch (err) {
      // A write that threw may still have changed something (for example a
      // failure after the data was saved), so the cache goes either way.
      if (!(err instanceof HttpError)) cache.clear();
      fail(res, err);
    }
  };
}

// Any of category (id or null), notes (string up to 500 or null), cleared
// (boolean) and the Insights flags excluded and hidden (booleans); at least
// one, nothing else.
const updateTransaction = write((req) => {
  const transactionId = pathId(req.params.id);
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  const keys = Object.keys(body);
  if (keys.length === 0 || !keys.every((k) => ['category', 'notes', 'cleared', 'excluded', 'hidden'].includes(k))) throw badRequest();
  if ('category' in body && body.category !== null && !isValidId(body.category)) throw badRequest();
  if ('notes' in body && body.notes !== null && (typeof body.notes !== 'string' || body.notes.length > MAX_NOTE)) throw badRequest();
  if ('cleared' in body && typeof body.cleared !== 'boolean') throw badRequest();
  if ('excluded' in body && typeof body.excluded !== 'boolean') throw badRequest();
  if ('hidden' in body && typeof body.hidden !== 'boolean') throw badRequest();
  const changes = {};
  for (const k of keys) changes[k] = body[k];
  return () => updateTransactionFields({ tokenId: req.deviceToken.id, transactionId, changes });
});

router.patch('/transactions/:id', writeLimit, requireWrite, parseJson, updateTransaction);

// Some HTTP stacks (Android's HttpURLConnection) can't send PATCH. They send a
// POST carrying `X-HTTP-Method-Override: PATCH`, which is treated exactly like
// the PATCH (same auth, scope, rate limit, validation and response). A POST
// without that header, or with any other value, is a 400.
router.post('/transactions/:id', writeLimit, requireWrite, (req, res, next) => {
  if (req.get('X-HTTP-Method-Override') !== 'PATCH') {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  parseJson(req, res, (err) => (err ? next(err) : updateTransaction(req, res, next)));
});

// Up to 50 lines of {category, amount, notes}: bigger than the 2kb of the other
// bodies, still small. Strict like the schema: exactly these keys, nothing else.
const parseSplitJson = express.json({ limit: '32kb' });

router.put('/transactions/:id/splits', writeLimit, requireWrite, parseSplitJson, write((req) => {
  const transactionId = pathId(req.params.id);
  const { splits } = strictBody(req, ['splits']);
  if (!Array.isArray(splits) || splits.length < 2 || splits.length > 50) throw badRequest();
  const lines = splits.map((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw badRequest();
    const keys = Object.keys(line);
    if (keys.length !== 3 || !['category', 'amount', 'notes'].every((k) => keys.includes(k))) throw badRequest();
    if (!isValidId(line.category) || !isCents(line.amount, -MAX_MONEY, MAX_MONEY) || line.amount === 0) throw badRequest();
    if (line.notes !== null && (typeof line.notes !== 'string' || line.notes.length > MAX_NOTE)) throw badRequest();
    return { category: line.category, amount: line.amount, notes: line.notes };
  });
  return () => splitTransactionLines({ tokenId: req.deviceToken.id, transactionId, splits: lines });
}));

router.delete('/transactions/:id/splits', writeLimit, requireWrite, write((req) => {
  const transactionId = pathId(req.params.id);
  return () => removeSplit({ tokenId: req.deviceToken.id, transactionId });
}));

router.put('/budget/:month/categories/:id', writeLimit, requireWrite, parseJson, write((req) => {
  const month = pathMonth(req);
  const categoryId = pathId(req.params.id);
  const { budgeted } = strictBody(req, ['budgeted']);
  if (!isCents(budgeted, 0, 1000000000000)) throw badRequest();
  return () => setBudgetedAmount({ tokenId: req.deviceToken.id, month, categoryId, budgeted });
}));

// Colours: {color: <colorKey>|null}, nothing else; null returns to the default.
const putColorRoute = (kind) =>
  write((req) => {
    const id = pathId(req.params.id);
    const { color } = strictBody(req, ['color']);
    if (color !== null && !isColorKey(color)) throw badRequest();
    return () => putColor({ tokenId: req.deviceToken.id, kind, id, color });
  });
router.put('/colors/groups/:id', writeLimit, requireWrite, parseJson, putColorRoute('groups'));
router.put('/colors/categories/:id', writeLimit, requireWrite, parseJson, putColorRoute('categories'));

router.put('/accounts/:id/settings', writeLimit, requireWrite, parseJson, write((req) => {
  const id = pathId(req.params.id);
  const { investment } = strictBody(req, ['investment']);
  if (typeof investment !== 'boolean') throw badRequest();
  return () => putAccountSettings({ tokenId: req.deviceToken.id, id, investment });
}));

// New category group / category (409 on a duplicate name). Names are trimmed
// and must be 1..200 characters afterwards.
function cleanName(value) {
  if (typeof value !== 'string') throw badRequest();
  const name = value.trim();
  if (name.length < 1 || name.length > 200) throw badRequest();
  return name;
}

router.post('/category-groups', writeLimit, requireWrite, parseJson, write((req) => {
  const { name } = strictBody(req, ['name']);
  const clean = cleanName(name);
  return () => createGroup({ tokenId: req.deviceToken.id, name: clean });
}));

router.post('/categories', writeLimit, requireWrite, parseJson, write((req) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  if (!Object.keys(body).every((k) => k === 'groupId' || k === 'name' || k === 'budgeted') || !('groupId' in body) || !('name' in body)) throw badRequest();
  if (!isValidId(body.groupId)) throw badRequest();
  const name = cleanName(body.name);
  if ('budgeted' in body && !isCents(body.budgeted, 0, 1000000000000)) throw badRequest();
  return () => createCategory({ tokenId: req.deviceToken.id, groupId: body.groupId, name, budgeted: 'budgeted' in body ? body.budgeted : undefined });
}));

router.post('/budget/:month/move', writeLimit, requireWrite, parseJson, write((req) => {
  const month = pathMonth(req);
  const { from, to, amount } = strictBody(req, ['from', 'to', 'amount']);
  if (!isValidId(from) || !isValidId(to) || from === to || !isCents(amount, 1, 1000000000000)) throw badRequest();
  return () => moveBudget({ tokenId: req.deviceToken.id, month, from, to, amount });
}));

require('./mobile-v1-budget-series')(router, { readLimit, writeLimit, requireWrite, parseJson, read, cache, fail, strictQuery, touchToken });

// Anything else under /api/mobile/v1 (after auth): not found, never a
// fall-through to the Actual-session guard.
router.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Body-parser failures (bad JSON, too large) are the caller's fault; anything
// else is ours. Never echo the body.
router.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }
  fail(res, err);
});

// Test hook: forget the rate-limit windows and the read cache.
function resetMobileV1State() {
  resetRateLimits();
  cache.clear();
}

module.exports = router;
module.exports.resetMobileV1State = resetMobileV1State;
// The hidden-accounts setting changed: every cached read is out of date.
module.exports.clearMobileV1Cache = () => cache.clear();
