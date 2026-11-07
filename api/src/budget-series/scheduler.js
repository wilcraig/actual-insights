const { applyAllSeries } = require('../mobile/v1/budget-series');

const DAILY_AT = { hours: 3, minutes: 30 };
const FIRST_RUN_DELAY_MS = 30 * 1000;

// The next 03:30 strictly after `now`, server time.
function nextDailyRun(now) {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAILY_AT.hours, DAILY_AT.minutes);
  return at > now ? at : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, DAILY_AT.hours, DAILY_AT.minutes);
}

// Fills indefinite series (and finishes any bounded one) once shortly after
// start (which is also the catch-up for a missed 03:30) and then daily. A pass
// is idempotent: it only writes months after each series' appliedThrough, so
// running it again, or after a crash, never rewrites a month. Returns stop().
function startBudgetSeriesScheduler({ now = () => new Date(), firstRunDelayMs = FIRST_RUN_DELAY_MS, runImpl, onWritten } = {}) {
  let stopped = false;
  let timer = null;
  const run = runImpl || (() => applyAllSeries({ now: now(), onWritten: onWritten || (() => require('../routes/mobile-v1').clearMobileV1Cache()) }));

  async function pass() {
    try {
      await run();
    } catch (err) {
      console.error('budget series: pass failed:', (err && err.message) || err);
    }
  }
  function arm(delay) {
    if (stopped) return;
    timer = setTimeout(async () => {
      await pass();
      arm(nextDailyRun(now()) - now());
    }, delay);
    if (timer.unref) timer.unref();
  }
  arm(firstRunDelayMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

module.exports = { startBudgetSeriesScheduler, nextDailyRun };
