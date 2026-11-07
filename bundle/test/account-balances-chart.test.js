vi.mock('../src/api-client', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../src/api-client';
import AccountBalancesChart from '../src/widgets/AccountBalancesChart.svelte';

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function multiDayPayload() {
  return {
    range: '1M',
    rangeStart: '2026-09-26',
    rangeEnd: '2026-10-26',
    accounts: [
      {
        id: 'acc1',
        name: 'Checking',
        points: [
          { date: '2026-10-24', balanceCents: 10000 },
          { date: '2026-10-25', balanceCents: 10500 },
          { date: '2026-10-26', balanceCents: 11000 },
        ],
      },
      {
        id: 'acc2',
        name: 'Savings',
        points: [
          { date: '2026-10-24', balanceCents: 50000 },
          { date: '2026-10-25', balanceCents: 50000 },
          { date: '2026-10-26', balanceCents: 50500 },
        ],
      },
    ],
    netWorth: [
      { date: '2026-10-24', balanceCents: 60000 },
      { date: '2026-10-25', balanceCents: 60500 },
      { date: '2026-10-26', balanceCents: 61500 },
    ],
  };
}

function mountChart(props = {}) {
  document.body.innerHTML = '<div id="host"></div>';
  const target = document.getElementById('host');
  new AccountBalancesChart({ target, props });
  return target;
}

// `/api/goals` has no dedicated mock in most tests below -- they return the
// same multiDayPayload() for any URL, which has no `goals` field, so the
// widget's own `body.goals || []` fallback makes it a harmless empty-goals
// response that doesn't affect assertions about account-balances data.
function balanceCallsOnly() {
  return fetchApi.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/api/account-balances'));
}

function parseLinePath(d) {
  const match = d && d.match(/M\s*([-\d.]+)[,\s]+([-\d.]+)\s*L\s*([-\d.]+)[,\s]+([-\d.]+)/);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match;
  return { x1: Number(x1), y1: Number(y1), x2: Number(x2), y2: Number(y2) };
}

async function flushFake() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  fetchApi.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('fetches the default 1M range on mount', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));

  mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Goals are now also fetched once per mount (see the goal-corridor tests
  // below), so fetchApi's total call count is no longer 1 -- filtered to
  // just the account-balances calls, this test's own intent is unchanged.
  const balanceCalls = balanceCallsOnly();
  expect(balanceCalls).toHaveLength(1);
  expect(balanceCalls[0][0]).toContain('range=1M');
});

test('with no accountIds prop, fetches without an accounts filter (every open account)', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));

  mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchApi.mock.calls[0][0]).not.toContain('accounts=');
});

test('with an accountIds prop, fetches with a comma-joined accounts filter', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));

  mountChart({ accountIds: ['acc1', 'acc2'] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const url = fetchApi.mock.calls[0][0];
  expect(url).toContain('range=1M');
  expect(decodeURIComponent(url)).toContain('accounts=acc1,acc2');
});

function switchToCombinedView(target) {
  const combinedButton = Array.from(target.querySelectorAll('button.balances-range-button')).find(
    (b) => b.textContent.trim() === 'Combined',
  );
  combinedButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function switchToSeparateView(target) {
  const separateButton = Array.from(target.querySelectorAll('button.balances-range-button')).find(
    (b) => b.textContent.trim() === 'Separate',
  );
  separateButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

// RANGES' labels are '1M'/'3M'/'6M'/'1Y'/'All' -- 'all''s own button reads
// "All", so callers pass the human label exactly as RANGES defines it.
function switchToRange(target, label) {
  const button = Array.from(target.querySelectorAll('button.balances-range-button')).find(
    (b) => b.textContent.trim() === label,
  );
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

test('separate view (selectable, no longer the default): one mini area chart per account, each with its own large current-balance figure', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));

  const target = mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  switchToSeparateView(target);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 2 accounts + 1 Total card.
  expect(target.querySelectorAll('.balances-mini-card').length).toBe(3);
  expect(target.querySelectorAll('.balances-mini-area').length).toBe(3);

  const values = Array.from(target.querySelectorAll('.balances-mini-value')).map((el) => el.textContent.trim());
  expect(values).toContain('$110.00'); // Checking's latest balance, 11000 cents
  expect(values).toContain('$505.00'); // Savings' latest balance, 50500 cents
  expect(values).toContain('$615.00'); // Total/net worth's latest balance, 61500 cents

  // No combined-view elements rendered at the same time.
  expect(target.querySelector('path.balances-area')).toBeNull();
});

test('combined view (the default): a stacked area band per account, each labeled with its own (not cumulative) balance, plus a total below the chart', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));

  const target = mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const areas = target.querySelectorAll('path.balances-area');
  expect(areas.length).toBe(2);

  const names = Array.from(target.querySelectorAll('.balances-area-name')).map((el) => el.textContent.trim());
  expect(names).toEqual(['Checking', 'Savings']);

  const labels = Array.from(target.querySelectorAll('.balances-area-label')).map((el) => el.textContent.trim());
  // Each account's OWN latest balance, never the running cumulative total
  // the stack's top edge would otherwise suggest (Checking's own $110.00,
  // not Savings' $615.00 cumulative-through-Savings figure).
  expect(labels).toEqual(['$110.00', '$505.00']);

  // The combined total (same figure as the Separate view's Total card)
  // appears once, below the chart -- not as a band label.
  expect(target.querySelector('.balances-combined-total').textContent.trim()).toBe('Total: $615.00');

  // No separate legend -- the in-band name + balance labels are the only
  // way account identity is shown in this view now.
  expect(target.querySelector('.balances-legend')).toBeNull();

  // Default labelContent='both': amount tspan comes first, name tspan
  // second with a dx gap after it (not a literal space, which SVG would
  // otherwise collapse).
  const firstLabelText = target.querySelector('.balances-area-combined-label');
  const [first, second] = firstLabelText.children;
  expect(first.classList.contains('balances-area-label')).toBe(true);
  expect(second.classList.contains('balances-area-name')).toBe(true);
  expect(second.getAttribute('dx')).toBe('8');
});

test('labelContent="amount" shows only the balance, no account name, inside each band', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));

  const target = mountChart({ labelContent: 'amount' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(target.querySelectorAll('.balances-area-label').length).toBe(2);
  expect(target.querySelectorAll('.balances-area-name').length).toBe(0);
});

test('labelContent="name" shows only the account name, no balance, inside each band', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));

  const target = mountChart({ labelContent: 'name' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(target.querySelectorAll('.balances-area-name').length).toBe(2);
  expect(target.querySelectorAll('.balances-area-label').length).toBe(0);
});

test('clicking a range button re-fetches with the new range', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));

  const target = mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const sixMonthButton = Array.from(target.querySelectorAll('button.balances-range-button')).find(
    (b) => b.textContent.trim() === '6M',
  );
  sixMonthButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // See the note on the "fetches the default 1M range on mount" test above
  // -- filtered to account-balances calls, since goals are now also
  // fetched (once, on mount) alongside them.
  const balanceCalls = balanceCallsOnly();
  expect(balanceCalls).toHaveLength(2);
  expect(balanceCalls[1][0]).toContain('range=6M');
  expect(sixMonthButton.classList.contains('balances-range-button--active')).toBe(true);
});

test('shows an empty-state message with no broken SVG when there are no accounts', async () => {
  fetchApi.mockResolvedValue(
    jsonResponse({ range: '1M', rangeStart: '2026-09-26', rangeEnd: '2026-10-26', accounts: [], netWorth: [] }),
  );

  const target = mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(target.textContent).toContain('Not enough balance history yet to chart.');
  expect(target.querySelector('svg')).toBeNull();
});

test('shows an empty-state message for the brand-new-budget single-day series edge case', async () => {
  fetchApi.mockResolvedValue(
    jsonResponse({
      range: '1M',
      rangeStart: '2026-10-26',
      rangeEnd: '2026-10-26',
      accounts: [{ id: 'acc1', name: 'Checking', points: [{ date: '2026-10-26', balanceCents: 0 }] }],
      netWorth: [{ date: '2026-10-26', balanceCents: 0 }],
    }),
  );

  const target = mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(target.textContent).toContain('Not enough balance history yet to chart.');
  expect(target.querySelector('svg')).toBeNull();
});

test('renders the inline error treatment on a non-ok response', async () => {
  fetchApi.mockResolvedValue(jsonResponse(null, false, 500));

  const target = mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(target.textContent).toContain('Account balances unavailable (500)');
});

test('renders the inline error treatment when fetch throws', async () => {
  fetchApi.mockRejectedValue(new Error('network down'));

  const target = mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(target.textContent).toContain('could not reach insights-api');
});

test('a slower in-flight request that resolves after a newer one does not clobber the newer range', async () => {
  let resolveFirst;
  const firstPromise = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  // Goals are now also fetched (once, on mount, see loadGoals()) alongside
  // account-balances -- branch by URL so the "first call returns a pending
  // promise, second call resolves immediately" sequencing below still
  // applies specifically to the account-balances calls this test is about,
  // regardless of where the goals call falls in the interleaving.
  let balanceCallCount = 0;
  fetchApi.mockImplementation((url) => {
    if (url.includes('/api/goals')) return jsonResponse({ goals: [] });
    balanceCallCount += 1;
    return balanceCallCount === 1 ? firstPromise : jsonResponse(multiDayPayload());
  });

  const target = mountChart();
  // Let the mount-triggered load() call fetchApi and register as call #1,
  // without resolving it yet.
  await new Promise((resolve) => setTimeout(resolve, 0));

  const sixMonthButton = Array.from(target.querySelectorAll('button.balances-range-button')).find(
    (b) => b.textContent.trim() === '6M',
  );
  sixMonthButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  await new Promise((resolve) => setTimeout(resolve, 0));

  // 2 accounts, in the default combined (stacked-area) view.
  expect(target.querySelectorAll('path.balances-area').length).toBe(2);

  resolveFirst(
    jsonResponse({
      range: '1M',
      rangeStart: '2026-10-26',
      rangeEnd: '2026-10-26',
      accounts: [{ id: 'stale', name: 'Stale', points: [{ date: '2026-10-26', balanceCents: 0 }] }],
      netWorth: [{ date: '2026-10-26', balanceCents: 0 }],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The stale (single-day) response must not have overwritten the newer,
  // fully-populated chart with an empty-state render.
  expect(target.querySelectorAll('path.balances-area').length).toBe(2);
  expect(target.textContent).not.toContain('Not enough balance history yet to chart.');
});

// --- Account-type goal milestone corridor (Combined view only) ---
//
// `today` is pinned to the fixture data's own last day (Oct 26, 2026) via
// fake timers, matching the vi.useFakeTimers()/vi.setSystemTime() pattern
// savings-goals-thermometers.test.js already uses for the same reason:
// neither /api/account-balances nor /api/goals provides a server "today."

test('an account with a matching account-type goal draws a dashed corridor from today to (targetDate, targetAmountCents)', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26)); // Oct 26, 2026

  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g1', entityType: 'account', entityId: 'acc1', targetAmountCents: 500000, targetDate: '2027-06-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();
  // The corridor only draws once range is wide enough (1Y/all) -- see the
  // range-gating tests below -- so switch off the default 1M range first.
  switchToRange(target, '1Y');
  await flushFake();

  const corridors = target.querySelectorAll('.balances-goal-corridor');
  expect(corridors.length).toBe(1);

  const corridor = corridors[0];
  expect(corridor.getAttribute('stroke-dasharray')).toBeTruthy();
  // acc1 is index 0 -- jsdom's getComputedStyle never resolves the
  // --palette-chartQual1 custom property, so colorFor(0) falls back to
  // FALLBACK_COLORS[0], #2563eb, and labelColorFor(0) mixes that into
  // "color-mix(...)".
  expect(corridor.getAttribute('stroke')).toContain('color-mix');
  expect(corridor.getAttribute('stroke')).toContain('#2563eb');

  const { x1, y1, x2, y2 } = parseLinePath(corridor.getAttribute('d'));
  // Forward in time ...
  expect(x2).toBeGreaterThan(x1);
  // ... and the x-axis stretched out so the domain's max is exactly the
  // goal's own targetDate: scaleTime always maps a domain's max to its
  // range's own upper bound, WIDTH (640) - MARGIN.right (16).
  expect(x2).toBeCloseTo(624, 5);
  // The $5,000 target is well above acc1's current $110 balance -- higher
  // on screen means a smaller y pixel value.
  expect(y2).toBeLessThan(y1);
});

test('an account with no goal draws no corridor, unaffected by a goal on a different account', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g2', entityType: 'account', entityId: 'acc2', targetAmountCents: 100000, targetDate: '2027-01-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();
  switchToRange(target, '1Y');
  await flushFake();

  const corridors = target.querySelectorAll('.balances-goal-corridor');
  // Only acc2 (index 1, Savings) has a goal -- acc1 (Checking) draws none.
  expect(corridors.length).toBe(1);
  expect(corridors[0].getAttribute('stroke')).toContain('#16a34a'); // FALLBACK_COLORS[1]
});

test('the x-axis extends forward to cover the furthest goal targetDate among shown accounts', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g1', entityType: 'account', entityId: 'acc1', targetAmountCents: 500000, targetDate: '2027-06-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();
  switchToRange(target, '1Y');
  await flushFake();

  const tickLabels = Array.from(target.querySelectorAll('.balances-axis-label--x')).map((el) => el.textContent.trim());
  // Without the goal, every tick falls within the loaded balance history's
  // own 3-day span (Oct 24-26, 2026) -- all the same month. With the
  // goal's targetDate (June 2027) pulled into the domain, the x-axis
  // necessarily spans many months instead.
  const months = new Set(tickLabels.map((label) => label.split(' ')[0]));
  expect(months.size).toBeGreaterThan(1);

  // And the corridor itself reaches exactly the plotted area's right edge
  // (WIDTH 640 - MARGIN.right 16), confirming the domain's max is the
  // goal's own targetDate, not merely "somewhere past it."
  const corridor = target.querySelector('.balances-goal-corridor');
  const { x2 } = parseLinePath(corridor.getAttribute('d'));
  expect(x2).toBeCloseTo(624, 5);
});

test("a goal whose targetDate is in the past clamps the corridor's forward end to today, never drawing backwards", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g1', entityType: 'account', entityId: 'acc1', targetAmountCents: 500000, targetDate: '2020-01-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();
  switchToRange(target, '1Y');
  await flushFake();

  const corridor = target.querySelector('.balances-goal-corridor');
  expect(corridor).not.toBeNull();

  const { x1, x2 } = parseLinePath(corridor.getAttribute('d'));
  // The corridor's forward (target) end clamps to today -- same point as
  // its start -- rather than extending backward into 2020.
  expect(x2).toBeCloseTo(x1, 5);
});

test('Separate view never renders a corridor even when a shown account has a goal', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g1', entityType: 'account', entityId: 'acc1', targetAmountCents: 500000, targetDate: '2027-06-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();
  // Prove this against a range where the corridor would otherwise draw.
  switchToRange(target, '1Y');
  await flushFake();

  switchToSeparateView(target);
  await flushFake();

  expect(target.querySelectorAll('.balances-goal-corridor').length).toBe(0);
});

// --- Finding #3: the corridor (and its x-axis forward-extension) only
// applies when range is '1Y' or 'all' -- not '1M'/'3M'/'6M', where it would
// otherwise squash the real balance history into a sliver at the left edge
// while the corridor dominates the chart. ---

test('with range 1M (the default), a shown account with a matching goal draws no corridor and the x-axis is not extended', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g1', entityType: 'account', entityId: 'acc1', targetAmountCents: 500000, targetDate: '2027-06-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();

  // No corridor at all.
  expect(target.querySelectorAll('.balances-goal-corridor').length).toBe(0);

  // And the x-axis is not stretched out to the goal's targetDate -- every
  // tick stays within the loaded balance history's own 3-day span (Oct
  // 24-26, 2026), all the same month, exactly as it would with no goals.
  const tickLabels = Array.from(target.querySelectorAll('.balances-axis-label--x')).map((el) => el.textContent.trim());
  const months = new Set(tickLabels.map((label) => label.split(' ')[0]));
  expect(months.size).toBe(1);
});

test('with range 3M or 6M, a shown account with a matching goal still draws no corridor', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g1', entityType: 'account', entityId: 'acc1', targetAmountCents: 500000, targetDate: '2027-06-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();

  for (const label of ['3M', '6M']) {
    switchToRange(target, label);
    await flushFake();
    expect(target.querySelectorAll('.balances-goal-corridor').length).toBe(0);
  }
});

test("with range 'all', a shown account with a matching goal draws a corridor (same as '1Y')", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g1', entityType: 'account', entityId: 'acc1', targetAmountCents: 500000, targetDate: '2027-06-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();
  switchToRange(target, 'All');
  await flushFake();

  expect(target.querySelectorAll('.balances-goal-corridor').length).toBe(1);
});

// --- Finding #1: stackedYScale's domain must extend to cover a matched
// goal's target value, not just the stacked area data -- otherwise a goal
// whose target is well above the current balance (the normal case) maps to
// a y-pixel above the domain's max, off the top of the chart entirely. ---

test("a goal target far above the current stacked total still has its corridor endpoint land inside the chart's drawable area", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26));

  // A college-fund-style goal: $5,000 target against a stacked total of a
  // few hundred dollars (acc1's own $110 + acc2's $505 = $615).
  fetchApi.mockImplementation((url) =>
    url.includes('/api/goals')
      ? jsonResponse({
          goals: [{ id: 'g1', entityType: 'account', entityId: 'acc1', targetAmountCents: 500000, targetDate: '2027-06-01' }],
        })
      : jsonResponse(multiDayPayload()),
  );

  const target = mountChart();
  await flushFake();
  switchToRange(target, '1Y');
  await flushFake();

  const corridor = target.querySelector('.balances-goal-corridor');
  expect(corridor).not.toBeNull();

  const { y2 } = parseLinePath(corridor.getAttribute('d'));
  // MARGIN.top is 16 -- the chart's drawable area starts there. Before the
  // fix, this target value fell outside stackedYScale's domain entirely,
  // mapping to a y well above (numerically less than) the plotted area's
  // top edge -- clipped off-canvas by the root <svg>.
  expect(y2).toBeGreaterThanOrEqual(16);
});

test('range config sets the initial range (ALL maps to the API\'s "all")', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));
  mountChart({ range: 'ALL' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(balanceCallsOnly()[0][0]).toContain('range=all');

  fetchApi.mockClear();
  mountChart({ range: '6M' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(balanceCallsOnly()[0][0]).toContain('range=6M');
});

test('chart="lines" starts in the lines view: one line per account, no stacked bands', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));
  const target = mountChart({ chart: 'lines' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(target.querySelectorAll('path.balances-line')).toHaveLength(2);
  expect(target.querySelectorAll('path.balances-area')).toHaveLength(0);
});

test('the default chart is the stacked combined view', async () => {
  fetchApi.mockResolvedValue(jsonResponse(multiDayPayload()));
  const target = mountChart();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(target.querySelectorAll('path.balances-area')).toHaveLength(2);
  expect(target.querySelectorAll('path.balances-line')).toHaveLength(0);
});
