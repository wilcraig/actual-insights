<script>
  import { scaleTime } from 'd3';
  import { fetchApi } from '../api-client';
  import { excludeCategories, layoutVertical } from './radar-data';

  // layout: 'horizontal' (default, the original timeline) or 'vertical'.
  // excludeCategoryIds: renewals in these categories never appear.
  let { layout: layoutMode = 'horizontal', excludeCategoryIds = [] } = $props();

  // Same categorical chart palette + fallback every other group-colored
  // widget uses, byte-for-byte (AccountBalancesChart.svelte's convention,
  // also used identically by SpendingSankey.svelte and SpendingTreemap.svelte).
  const CHART_QUAL_COUNT = 9;
  const FALLBACK_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
  // Not part of the qualitative palette above -- an ungrouped item (no
  // resolvable category group) must never land on index 0 and silently look
  // like it shares a real group's color.
  const UNGROUPED_COLOR = '#9ca3af';

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

  let items = $state(null); // null while loading; [] once loaded with nothing upcoming
  let errorMessage = $state(null);
  let containerWidth = $state(0);

  const MARGIN = { top: 8, right: 12, bottom: 8, left: 12 };
  const WINDOW_DAYS = 30;
  const LANE_HEIGHT = 20;
  const LABEL_GAP = 8; // minimum horizontal space between two labels in a lane
  const TICK_STRIP = 22; // room under the axis for the date ticks
  const FONT = '11px system-ui, -apple-system, sans-serif';

  // Same stable-boundary pattern bills-timeline.js/month-end-projection.js
  // use server-side -- here client-side, since this widget runs entirely in
  // the browser (server clock is irrelevant to it; see component brief).
  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  // Duplicated from PacingBars.svelte/BurnRateChart.svelte rather than
  // extracted to a shared module -- same established precedent: a small
  // function with one call site per widget, each widget keeps its own copy.
  function monthString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  function formatDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  // `date` strings from /api/bills-timeline are always `YYYY-MM-DD`; parsed
  // as local-calendar-day components rather than via `new Date(str)` to
  // avoid that string form's UTC-midnight parsing (same convention as
  // AccountBalancesChart.svelte's/BurnRateChart.svelte's parseDateOnly).
  function parseDateOnly(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  async function load() {
    errorMessage = null;
    items = null;

    try {
      const today = startOfLocalDay(new Date());
      const windowEnd = addDays(today, WINDOW_DAYS);

      const currentMonth = monthString(today);
      const months = [currentMonth];
      const windowEndMonth = monthString(windowEnd);
      if (windowEndMonth !== currentMonth) {
        months.push(windowEndMonth);
      }

      const responses = await Promise.all(months.map((month) => fetchApi(`/api/bills-timeline?month=${month}`)));

      const failed = responses.find((response) => !response.ok);
      if (failed) {
        errorMessage = `Subscription renewal radar unavailable (${failed.status})`;
        return;
      }

      const bodies = await Promise.all(responses.map((response) => response.json()));
      const merged = bodies.flatMap((body) => body.items || []);

      const windowEndStr = formatDate(windowEnd);
      items = merged.filter((item) => item.date <= windowEndStr);
    } catch {
      errorMessage = 'Subscription renewal radar unavailable: could not reach insights-api.';
    }
  }

  load();

  let today = $derived(startOfLocalDay(new Date()));
  let windowEnd = $derived(addDays(today, WINDOW_DAYS));

  let width = $derived(Math.max(containerWidth || 720, 360));
  let xScale = $derived(scaleTime().domain([today, windowEnd]).range([MARGIN.left + 6, width - MARGIN.right - 6]));

  let measureContext = null;
  function textWidth(text) {
    try {
      measureContext ??= document.createElement('canvas').getContext('2d');
      if (measureContext) {
        measureContext.font = FONT;
        const measured = measureContext.measureText(text).width;
        if (measured > 0) return measured;
      }
    } catch {
      // No canvas (tests); fall back to an average glyph width below.
    }
    return text.length * 6.2;
  }

  // Bills are negative in Actual, deposits positive; labels show the size
  // with a "+" only on deposits. Cents only where they matter.
  function formatAmount(cents) {
    const abs = Math.abs(cents) / 100;
    const text = abs.toLocaleString(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: abs < 100 && abs % 1 !== 0 ? 2 : 0,
      maximumFractionDigits: abs < 100 ? 2 : 0,
    });
    return cents > 0 ? `+${text}` : text;
  }

  // Each distinct groupName gets a stable color index, assigned the first
  // time it's seen in date-sorted item order (this widget's own call --
  // documented here per the task brief -- rather than alphabetical, since
  // that order is otherwise arbitrary and first-seen reads naturally as
  // "in the order they appear on the timeline"). `null` (ungrouped) never
  // gets a palette index at all; it always uses the dedicated neutral
  // UNGROUPED_COLOR instead, so it can never collide with a real group that
  // also resolved to index 0.
  let sortedItems = $derived.by(() => {
    if (!items) return [];
    return [...excludeCategories(items, excludeCategoryIds)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  });

  let coloredItems = $derived.by(() => {
    const groupIndexByName = new Map();
    let nextIndex = 0;

    return sortedItems.map((item, i) => {
      let color;
      if (item.groupName) {
        if (!groupIndexByName.has(item.groupName)) {
          groupIndexByName.set(item.groupName, nextIndex++);
        }
        color = colorFor(groupIndexByName.get(item.groupName));
      } else {
        color = UNGROUPED_COLOR;
      }

      return {
        key: `${item.scheduleId}-${item.date}-${i}`,
        scheduleId: item.scheduleId,
        payeeName: item.payeeName,
        date: item.date,
        amountCents: item.amountCents,
        cx: xScale(parseDateOnly(item.date)),
        color,
      };
    });
  });

  const DOT_RADIUS = 5;

  // Lane packing: each label goes in the closest free lane to the axis,
  // trying above then below, then one lane further out on each side, so no
  // two labels ever overlap. Labels are centered on their dot and clamped
  // to the chart edges; a stem connects each label to its dot.
  let layout = $derived.by(() => {
    const lanes = { above: [], below: [] }; // each lane: right edge of its last label
    const sameDayCount = new Map();
    const placed = coloredItems.map((item) => {
      const text = `${item.payeeName} ${formatAmount(item.amountCents)}`;
      const w = textWidth(text);
      const x0 = Math.min(Math.max(item.cx - w / 2, MARGIN.left), width - MARGIN.right - w);
      let side = null;
      let lane = 0;
      for (lane = 0; side === null; lane++) {
        for (const s of ['above', 'below']) {
          if ((lanes[s][lane] ?? -Infinity) + LABEL_GAP <= x0) {
            side = s;
            break;
          }
        }
        if (side) break;
      }
      lanes[side][lane] = x0 + w;
      const stack = sameDayCount.get(item.date) ?? 0;
      sameDayCount.set(item.date, stack + 1);
      return { ...item, text, x0, w, side, lane, stack };
    });

    const lanesAbove = Math.max(lanes.above.length, 1);
    const lanesBelow = lanes.below.length;
    const maxStack = Math.max(0, ...placed.map((p) => p.stack));
    const dotBand = DOT_RADIUS * 2 + maxStack * (DOT_RADIUS * 2 + 2);
    const axisY = MARGIN.top + lanesAbove * LANE_HEIGHT + dotBand;
    const height = axisY + TICK_STRIP + lanesBelow * LANE_HEIGHT + MARGIN.bottom;

    const dots = placed.map((p) => {
      // Same-day dots stack upward so none hides another.
      const cy = axisY - p.stack * (DOT_RADIUS * 2 + 2);
      const labelY =
        p.side === 'above'
          ? axisY - dotBand - p.lane * LANE_HEIGHT - 6
          : axisY + TICK_STRIP + p.lane * LANE_HEIGHT + 12;
      const stemEnd = p.side === 'above' ? labelY + 4 : labelY - 11;
      return { ...p, cy, labelY, stemStart: p.side === 'above' ? cy - DOT_RADIUS : axisY + DOT_RADIUS, stemEnd };
    });

    const ticks = [];
    for (let d = today; d <= windowEnd; d = addDays(d, 7)) {
      ticks.push({ x: xScale(d), label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
    }

    return { dots, axisY, height, ticks };
  });

  let isEmpty = $derived(items !== null && sortedItems.length === 0);

  const AXIS_X = 56;
  let vertical = $derived(
    layoutVertical(coloredItems, {
      today,
      windowDays: WINDOW_DAYS,
      width,
      measure: textWidth,
      axisX: AXIS_X,
      amountText: formatAmount,
    }),
  );
  let verticalWidth = $derived(Math.max(containerWidth || 320, 240));

  function shortDate(dateStr) {
    return parseDateOnly(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
</script>

<div class="actualmint-subscription-radar" bind:clientWidth={containerWidth}>
  {#if errorMessage}
    <p class="radar-error" role="alert">{errorMessage}</p>
  {:else if items === null}
    <p class="radar-loading">Loading subscription renewal radar…</p>
  {:else if isEmpty}
    <p class="radar-empty">Nothing upcoming in the next 30 days.</p>
  {:else if layoutMode === 'vertical'}
    <!-- The graph is decorative for assistive tech: the list below is its
         text equivalent, one readable item per renewal. -->
    <svg
      class="radar-svg radar-svg--vertical"
      width={verticalWidth}
      height={vertical.height}
      viewBox="0 0 {verticalWidth} {vertical.height}"
      aria-hidden="true"
    >
      <line class="radar-axis" x1={vertical.axisX} y1={vertical.axisTop} x2={vertical.axisX} y2={vertical.axisBottom} />
      {#each vertical.ticks as tick (tick.day)}
        <line class="radar-tick" x1={vertical.axisX - 4} y1={tick.y} x2={vertical.axisX} y2={tick.y} />
        <text class="radar-tick-label" x={vertical.axisX - 8} y={tick.y + 3} text-anchor="end">{shortDate(formatDate(addDays(today, tick.day)))}</text>
      {/each}
      {#each vertical.rows as row (coloredItems[row.index].key)}
        {@const item = coloredItems[row.index]}
        <g class="radar-item">
          {#if row.displaced}
            <polyline class="radar-stem" points="{vertical.axisX},{row.dotY} {vertical.axisX + 10},{row.dotY} {vertical.axisX + 14},{row.labelY - 4} {row.labelX - 4},{row.labelY - 4}" fill="none" stroke={item.color} />
          {:else}
            <line class="radar-stem" x1={vertical.axisX} y1={row.dotY} x2={row.labelX - 4} y2={row.dotY} stroke={item.color} />
          {/if}
          <circle class="radar-dot" data-schedule-id={item.scheduleId} cx={vertical.axisX} cy={row.dotY} r={DOT_RADIUS} fill={item.color} />
          <text class="radar-label" x={row.labelX} y={row.labelY}>
            <tspan class="radar-label-name">{row.name}</tspan>
            <tspan class="radar-label-amount" class:radar-label-amount--deposit={item.amountCents > 0} dx="4">{row.amount}</tspan>
          </text>
          <text class="radar-tick-label" x={row.labelX} y={row.dateY}>{shortDate(item.date)}</text>
        </g>
      {/each}
    </svg>
    <ol class="radar-list">
      {#each coloredItems as item (item.key)}
        <li><time datetime={item.date}>{item.date}</time>: {item.payeeName}, {formatAmount(item.amountCents)}</li>
      {/each}
    </ol>
  {:else}
    <svg
      class="radar-svg"
      width={width}
      height={layout.height}
      viewBox="0 0 {width} {layout.height}"
      role="img"
      aria-label="Upcoming scheduled transactions in the next 30 days"
    >
      <line class="radar-axis" x1={MARGIN.left} y1={layout.axisY} x2={width - MARGIN.right} y2={layout.axisY} />
      {#each layout.ticks as tick (tick.x)}
        <line class="radar-tick" x1={tick.x} y1={layout.axisY} x2={tick.x} y2={layout.axisY + 4} />
        <text class="radar-tick-label" x={tick.x} y={layout.axisY + 15} text-anchor="middle">{tick.label}</text>
      {/each}

      {#each layout.dots as dot (dot.key)}
        <g class="radar-item">
          <line class="radar-stem" x1={dot.cx} y1={dot.stemStart} x2={dot.cx} y2={dot.stemEnd} stroke={dot.color} />
          <text class="radar-label" x={dot.x0} y={dot.labelY}>
            <title>{dot.date}: {dot.payeeName} {formatAmount(dot.amountCents)}</title>
            <tspan class="radar-label-name">{dot.payeeName}</tspan>
            <tspan class="radar-label-amount" class:radar-label-amount--deposit={dot.amountCents > 0} dx="4">{formatAmount(dot.amountCents)}</tspan>
          </text>
          <circle class="radar-dot" data-schedule-id={dot.scheduleId} cx={dot.cx} cy={dot.cy} r={DOT_RADIUS} fill={dot.color} />
        </g>
      {/each}
    </svg>
  {/if}
</div>

<style>
  .actualmint-subscription-radar {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
    /* Establishes this widget's own box (not the viewport) as the sizing
       context, since it's mounted into a host element of unpredictable
       width inside an Actual report page. */
    container-type: inline-size;
  }

  .radar-error {
    color: #b91c1c;
    font-weight: 600;
  }

  .radar-loading,
  .radar-empty {
    color: #555;
  }

  .radar-svg {
    display: block;
  }

  .radar-list {
    margin: 0;
    padding-left: 1.25rem;
    font-size: 0.8rem;
    color: #374151;
  }

  .radar-axis,
  .radar-tick {
    stroke: #d1d5db;
    stroke-width: 1;
  }

  .radar-stem {
    stroke-width: 1;
    stroke-opacity: 0.6;
  }

  .radar-tick-label {
    font-size: 10px;
    fill: #6b7280;
  }

  .radar-label {
    font: 11px system-ui, -apple-system, sans-serif;
    fill: #374151;
    /* White halo keeps text legible where another item's stem crosses it. */
    paint-order: stroke;
    stroke: #fff;
    stroke-width: 3px;
    stroke-linejoin: round;
  }

  .radar-label-amount {
    fill: #6b7280;
  }

  .radar-label-amount--deposit {
    fill: #15803d;
  }
</style>
