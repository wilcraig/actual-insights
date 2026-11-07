const { badRequest, HttpError, ID_PATTERN } = require('../mobile/v1/common');
const { saveSeries, deleteSeries, buildSeriesList } = require('../mobile/v1/budget-series');

// /api/mobile/v1/budget-series, mounted by mobile-v1.js with its shared
// helpers. Dry runs need only read scope and change nothing; every other
// POST/PUT/DELETE needs write scope.
module.exports = function mountBudgetSeries(router, { readLimit, writeLimit, requireWrite, parseJson, read, cache, fail, strictQuery, touchToken }) {
  router.get('/budget-series', readLimit, read((req) => {
    strictQuery(req, []);
    return { key: 'budget-series', build: (client) => buildSeriesList(client) };
  }));

  // The body is parsed before the scope check because dryRun decides it. A
  // read token with a real (non dry-run) request still gets 403.
  const scopeForBody = (req, res, next) => {
    if (!(req.body && req.body.dryRun === true) && req.deviceToken.scope !== 'write') {
      res.status(403).json({ error: 'read_only' });
      return;
    }
    next();
  };

  const handle = (fnFor) => async (req, res) => {
    try {
      const { dryRun, body } = await fnFor(req);
      if (!dryRun) cache.clear();
      touchToken(req.deviceToken.id).catch(() => {});
      res.status(200).json(body);
    } catch (err) {
      if (!(err instanceof HttpError)) cache.clear();
      fail(res, err);
    }
  };

  router.post('/budget-series', writeLimit, parseJson, scopeForBody, handle((req) => saveSeries({ tokenId: req.deviceToken.id, id: null, body: req.body })));

  router.put('/budget-series/:id', writeLimit, parseJson, scopeForBody, handle((req) => {
    if (!ID_PATTERN.test(req.params.id)) throw badRequest();
    return saveSeries({ tokenId: req.deviceToken.id, id: req.params.id, body: req.body });
  }));

  router.delete('/budget-series/:id', writeLimit, requireWrite, handle((req) => {
    if (!ID_PATTERN.test(req.params.id)) throw badRequest();
    return deleteSeries({ tokenId: req.deviceToken.id, id: req.params.id }).then((body) => ({ dryRun: false, body }));
  }));
};
