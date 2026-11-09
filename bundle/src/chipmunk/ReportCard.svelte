<script>
  import { colorFor, formatMoney, canShift, shiftMonth } from './logic';

  // One phone-style report card. `onMonth(card, month)` asks for another
  // month of a breakdown card; `busy`/`error` come from the parent.
  let { card, currentMonth = '', onMonth = null, busy = false, error = '' } = $props();

  const money = (v) => (card.format === 'percent' ? `${v}%` : card.format === 'number' ? String(v) : formatMoney(v));
  const items = $derived(card.kind === 'breakdown' ? card.items : []);
  const total = $derived(card.kind === 'breakdown' ? (card.total ?? items.reduce((s, i) => s + i.value, 0)) : 0);
  const R = 40;
  const C = 2 * Math.PI * R;
  const slices = $derived.by(() => {
    const sum = items.reduce((s, i) => s + Math.max(i.value, 0), 0) || 1;
    let offset = 0;
    return items.map((item, i) => {
      const len = (Math.max(item.value, 0) / sum) * C;
      const slice = { item, len, offset, color: colorFor(item.color, i) };
      offset += len;
      return slice;
    });
  });
  const points = $derived(card.kind === 'series' ? card.points : []);
  const maxAbs = $derived(Math.max(1, ...points.map((p) => Math.abs(p.value ?? 0))));
  const monthTitle = $derived(
    card.monthNav
      ? new Date(Number(card.monthNav.month.slice(0, 4)), Number(card.monthNav.month.slice(5, 7)) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' })
      : '',
  );
</script>

<section class="card" data-kind={card.kind} data-card-id={card.id}>
  <header>
    <h3>{card.title}</h3>
    {#if card.subtitle}<p class="sub">{card.subtitle}</p>{/if}
  </header>

  {#if card.kind === 'stat'}
    <p class="big">{money(card.value)}</p>
    {#if card.compare}<p class="sub">{card.compare.label}: {money(card.compare.value)}</p>{/if}
  {:else if card.kind === 'text'}
    <p class="text">{card.text}</p>
  {:else if card.kind === 'breakdown'}
    {#if card.monthNav && onMonth}
      <div class="months">
        <button type="button" class="arrow prev" aria-label="Previous month" disabled={busy || !canShift(card.monthNav, -1, currentMonth)} onclick={() => onMonth(card, shiftMonth(card.monthNav.month, -1))}>&lsaquo;</button>
        <span class="month-label">{monthTitle}</span>
        <button type="button" class="arrow next" aria-label="Next month" disabled={busy || !canShift(card.monthNav, 1, currentMonth)} onclick={() => onMonth(card, shiftMonth(card.monthNav.month, 1))}>&rsaquo;</button>
      </div>
    {/if}
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    {#if card.chart === 'donut' || card.chart === 'pie'}
      <svg class="donut" viewBox="0 0 100 100" role="img" aria-label="{card.title} chart">
        {#each slices as s}
          <circle cx="50" cy="50" r={R} fill="none" stroke={s.color} stroke-width={card.chart === 'pie' ? 2 * R : 14} stroke-dasharray="{s.len} {C - s.len}" stroke-dashoffset={-s.offset} transform="rotate(-90 50 50)" />
        {/each}
        {#if card.chart !== 'pie'}<text x="50" y="52" text-anchor="middle" font-size="9" fill="currentColor">{money(total)}</text>{/if}
      </svg>
    {/if}
    <ul class="rows">
      {#each items as item, i}
        {@const share = total > 0 ? Math.round((item.value / total) * 100) : 0}
        <li>
          <span class="chip" style="background:{colorFor(item.color, i)}"></span>
          <span class="label">{item.label}</span>
          <span class="share">{share}%</span>
          <span class="val">{money(item.value)}</span>
          {#if card.chart !== 'donut' && card.chart !== 'pie'}
            <span class="bar"><i style="width:{Math.max(0, Math.min(100, share))}%; background:{colorFor(item.color, i)}"></i></span>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="sub total">Total {money(total)}</p>
  {:else if card.kind === 'series'}
    <svg class="series" viewBox="0 0 {Math.max(1, points.length) * 24} 60" preserveAspectRatio="none" role="img" aria-label="{card.title} chart">
      {#each points as p, i}
        {@const h = (Math.abs(p.value ?? 0) / maxAbs) * 26}
        <rect x={i * 24 + 4} y={p.value < 0 ? 30 : 30 - h} width="16" height={h} fill={p.value < 0 ? '#dc2626' : '#16a34a'} />
      {/each}
    </svg>
    <ul class="rows compact">
      {#each points.slice(-6) as p}<li><span class="label">{p.label}</span><span class="val">{money(p.value)}</span></li>{/each}
    </ul>
  {:else if card.kind === 'progress'}
    <ul class="rows">
      {#each card.items as it}
        {@const pct = it.target > 0 ? Math.min(100, Math.round((it.current / it.target) * 100)) : 0}
        <li class="progress">
          <span class="label">{it.label}</span>
          <span class="val">{money(it.current)} of {money(it.target)}</span>
          <span class="bar"><i style="width:{pct}%; background:{it.current > it.target ? '#dc2626' : colorFor(it.color, 0)}"></i></span>
        </li>
      {/each}
    </ul>
  {:else if card.kind === 'list'}
    <ul class="rows">
      {#each card.rows as r}
        <li><span class="label">{r.title}{#if r.subtitle}<small> {r.subtitle}</small>{/if}</span>{#if r.date}<span class="share">{r.date}</span>{/if}<span class="val">{money(r.value)}</span></li>
      {/each}
    </ul>
  {:else if card.kind === 'gauge'}
    <p class="big">{card.value}%</p>
    <span class="bar"><i style="width:{Math.max(0, Math.min(100, ((card.value - card.min) / (card.max - card.min || 1)) * 100))}%; background:{colorFor('green')}"></i></span>
    {#if card.caption}<p class="sub">{card.caption}</p>{/if}
  {:else if card.kind === 'table'}
    <table>
      <thead><tr><th></th>{#each card.columns as c}<th>{c}</th>{/each}</tr></thead>
      <tbody>
        {#each card.rows as r}<tr><th>{r.label}</th>{#each r.values as v}<td>{v === null ? '–' : money(v)}</td>{/each}</tr>{/each}
      </tbody>
    </table>
  {:else if card.kind === 'calendar'}
    {@const spent = card.days.reduce((s, d) => s + d.value, 0)}
    <p class="big">{money(spent)}</p>
    <p class="sub">across {card.days.filter((d) => d.value !== 0).length} days</p>
  {:else if card.kind === 'multiseries'}
    <ul class="rows compact">
      {#each card.series as s}
        {@const last = [...s.values].reverse().find((v) => v !== null)}
        <li><span class="label">{s.name}</span><span class="val">{last === undefined ? '–' : money(last)}</span></li>
      {/each}
    </ul>
    <p class="sub">Latest value per series. The full chart is on Actual's Reports page.</p>
  {:else}
    <p class="sub">The phone shows this card as a chart; on the web, see it on Actual's Reports page.</p>
  {/if}
</section>

<style>
  .card { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
  h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .sub { margin: 0; font-size: 12px; opacity: 0.7; }
  .big { margin: 0; font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .text { margin: 0; white-space: pre-wrap; }
  .months { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .arrow { border: 0; background: color-mix(in srgb, currentColor 10%, transparent); color: inherit; width: 28px; height: 28px; border-radius: 50%; font-size: 18px; cursor: pointer; }
  .arrow:disabled { opacity: 0.3; cursor: default; }
  .donut { width: 160px; height: 160px; align-self: center; }
  .series { width: 100%; height: 80px; }
  .err { color: #dc2626; margin: 0; font-size: 12px; }
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .rows li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
  .rows .label { flex: 1; min-width: 0; }
  .rows .share { opacity: 0.6; font-size: 12px; }
  .rows .val { font-variant-numeric: tabular-nums; }
  .chip { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .bar { flex-basis: 100%; height: 6px; border-radius: 3px; background: color-mix(in srgb, currentColor 12%, transparent); overflow: hidden; display: block; }
  .bar i { display: block; height: 100%; }
  table { width: 100%; font-size: 12px; border-collapse: collapse; }
  th, td { text-align: right; padding: 2px 4px; }
  th:first-child { text-align: left; }
  small { opacity: 0.6; }
</style>
