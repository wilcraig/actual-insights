<script>
  import { onMount } from 'svelte';
  import { getBudget, getSeriesList, setBudgeted, moveBudget } from './chipmunk-api';
  import ContextMenu from './ContextMenu.svelte';
  import { colorFor, formatMoney, shiftMonth, seriesSummary, balanceTone, parseAmountToCents } from './logic';
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

  // ---- Inline editing of a category's budgeted amount ----
  // Click the amount; Enter or Tab saves (Tab goes on to the next category),
  // Esc cancels. "Repeat" hands the typed amount to the series editor.
  let amountEdit = $state(null); // { id, text }
  let amountBusy = $state(false);
  let amountError = $state('');
  let seriesAmount = $state(null); // cents typed when Repeat was chosen
  let menu = $state(null);
  let moveFor = $state(null); // { from, to, text }
  let moveBusy = $state(false);
  let moveError = $state('');

  const flat = $derived(budget ? budget.groups.filter((g) => open.has(g.id)).flatMap((g) => g.categories) : []);
  const allCats = $derived(budget ? budget.groups.flatMap((g) => g.categories.map((c) => ({ ...c, group: g.name }))) : []);

  function beginEdit(cat) {
    amountError = '';
    amountEdit = { id: cat.id, text: (cat.budgeted / 100).toFixed(2) };
  }

  async function refresh() {
    try {
      budget = await getBudget(month);
    } catch (err) {
      errorText = err.message;
    }
  }

  // Saves the open edit; resolves true when the edit may be closed.
  async function commitEdit(cat) {
    const cents = parseAmountToCents(amountEdit.text);
    if (cents === null || cents < 0) {
      amountError = 'Enter an amount like 450.00';
      return false;
    }
    if (cents === cat.budgeted) return true;
    amountBusy = true;
    amountError = '';
    try {
      await setBudgeted(month, cat.id, cents);
      await refresh();
      return true;
    } catch (err) {
      amountError = err.message || 'Could not save.';
      return false;
    } finally {
      amountBusy = false;
    }
  }

  async function onAmountKey(event, cat) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      amountEdit = null;
      amountError = '';
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (await commitEdit(cat)) amountEdit = null;
    } else if (event.key === 'Tab') {
      const at = flat.findIndex((c) => c.id === cat.id);
      const next = flat[at + (event.shiftKey ? -1 : 1)];
      if (!next) {
        // Edge of the list: just save and leave the field as Tab would.
        if (amountEdit && parseAmountToCents(amountEdit.text) !== cat.budgeted) {
          event.preventDefault();
          if (await commitEdit(cat)) amountEdit = null;
        } else amountEdit = null;
        return;
      }
      event.preventDefault();
      if (await commitEdit(cat)) {
        const fresh = flat.find((c) => c.id === next.id) ?? next;
        beginEdit(fresh);
      }
    }
  }

  function repeatFromEdit(cat) {
    const cents = parseAmountToCents(amountEdit?.text ?? '');
    seriesAmount = cents === null ? null : cents;
    amountEdit = null;
    editing = cat.id;
  }

  const focusSelect = (node) => {
    node.focus();
    node.select();
  };

  // ---- Move money ----
  function beginMove(cat) {
    moveError = '';
    moveFor = { from: cat.id, to: allCats.find((c) => c.id !== cat.id)?.id ?? '', text: '' };
  }
  async function doMove() {
    const cents = parseAmountToCents(moveFor.text);
    if (cents === null || cents < 1 || !moveFor.to) {
      moveError = 'Choose a category and an amount like 25.00';
      return;
    }
    moveBusy = true;
    moveError = '';
    try {
      await moveBudget(month, { from: moveFor.from, to: moveFor.to, amount: cents });
      moveFor = null;
      await refresh();
    } catch (err) {
      moveError = err.message || 'Could not move.';
    } finally {
      moveBusy = false;
    }
  }

  function openMenu(event, cat) {
    event.preventDefault();
    const series = seriesByCategory[cat.id];
    menu = {
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: 'Edit budgeted amount', run: () => beginEdit(cat) },
        { label: 'Move money from here\u2026', run: () => beginMove(cat) },
        { label: series ? 'Budget series\u2026' : 'Repeat\u2026', run: () => { seriesAmount = null; editing = cat.id; } },
        { separator: true },
        { label: 'Copy category name', run: () => navigator.clipboard?.writeText(cat.name) },
      ],
    };
  }

  function openGroupMenu(event, group) {
    event.preventDefault();
    const isOpen = open.has(group.id);
    menu = {
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: isOpen ? 'Collapse group' : 'Expand group', run: () => toggle(group.id) },
        { label: 'Expand all', run: () => (open = new Set(budget.groups.map((g) => g.id))) },
        { label: 'Collapse all', run: () => (open = new Set()) },
      ],
    };
  }

  function go(delta) {
    month = shiftMonth(month, delta);
    editing = null;
    amountEdit = null;
    moveFor = null;
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
        <button type="button" class="head" oncontextmenu={(e) => openGroupMenu(e, group)} aria-expanded={open.has(group.id) ? 'true' : 'false'} onclick={() => toggle(group.id)}>
          <span class="bar" style="background:{colorFor(group.color, gi)}"></span>
          <span class="name">{group.name}</span>
          <span class="n">{formatMoney(group.budgeted)}</span><span class="n">{formatMoney(group.spent)}</span><span class="n {balanceTone(group.balance)}">{formatMoney(group.balance)}</span>
        </button>
        {#if open.has(group.id)}
          {#each group.categories as cat (cat.id)}
            {@const series = seriesByCategory[cat.id]}
            <div class="cat" data-category-id={cat.id} oncontextmenu={(e) => openMenu(e, cat)}>
              <span class="dot" style="background:{colorFor(cat.color, gi)}"></span>
              <span class="name">{cat.name}{#if series}<small class="repeat"> &#8635; {seriesSummary(series)}</small>{/if}</span>
              {#if amountEdit?.id === cat.id}
                <span class="edit">
                  <input class="amt-input" type="text" inputmode="decimal" aria-label="Budgeted amount for {cat.name}" bind:value={amountEdit.text} disabled={amountBusy} onkeydown={(e) => onAmountKey(e, cat)} use:focusSelect />
                  <button type="button" class="repeat-btn" disabled={amountBusy} onmousedown={(e) => e.preventDefault()} onclick={() => repeatFromEdit(cat)}>Repeat&hellip;</button>
                </span>
              {:else}
                <button type="button" class="n amt-btn" aria-label="Edit budgeted amount for {cat.name}" onclick={() => beginEdit(cat)}>{formatMoney(cat.budgeted)}</button>
              {/if}
              <span class="n">{formatMoney(cat.spent)}</span><span class="n {balanceTone(cat.balance)}">{formatMoney(cat.balance)}</span>
              <button type="button" class="repeat-btn" onclick={() => { seriesAmount = null; editing = editing === cat.id ? null : cat.id; }}>{series ? 'Series' : 'Repeat'}</button>
            </div>
            {#if amountEdit?.id === cat.id && amountError}<p class="err inline" role="alert">{amountError}</p>{/if}
            {#if moveFor?.from === cat.id}
              <div class="move" role="group" aria-label="Move money from {cat.name}">
                <span>Move from {cat.name} (now {formatMoney(cat.budgeted)}) to</span>
                <select aria-label="Move to" bind:value={moveFor.to}>{#each allCats.filter((c) => c.id !== cat.id) as c (c.id)}<option value={c.id}>{c.group} &gt; {c.name}</option>{/each}</select>
                <input type="text" inputmode="decimal" placeholder="Amount" aria-label="Amount to move" bind:value={moveFor.text} />
                <button type="button" class="repeat-btn" disabled={moveBusy} onclick={doMove}>{moveBusy ? 'Moving\u2026' : 'Move'}</button>
                <button type="button" class="repeat-btn" onclick={() => (moveFor = null)}>Cancel</button>
                {#if moveError}<span class="err" role="alert">{moveError}</span>{/if}
              </div>
            {/if}
            {#if editing === cat.id}
              <SeriesForm category={seriesAmount === null ? cat : { ...cat, budgeted: seriesAmount }} {series} {month} {currentMonth} onCancel={() => { editing = null; seriesAmount = null; }} onDone={() => { editing = null; seriesAmount = null; load(); }} />
            {/if}
          {/each}
        {/if}
      </section>
    {/each}
    {#if budget.groups.length === 0}<p class="muted">No categories for this month.</p>{/if}
  {/if}
  {#if menu}<ContextMenu x={menu.x} y={menu.y} items={menu.items} label="Budget actions" onClose={() => (menu = null)} />{/if}
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
  .amt-btn { border: 0; background: transparent; color: inherit; font: inherit; cursor: text; border-radius: 4px; padding: 2px 4px; }
  .amt-btn:hover, .amt-btn:focus-visible { background: color-mix(in srgb, currentColor 10%, transparent); outline: none; }
  .edit { display: inline-flex; gap: 6px; align-items: center; }
  .amt-input { width: 90px; text-align: right; font: inherit; color: inherit; background: transparent; border: 1px solid var(--palette-chartQual1, #2563eb); border-radius: 6px; padding: 2px 6px; }
  .move { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 20px; font-size: 13px; }
  .move select, .move input { font: inherit; color: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 6px; padding: 3px 6px; }
  .inline { margin: 0 0 4px 20px; font-size: 12px; }
  .repeat-btn { border: 0; background: color-mix(in srgb, currentColor 10%, transparent); color: inherit; border-radius: 999px; padding: 2px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  small { opacity: 0.65; }
  .muted { opacity: 0.7; } .err { color: #dc2626; }
</style>
