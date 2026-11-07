const express = require('express');
const { hasEverConnected } = require('./actual-client');
const { validateToken } = require('./auth');
const billsTimelineRouter = require('./routes/bills-timeline');
const budgetPacingRouter = require('./routes/budget-pacing');
const monthEndProjectionRouter = require('./routes/month-end-projection');
const paycheckAlertsRouter = require('./routes/paycheck-alerts');
const spendingBreakdownRouter = require('./routes/spending-breakdown');
const categoriesRouter = require('./routes/categories');
const categoryGroupsRouter = require('./routes/category-groups');
const accountsRouter = require('./routes/accounts');
const accountBalancesRouter = require('./routes/account-balances');
const unlinkedTransfersRouter = require('./routes/unlinked-transfers');
const goalsRouter = require('./routes/goals');
const burnRateRouter = require('./routes/burn-rate');
const spendingCalendarRouter = require('./routes/spending-calendar');
const savingsRateRouter = require('./routes/savings-rate');
const cashFlowRouter = require('./routes/cash-flow');
const channelsRouter = require('./routes/channels');
const summariesRouter = require('./routes/summaries');
const mobileTokensRouter = require('./routes/mobile-tokens');
const mobileSummaryRouter = require('./routes/mobile-summary');
const mobileV1Router = require('./routes/mobile-v1');
const forecastRouter = require('./routes/forecast');
const { startScheduler } = require('./summary/scheduler');
const { startForecastScheduler } = require('./forecast/scheduler');

const app = express();

// Actual's own client sends its session token as `X-ACTUAL-TOKEN` (see
// auth.js for the confirmed mechanism). Require a valid one on every
// /api/* route so a later plan's new routes are covered automatically
// without each needing to remember to add auth themselves.
async function requireAuth(req, res, next) {
  const token = req.get('X-ACTUAL-TOKEN');
  if (!token || !(await validateToken(token))) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

// The companion app's endpoints have their own auth (a revocable device token,
// never an Actual session), so it is mounted BEFORE the session guard below;
// the guard is not bypassed for anything else.
app.use('/api/mobile/summary', mobileSummaryRouter);
app.use('/api/mobile/v1', mobileV1Router);

app.use('/api', requireAuth);

// Registered after requireAuth so a malformed-JSON body from an
// unauthenticated caller gets a clean 401 instead of Express's default
// 400 HTML error page (body parsing would throw before auth ever ran).
// Still a blanket /api/* concern -- no need to scope it to just the goals
// router.
app.use(express.json());
app.use('/api/bills-timeline', billsTimelineRouter);
app.use('/api/budget-pacing', budgetPacingRouter);
app.use('/api/month-end-projection', monthEndProjectionRouter);
app.use('/api/paycheck-alerts', paycheckAlertsRouter);
app.use('/api/spending-breakdown', spendingBreakdownRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/category-groups', categoryGroupsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/account-balances', accountBalancesRouter);
app.use('/api/unlinked-transfers', unlinkedTransfersRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/burn-rate', burnRateRouter);
app.use('/api/spending-calendar', spendingCalendarRouter);
app.use('/api/savings-rate', savingsRateRouter);
app.use('/api/cash-flow', cashFlowRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/summaries', summariesRouter);
app.use('/api/mobile/tokens', mobileTokensRouter);
app.use('/api/forecast', forecastRouter);

app.get('/health', (req, res) => {
  if (hasEverConnected()) {
    res.status(200).json({ ok: true });
  } else {
    res.status(503).json({ ok: false });
  }
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3011;
  app.listen(port, () => {
    console.log(`insights-api listening on :${port}`);
    // Budget summaries go out from here, with no browser tab open. Fires in
    // the server's TZ; a send missed while the server was down is caught up
    // once if under 12 hours late.
    startScheduler({});
    // The daily low-balance check, same slot and catch-up rules.
    startForecastScheduler({});
  });
}

module.exports = app;
