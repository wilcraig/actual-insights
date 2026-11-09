<script>
  import { onMount } from 'svelte';
  import { getBudget, getSeriesList } from './chipmunk-api';
  import { colorFor, formatMoney, shiftMonth, seriesSummary, balanceTone } from './logic';
  import SeriesForm from './SeriesForm.svelte';

  // The phone's Budget screen: month arrows, groups collapsed at first with
  // their totals, categories inside, a repeat marker on categories that have a
  // series, and the series editor (see SeriesForm).
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let month = $state(currentMonth);
  let budget = $state(null);
  let seriesByCategory = $state({});
  let status = $state('loading');
  let errorText = $state('');
  let open = $state(new Set());
  let editing = $state(null); // category id
  let ticket = 0;

  async function load() {
    const mine = ++ticket;
    status = 'loading';
    try {
      const [b, s] = await Promise.all([getBudget(month), getSeriesList().catch(() => ({ series: [] }))]);
      if (mine !== ticket) return;
      budget = b;
      seriesByCategory = Object.fromEntries((s.series ?? []).map((x) => [x.categoryId, x]));
      status = 'ready';
    } catch (err) {
      if (mine !== ticket) return;
      errorText = err.message;
      status = 'error';
    }
  }

  function go(delta) {
    month = shiftMonth(month, delta);
    editing = null;
    load();
  }

  function toggle(id) {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    open = next;
  }

  const monthTitle = $derived(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' }));

  onMount(load);
</script>

<div class="budget-tab">
  <div class="months">
    <button type="button" class="arrow prev" aria-label="Previous month" onclick={() => go(-1)}>&lsaquo;</button>
    <strong class="month-label">{monthTitle}</strong>
    <button type="button" class="arrow next" aria-label="Next month" onclick={() => go(1)}>&rsaquo;</button>
  </div>

  {#if status === 'loading'}
    <p class="muted">Loading&hellip;</p>
  {:else if status === 'error'}
    <p class="err" role="alert">{errorText}</p>
  {:else}
    <p class="totals">To budget <strong>{formatMoney(budget.totals.toBudget)}</strong> &middot; Budgeted {formatMoney(budget.totals.budgeted)} &middot; Spent {formatMoney(budget.totals.spent)}</p>
    {#each budget.groups as group, gi (group.id)}
      <section class="group" data-group-id={group.id}>
        <button type="button" class="head" aria-expanded={open.has(group.id) ? 'true' : 'false'} onclick={() => toggle(group.id)}>
          <span class="bar" style="background:{colorFor(group.color, gi)}"></span>
          <span class="name">{group.name}</span>
          <span class="n">{formatMoney(group.budgeted)}</span><span class="n">{formatMoney(group.spent)}</span><span class="n {balanceTone(group.balance)}">{formatMoney(group.balance)}</span>
        </button>
        {#if open.has(group.id)}
          {#each group.categories as cat (cat.id)}
            {@const series = seriesByCategory[cat.id]}
            <div class="cat" data-category-id={cat.id}>
              <span class="dot" style="background:{colorFor(cat.color, gi)}"></span>
              <span class="name">{cat.name}{#if series}<small class="repeat"> &#8635; {seriesSummary(series)}</small>{/if}</span>
              <span class="n">{formatMoney(cat.budgeted)}</span><span class="n">{formatMoney(cat.spent)}</span><span class="n {balanceTone(cat.balance)}">{formatMoney(cat.balance)}</span>
              <button type="button" class="repeat-btn" onclick={() => (editing = editing === cat.id ? null : cat.id)}>{series ? 'Series' : 'Repeat'}</button>
            </div>
            {#if editing === cat.id}
              <SeriesForm category={cat} {series} {month} {currentMonth} onCancel={() => (editing = null)} onDone={() => { editing = null; load(); }} />
            {/if}
          {/each}
        {/if}
      </section>
    {/each}
    {#if budget.groups.length === 0}<p class="muted">No categories for this month.</p>{/if}
  {/if}
</div>

<style>
  .budget-tab { display: flex; flex-direction: column; gap: 8px; }
  .months { display: flex; align-items: center; justify-content: center; gap: 12px; }
  .arrow { border: 0; background: color-mix(in srgb, currentColor 10%, transparent); color: inherit; width: 28px; height: 28px; border-radius: 50%; font-size: 18px; cursor: pointer; }
  .totals { margin: 0; font-size: 13px; text-align: center; }
  .group { border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
  .head, .cat { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 4px; font: inherit; color: inherit; }
  .head { background: transparent; border: 0; cursor: pointer; text-align: left; font-weight: 600; }
  .cat { padding-left: 20px; font-size: 13px; }
  .bar { width: 4px; align-self: stretch; border-radius: 2px; }
  .dot { width: 8px; height: 8px; border-radius: 2px; }
  .name { flex: 1; min-width: 0; }
  .n { width: 78px; text-align: right; font-variant-numeric: tabular-nums; }
  .positive { color: #16a34a; } .negative { color: #dc2626; }
  .repeat-btn { border: 0; background: color-mix(in srgb, currentColor 10%, transparent); color: inherit; border-radius: 999px; padding: 2px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  small { opacity: 0.65; }
  .muted { opacity: 0.7; } .err { color: #dc2626; }
</style>
