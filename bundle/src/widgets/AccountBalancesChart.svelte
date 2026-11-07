<script>
  import { scaleTime, scaleLinear, line as d3Line, area as d3Area, stack as d3Stack, extent as d3Extent, timeFormat } from 'd3';
  import { fetchApi } from '../api-client';

  // An empty array (the default) means "every open account," matching the
  // API's own default when its `accounts` query param is omitted.
  // labelContent controls what the combined view's in-band label shows:
  // 'both' (the default, amount then name), 'amount', or 'name'.
  // chart ('stacked' | 'lines') and range ('1M' | '3M' | '6M' | '1Y' | 'ALL')
  // are the initial selection from the widget's config; the buttons still
  // change them.
  let { accountIds = [], labelContent = 'both', chart = 'stacked', range: initialRange = '1M' } = $props();

  const normalizeRange = (r) => {
    const upper = String(r).toUpperCase();
    return upper === 'ALL' ? 'all' : ['1M', '3M', '6M', '1Y'].includes(upper) ? upper : '1M';
  };
  let range = $state(normalizeRange(initialRange));
  // "Combined" (the default) draws every account as its own stacked-area
  // band, each labeled with its own name and current balance (never a
  // shared/flattened scale, since each band's label is just that
  // account's own figure, not a y-axis reading) -- "Separate" is kept for
  // anyone who prefers one small area chart per account instead.
  let view = $state(chart === 'lines' ? 'lines' : 'combined');
  let data = $state(null);
  let errorMessage = $state(null);

  const RANGES = [
    { value: '1M', label: '1M' },
    { value: '3M', label: '3M' },
    { value: '6M', label: '6M' },
    { value: '1Y', label: '1Y' },
    { value: 'all', label: 'All' },
  ];

  const VIEWS = [
    { value: 'separate', label: 'Separate' },
    { value: 'combined', label: 'Combined' },
    { value: 'lines', label: 'Lines' },
  ];

  // Reads this account's color from the same categorical chart palette
  // (`--palette-chartQual1..9`) the pacing-bars drill-down donut uses --
  // Actual defines these natively, and the Fresh theme recolors them,
  // so this widget now follows whichever theme is active instead of a
  // fixed palette of its own that never changed with it.
  const CHART_QUAL_COUNT = 9;
  const FALLBACK_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

  function colorFor(index) {
    try {
      const varName = `--palette-chartQual${(index % CHART_QUAL_COUNT) + 1}`;
      const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      if (value) return value;
    } catch {
      // getComputedStyle can be unavailable in some test/SSR contexts --
      // fall through to the static fallback below.
    }
    return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
  }

  const WIDTH = 640;
  const HEIGHT = 320;
  const MARGIN = { top: 16, right: 16, bottom: 28, left: 64 };

  // Mini (per-account) charts are small sparkline-style area charts with no
  // axes -- the point is the shape and the large balance number next to it,
  // not precise readout, so there's no margin to reserve for tick labels.
  const MINI_WIDTH = 300;
  const MINI_HEIGHT = 72;

  // Includes a (short) year, not just month/day -- once the x-axis
  // extends forward to cover a multi-year-out goal (see allDates below),
  // a label like "Jan 01" alone gives no way to tell which year it is.
  const formatTick = timeFormat("%b %d, '%y");

  // Request-sequence guard, same pattern as CategoryBreakdownModal.svelte:
  // load() re-fires on every range-button click, and the user can switch
  // ranges again before a slower in-flight request resolves.
  let loadSeq = 0;

  async function load(currentRange) {
    const seq = ++loadSeq;
    errorMessage = null;
    data = null;

    try {
      const params = new URLSearchParams({ range: currentRange });
      if (accountIds.length > 0) params.set('accounts', accountIds.join(','));
      const response = await fetchApi(`/api/account-balances?${params}`);
      if (seq !== loadSeq) return; // a newer range selection has since started

      if (!response.ok) {
        errorMessage = `Account balances unavailable (${response.status})`;
        return;
      }

      const body = await response.json();
      if (seq !== loadSeq) return;
      data = body;
    } catch (err) {
      if (seq !== loadSeq) return;
      errorMessage = 'Account balances unavailable: could not reach insights-api.';
    }
  }

  // Re-fetch on mount and on every range change.
  $effect(() => {
    load(range);
  });

  // Goals change rarely, so they're fetched once per mount rather than
  // re-fetched on every range-button click the way account-balances data
  // is above -- this effect reads no reactive state in its body, so it
  // only ever reacts to mount, never to `range` changes. Failures here are
  // swallowed: the milestone corridor is a supplementary overlay, not core
  // chart data, so a failed /api/goals fetch just means no corridor draws,
  // not an error banner replacing the whole balances chart.
  let goals = $state([]);

  async function loadGoals() {
    try {
      const response = await fetchApi('/api/goals');
      if (!response.ok) return;
      const body = await response.json();
      goals = body.goals || [];
    } catch (err) {
      // Swallow -- see comment above loadGoals's declaration.
    }
  }

  $effect(() => {
    loadGoals();
  });

  // `date` strings are always `YYYY-MM-DD` (api/src/routes/account-balances.js);
  // parsed as local-calendar-day components rather than via `new Date(str)`
  // to avoid that string form's UTC-midnight parsing.
  function parseDateOnly(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function formatCents(cents) {
    return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }

  // Every account's series and netWorth are built from the same shared
  // `days` array (see account-balances.js), so a single account having one
  // point (or zero accounts at all) means there is nothing worth plotting --
  // the "brand-new budget" edge case: no transactions yet, so every series
  // collapses to today's single opening-balance point. A one-point (or
  // empty) series can't draw a line, so render a message instead of an
  // empty/zero-size SVG.
  let isEmpty = $derived(!data || data.accounts.length === 0 || data.netWorth.length <= 1);

  // `today`, local-calendar-day midnight -- same convention
  // SavingsGoalsThermometers.svelte uses for its own days-remaining
  // countdown, since neither /api/account-balances nor /api/goals provides
  // a server "today."
  function todayMidnight() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  // A goal's targetDate already in the past would otherwise draw the
  // milestone corridor backwards in time -- clamp its forward end to today
  // instead.
  function clampToToday(date) {
    const today = todayMidnight();
    return date < today ? today : date;
  }

  // Account-type goals whose entityId matches one of the accounts the
  // current load() response actually shows -- a goal on a filtered-out or
  // closed account draws no corridor.
  let matchedAccountGoals = $derived.by(() => {
    if (!data || isEmpty) return new Map();
    const shownAccountIds = new Set(data.accounts.map((a) => a.id));
    const map = new Map();
    for (const goal of goals) {
      if (goal.entityType === 'account' && shownAccountIds.has(goal.entityId)) {
        map.set(goal.entityId, goal);
      }
    }
    return map;
  });

  // Per product ruling (final whole-branch review): the milestone corridor
  // -- and the x-axis forward-extension that exists only to make room for
  // it -- only makes sense once the selected range is wide enough that the
  // real balance history isn't squashed into a sliver next to it. '1M',
  // '3M', and '6M' render exactly as they would with no goals at all.
  let goalRangeEligible = $derived(range === '1Y' || range === 'all');

  // Extended, when a shown account has a matching goal (and the range is
  // wide enough, see goalRangeEligible above), to cover that goal's own
  // (clamped) targetDate -- so the x-axis stretches forward to show the
  // milestone corridor (drawn below, Combined view only) even when its
  // targetDate falls after the loaded balance history's last day.
  let allDates = $derived.by(() => {
    if (!data || isEmpty) return [];
    const dates = data.netWorth.map((p) => parseDateOnly(p.date));
    if (goalRangeEligible) {
      for (const goal of matchedAccountGoals.values()) {
        dates.push(clampToToday(parseDateOnly(goal.targetDate)));
      }
    }
    return dates;
  });

  let xScale = $derived.by(() => {
    if (allDates.length === 0) return null;
    return scaleTime()
      .domain(d3Extent(allDates))
      .range([MARGIN.left, WIDTH - MARGIN.right]);
  });

  let xTicks = $derived(xScale ? xScale.ticks(5) : []);

  // Stacked-area combined view: every account's series shares the same
  // `days` array by construction (account-balances.js builds every
  // account's points -- and netWorth's -- by iterating the same `days`
  // list), so each account's points[i] is always the same calendar day,
  // letting rows be built by zipping on index rather than re-matching
  // dates across accounts.
  let stackedRows = $derived(
    data && !isEmpty
      ? data.accounts[0].points.map((point, i) => {
          const row = { date: point.date };
          for (const account of data.accounts) {
            row[account.id] = account.points[i]?.balanceCents ?? 0;
          }
          return row;
        })
      : []
  );

  let stackKeys = $derived(data && !isEmpty ? data.accounts.map((a) => a.id) : []);

  let stackedSeries = $derived.by(() => {
    if (stackedRows.length === 0 || stackKeys.length === 0) return [];
    return d3Stack().keys(stackKeys)(stackedRows);
  });

  // Each matched goal's "end value in stacked-space" -- base (the layer's
  // cumulative total below it, same as corridorPathFor computes) plus the
  // goal's own targetAmountCents -- computed here, ahead of stackedYScale,
  // so its domain can be extended to cover it. Without this, a goal whose
  // target is well above the account's current balance (the normal case,
  // e.g. a college fund) maps to a y-pixel above the domain's max, i.e.
  // off-canvas: the corridor's whole point (showing where the balance
  // needs to go) would be invisible. Gated the same way as allDates' own
  // x-axis extension (see goalRangeEligible above).
  let goalEndValues = $derived.by(() => {
    if (!goalRangeEligible || stackedSeries.length === 0) return [];
    const values = [];
    for (let index = 0; index < stackKeys.length; index++) {
      const goal = matchedAccountGoals.get(stackKeys[index]);
      if (!goal) continue;
      const layer = stackedSeries[index];
      const base = layer[layer.length - 1][0];
      values.push(base + goal.targetAmountCents);
    }
    return values;
  });

  let stackedYScale = $derived.by(() => {
    if (stackedSeries.length === 0) return null;
    let [min, max] = d3Extent([
      ...stackedSeries.flatMap((layer) => layer.flatMap((d) => [d[0], d[1]])),
      ...goalEndValues,
    ]);
    min = Math.min(min, 0);
    // A perfectly flat combined range (e.g. every account holding a steady
    // zero balance) would otherwise collapse scaleLinear's domain to a
    // single point -- pad it so the bands still render at a sensible
    // height instead of degenerating.
    if (min === max) {
      const pad = Math.max(Math.abs(max) * 0.1, 100);
      max += pad;
    }
    return scaleLinear()
      .domain([min, max])
      .nice()
      .range([HEIGHT - MARGIN.bottom, MARGIN.top]);
  });

  let stackedAreaGen = $derived.by(() => {
    if (!xScale || !stackedYScale) return null;
    return d3Area()
      .x((d) => xScale(parseDateOnly(d.data.date)))
      .y0((d) => stackedYScale(d[0]))
      .y1((d) => stackedYScale(d[1]));
  });

  function stackedAreaPath(layer) {
    return stackedAreaGen ? stackedAreaGen(layer) : null;
  }

  // The label drawn inside each band is that account's OWN current balance
  // (not the running cumulative total) -- read straight from the account's
  // own last point rather than derived from the stack's [y0, y1] pair, so
  // it's exact rather than a subtraction of two already-scaled values.
  function layerOwnBalance(index) {
    const points = data.accounts[index].points;
    return points[points.length - 1].balanceCents;
  }

  // The vertical center of the one-line "name  balance" label drawn inside
  // this band -- centered in the band's own height where there's room;
  // clamped to stay inside the band (rather than centered) once the band
  // gets thin, so the label never spills into its neighbor.
  function layerLabelY(layer) {
    const last = layer[layer.length - 1];
    const bandHeight = stackedYScale(last[0]) - stackedYScale(last[1]);
    const offset = Math.min(bandHeight / 2, 20);
    return stackedYScale(last[1]) + Math.max(offset, 18);
  }

  // A noticeably darker shade of this band's own fill color, for the label
  // drawn inside it: same hue (so the label reads as "belonging" to its
  // band), but mixed toward black for the contrast a label needs against a
  // translucent 0.3-opacity fill -- plain `colorFor()` is too light/soft to
  // read well as text at that opacity.
  function labelColorFor(index) {
    return `color-mix(in srgb, ${colorFor(index)} 55%, black 45%)`;
  }

  // The college-growth milestone corridor for this band's own account, if
  // it has a matching goal: a dashed line from (today, this account's own
  // current balance) to (the goal's own, clamped, targetDate,
  // targetAmountCents). Plotted inside this layer's own stacked band --
  // offset by `base`, the layer's cumulative total at its last point (i.e.
  // every account stacked below it) -- so the corridor reads as belonging
  // to that account's band rather than floating at its raw, unstacked
  // value against the combined scale.
  function corridorPathFor(layer, index) {
    if (!xScale || !stackedYScale || !goalRangeEligible) return null;
    const account = data.accounts[index];
    const goal = matchedAccountGoals.get(account.id);
    if (!goal) return null;

    const base = layer[layer.length - 1][0];
    const startX = xScale(todayMidnight());
    const startY = stackedYScale(base + layerOwnBalance(index));
    const targetDate = clampToToday(parseDateOnly(goal.targetDate));
    const endX = xScale(targetDate);
    const endY = stackedYScale(base + goal.targetAmountCents);

    return `M ${startX} ${startY} L ${endX} ${endY}`;
  }

  // The combined view's own total, shown as a single figure below the
  // chart (rather than as a band of its own, and rather than as the
  // top-of-stack cumulative label the per-band callouts used to carry) --
  // same figure as the Separate view's Total card, computed the same way.
  let combinedTotal = $derived(data && !isEmpty ? latestBalance(data.netWorth) : 0);

  // A mini chart's own y-scale is fit to just that one series, independent
  // of every other account -- the whole point of the "Separate" view.
  function miniScalesFor(points) {
    const dates = points.map((p) => parseDateOnly(p.date));
    let [min, max] = d3Extent(points, (p) => p.balanceCents);
    if (min === max) {
      const pad = Math.max(Math.abs(min) * 0.1, 100);
      min -= pad;
      max += pad;
    }
    const x = scaleTime().domain(d3Extent(dates)).range([0, MINI_WIDTH]);
    const y = scaleLinear().domain([min, max]).nice().range([MINI_HEIGHT - 2, 2]);
    return { x, y };
  }

  function miniAreaPath(points) {
    if (points.length < 2) return null;
    const { x, y } = miniScalesFor(points);
    const areaGen = d3Area()
      .x((p) => x(parseDateOnly(p.date)))
      .y0(MINI_HEIGHT)
      .y1((p) => y(p.balanceCents));
    return areaGen(points);
  }

  function miniLinePath(points) {
    if (points.length < 2) return null;
    const { x, y } = miniScalesFor(points);
    return d3Line()
      .x((p) => x(parseDateOnly(p.date)))
      .y((p) => y(p.balanceCents))(points);
  }

  // Lines view: one line per account on a shared scale.
  let linesYScale = $derived.by(() => {
    if (!data || isEmpty || !xScale) return null;
    let [min, max] = d3Extent(data.accounts.flatMap((a) => a.points.map((p) => p.balanceCents)));
    if (min === undefined) return null;
    if (min === max) {
      const pad = Math.max(Math.abs(max) * 0.1, 100);
      min -= pad;
      max += pad;
    }
    return scaleLinear().domain([min, max]).nice().range([HEIGHT - MARGIN.bottom, MARGIN.top]);
  });

  function accountLinePath(points) {
    if (!xScale || !linesYScale || points.length < 2) return null;
    return d3Line()
      .x((p) => xScale(parseDateOnly(p.date)))
      .y((p) => linesYScale(p.balanceCents))(points);
  }

  function latestBalance(points) {
    return points.length > 0 ? points[points.length - 1].balanceCents : 0;
  }
</script>

<div class="actualmint-account-balances-chart">
  <!-- Always visible (not gated on load/error state) so a range/view can be
       picked again -- e.g. to retry -- even while a previous request is
       still loading or failed. -->
  <div class="balances-toolbar">
    <div class="balances-controls" role="group" aria-label="View">
      {#each VIEWS as v (v.value)}
        <button
          type="button"
          class="balances-range-button"
          class:balances-range-button--active={view === v.value}
          onclick={() => (view = v.value)}
        >
          {v.label}
        </button>
      {/each}
    </div>

    <div class="balances-controls" role="group" aria-label="Date range">
      {#each RANGES as r (r.value)}
        <button
          type="button"
          class="balances-range-button"
          class:balances-range-button--active={range === r.value}
          onclick={() => (range = r.value)}
        >
          {r.label}
        </button>
      {/each}
    </div>
  </div>

  {#if errorMessage}
    <p class="balances-error" role="alert">{errorMessage}</p>
  {:else if data === null}
    <p class="balances-loading">Loading account balances…</p>
  {:else if isEmpty}
    <p class="balances-empty">Not enough balance history yet to chart.</p>
  {:else if view === 'separate'}
    <div class="balances-grid">
      <div class="balances-mini-card balances-mini-card--total">
        <div class="balances-mini-header">
          <span class="balances-mini-label">Total</span>
          <span class="balances-mini-value balances-mini-value--total">{formatCents(latestBalance(data.netWorth))}</span>
        </div>
        {#if miniAreaPath(data.netWorth)}
          <svg class="balances-mini-svg" viewBox="0 0 {MINI_WIDTH} {MINI_HEIGHT}" role="img" aria-label="Total balance over time">
            <path class="balances-mini-area" d={miniAreaPath(data.netWorth)} fill="#111827" fill-opacity="0.12" />
            <path class="balances-mini-line" d={miniLinePath(data.netWorth)} stroke="#111827" fill="none" />
          </svg>
        {/if}
      </div>

      {#each data.accounts as account, index (account.id)}
        <div class="balances-mini-card">
          <div class="balances-mini-header">
            <span class="balances-mini-label">{account.name}</span>
            <span class="balances-mini-value" style:color={colorFor(index)}>{formatCents(latestBalance(account.points))}</span>
          </div>
          {#if miniAreaPath(account.points)}
            <svg class="balances-mini-svg" viewBox="0 0 {MINI_WIDTH} {MINI_HEIGHT}" role="img" aria-label="{account.name} balance over time">
              <path class="balances-mini-area" d={miniAreaPath(account.points)} fill={colorFor(index)} fill-opacity="0.18" />
              <path class="balances-mini-line" d={miniLinePath(account.points)} stroke={colorFor(index)} fill="none" />
            </svg>
          {/if}
        </div>
      {/each}
    </div>
  {:else if view === 'lines'}
    <svg
      class="balances-svg balances-lines-svg"
      viewBox="0 0 {WIDTH} {HEIGHT}"
      role="img"
      aria-label="Account balances over time, lines"
    >
      {#each data.accounts as account, index (account.id)}
        <path class="balances-line" d={accountLinePath(account.points)} stroke={colorFor(index)} stroke-width="2" fill="none" />
      {/each}
      {#each xTicks as tick (tick.getTime())}
        <text class="balances-axis-label balances-axis-label--x" x={xScale(tick)} y={HEIGHT - MARGIN.bottom + 16}>
          {formatTick(tick)}
        </text>
      {/each}
    </svg>
    <ul class="balances-legend">
      {#each data.accounts as account, index (account.id)}
        <li><span class="balances-swatch" style:background={colorFor(index)}></span>{account.name} {formatCents(latestBalance(account.points))}</li>
      {/each}
    </ul>
    <p class="balances-combined-total">Total: {formatCents(combinedTotal)}</p>
  {:else}
    <svg
      class="balances-svg"
      viewBox="0 0 {WIDTH} {HEIGHT}"
      role="img"
      aria-label="Account balances over time, stacked"
    >
      {#each stackedSeries as layer, index (stackKeys[index])}
        <path
          class="balances-area"
          d={stackedAreaPath(layer)}
          fill={colorFor(index)}
          fill-opacity="0.3"
          stroke={colorFor(index)}
          stroke-opacity="0.6"
        />
      {/each}

      {#each stackedSeries as layer, index (stackKeys[index])}
        {#if corridorPathFor(layer, index)}
          <path
            class="balances-goal-corridor"
            d={corridorPathFor(layer, index)}
            stroke={labelColorFor(index)}
            stroke-width="2"
            stroke-dasharray="4 3"
            fill="none"
          />
        {/if}
      {/each}

      {#each stackedSeries as layer, index (stackKeys[index])}
        <text
          class="balances-area-combined-label"
          x={WIDTH - MARGIN.right - 12}
          y={layerLabelY(layer)}
          text-anchor="end"
          style:fill={labelColorFor(index)}
        >
          {#if labelContent !== 'name'}
            <tspan class="balances-area-label">{formatCents(layerOwnBalance(index))}</tspan>
          {/if}
          {#if labelContent === 'both'}
            <tspan class="balances-area-name" dx="8">{data.accounts[index].name}</tspan>
          {:else if labelContent === 'name'}
            <tspan class="balances-area-name">{data.accounts[index].name}</tspan>
          {/if}
        </text>
      {/each}

      {#each xTicks as tick (tick.getTime())}
        <text
          class="balances-axis-label balances-axis-label--x"
          x={xScale(tick)}
          y={HEIGHT - MARGIN.bottom + 16}
        >
          {formatTick(tick)}
        </text>
      {/each}
    </svg>

    <p class="balances-combined-total">Total: {formatCents(combinedTotal)}</p>
  {/if}
</div>

<style>
  .actualmint-account-balances-chart {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
    /* Establishes this widget's own box (not the viewport) as the sizing
       context, since it's mounted into a host element of unpredictable
       width inside an Actual report page. */
    container-type: inline-size;
  }

  .balances-error {
    color: #b91c1c;
    font-weight: 600;
  }

  .balances-loading,
  .balances-empty {
    color: #555;
  }

  .balances-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .balances-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .balances-range-button {
    padding: 0.25rem 0.65rem;
    border: 1px solid #d1d5db;
    border-radius: 999px;
    background: #fff;
    color: #374151;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .balances-range-button--active {
    background: var(--palette-chartQual1, #2563eb);
    border-color: var(--palette-chartQual1, #2563eb);
    color: #fff;
  }

  .balances-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.75rem;
  }

  .balances-mini-card {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.75rem;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    background: #fff;
    box-sizing: border-box;
  }

  .balances-mini-card--total {
    border-color: #d1d5db;
    background: #f9fafb;
  }

  .balances-mini-header {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .balances-mini-label {
    font-size: 0.75rem;
    color: #6b7280;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The large number the redesign is built around -- the account's current
     balance, big enough to read at a glance, colored to match its own
     chart line/area so the number and the shape read as one unit. */
  .balances-mini-value {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.1;
  }

  .balances-mini-value--total {
    color: #111827;
  }

  .balances-mini-svg {
    width: 100%;
    height: auto;
    display: block;
  }

  .balances-mini-line {
    stroke-width: 2;
  }

  .balances-svg {
    width: 100%;
    height: auto;
  }

  .balances-axis-label {
    font-size: 9px;
    fill: #6b7280;
  }

  .balances-axis-label--x {
    text-anchor: middle;
  }

  .balances-area {
    stroke-width: 1;
  }

  .balances-goal-corridor {
    pointer-events: none;
  }

  /* Account name + its own balance, one line, inside its own band. Color
     comes from the parent <text>'s inline fill (a darkened shade of that
     band's own color, see labelColorFor()) -- both tspans inherit it, so
     neither rule sets its own fill. */
  .balances-area-combined-label {
    font-size: 14px;
  }

  .balances-area-name {
    font-weight: 600;
  }

  .balances-area-label {
    font-size: 17px;
    font-weight: 700;
  }

  .balances-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 0.85rem;
  }

  .balances-swatch {
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    margin-right: 0.35rem;
  }

  .balances-combined-total {
    margin: 0;
    font-weight: 700;
    font-size: 1.1rem;
    color: #111827;
  }
</style>
