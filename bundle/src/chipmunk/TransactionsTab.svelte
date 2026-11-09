<script>
  import { onMount } from 'svelte';
  import { getTransactions, suggest, getAccounts } from './chipmunk-api';
  import { emptyFilter, toQuery, chips, removeChip, applySuggestion, suggestionRows, colorFor, formatMoney, balanceTone } from './logic';

  // The phone's Transactions: one search field with a filter button, typeahead
  // (merchants and categories, each with "add to filter"), chips, paged list.
  let filter = $state(emptyFilter());
  let field = $state('');
  let rows = $state([]);
  let nextCursor = $state(null);
  let uncategorizedCount = $state(0);
  let status = $state('loading');
  let errorText = $state('');
  let loadingMore = $state(false);
  let suggestions = $state([]);
  let suggestOpen = $state(false);
  let suggestFailed = $state(false);
  let panelOpen = $state(false);
  let panelOptions = $state([]);
  let accounts = $state([]);
  let account = $state('');
  let ticket = 0;
  let suggestTimer = null;
  let suggestTicket = 0;

  async function load() {
    const mine = ++ticket;
    status = 'loading';
    try {
      const r = await getTransactions(toQuery(filter, { account: account || undefined, limit: 50 }));
      if (mine !== ticket) return;
      rows = r.transactions ?? [];
      nextCursor = r.nextCursor ?? null;
      uncategorizedCount = r.uncategorizedCount ?? uncategorizedCount;
      status = 'ready';
    } catch (err) {
      if (mine !== ticket) return;
      errorText = err.message;
      status = 'error';
    }
  }

  async function more() {
    if (!nextCursor || loadingMore) return;
    const mine = ticket;
    loadingMore = true;
    try {
      const r = await getTransactions(toQuery(filter, { account: account || undefined, limit: 50, cursor: nextCursor }));
      if (mine !== ticket) return;
      rows = [...rows, ...(r.transactions ?? [])];
      nextCursor = r.nextCursor ?? null;
    } catch (err) {
      errorText = err.message;
    } finally {
      loadingMore = false;
    }
  }

  function change(next) {
    filter = next;
    field = next.text;
    suggestOpen = false;
    load();
  }

  function onInput() {
    clearTimeout(suggestTimer);
    const q = field.trim();
    if (!q) {
      suggestOpen = false;
      suggestions = [];
      if (filter.text) change({ ...filter, text: '' });
      return;
    }
    suggestOpen = true;
    suggestTimer = setTimeout(async () => {
      const mine = ++suggestTicket;
      try {
        const r = await suggest(q, 8);
        if (mine !== suggestTicket) return;
        suggestions = suggestionRows(r);
        suggestFailed = false;
      } catch {
        if (mine !== suggestTicket) return;
        suggestions = [];
        suggestFailed = true;
      }
    }, 250);
  }

  function submit(event) {
    event?.preventDefault();
    clearTimeout(suggestTimer);
    suggestTicket++;
    change({ ...filter, text: field.trim() });
  }

  const choose = (row) => change(applySuggestion(filter, row));
  const add = (row) => {
    filter = applySuggestion(filter, row, { add: true });
    field = '';
    load();
  };

  async function togglePanel() {
    panelOpen = !panelOpen;
    if (panelOpen && panelOptions.length === 0) {
      try {
        panelOptions = suggestionRows(await suggest('', 25));
      } catch {
        panelOptions = [];
      }
    }
  }

  onMount(async () => {
    load();
    try {
      accounts = (await getAccounts()).accounts ?? [];
    } catch {
      accounts = [];
    }
  });

  const chipList = $derived(chips(filter));
</script>

<div class="tx-tab">
  <form class="bar" onsubmit={submit} role="search">
    <input class="search" type="search" placeholder="Search payee, category or notes" aria-label="Search transactions" bind:value={field} oninput={onInput} autocomplete="off" />
    <button type="button" class="filter-btn" aria-label="Filter" aria-expanded={panelOpen ? 'true' : 'false'} onclick={togglePanel}>Filter</button>
  </form>

  {#if suggestOpen}
    <ul class="suggest" aria-label="Suggestions">
      {#if suggestFailed}<li class="muted">Suggestions are unavailable. Press Enter to search.</li>{/if}
      {#each suggestions as row (row.kind + row.id)}
        <li>
          <button type="button" class="pick" onclick={() => choose(row)}>{row.name}{#if row.groupName}<small> {row.groupName}</small>{/if}<small class="kind"> {row.kind}</small></button>
          <button type="button" class="add" aria-label="Add {row.name} to filter" onclick={() => add(row)}>+</button>
        </li>
      {/each}
      <li><button type="button" class="pick" onclick={submit}>Search for &ldquo;{field.trim()}&rdquo;</button></li>
    </ul>
  {/if}

  {#if panelOpen}
    <div class="panel">
      <label class="check"><input type="checkbox" checked={filter.uncategorized} onchange={(e) => change({ ...filter, uncategorized: e.target.checked, group: null, categories: e.target.checked ? [] : filter.categories })} /> Uncategorized ({uncategorizedCount})</label>
      {#if accounts.length}
        <label class="check">Account
          <select bind:value={account} onchange={load}><option value="">All accounts</option>{#each accounts as a (a.id)}<option value={a.id}>{a.name}</option>{/each}</select>
        </label>
      {/if}
      <div class="options">
        {#each panelOptions as row (row.kind + row.id)}
          <button type="button" class="option" onclick={() => add(row)}>{row.name} <small>{row.kind}</small></button>
        {/each}
      </div>
    </div>
  {/if}

  {#if chipList.length}
    <div class="chips">
      {#each chipList as chip (chip.kind + (chip.id ?? ''))}
        <button type="button" class="chip" aria-label="Remove {chip.label}" onclick={() => change(removeChip(filter, chip))}>{chip.label} &times;</button>
      {/each}
    </div>
  {/if}

  {#if status === 'loading'}
    <p class="muted">Loading&hellip;</p>
  {:else if status === 'error'}
    <p class="err" role="alert">{errorText}</p>
  {:else if rows.length === 0}
    <p class="muted">No transactions match.</p>
  {:else}
    <ul class="rows">
      {#each rows as tx (tx.id)}
        <li class="tx" data-tx-id={tx.id}>
          <div class="l1"><span class="payee">{tx.payee ?? 'No payee'}</span><span class="amt {balanceTone(tx.amount)}">{formatMoney(tx.amount)}</span></div>
          <div class="l2"><span class="dot" style="background:{colorFor(tx.color, 11)}"></span>{#if tx.split}Split{:else if tx.transfer}Transfer{:else if tx.category}{tx.categoryGroup ? `${tx.categoryGroup} > ` : ''}{tx.category.name}{:else}Uncategorized{/if}</div>
          <div class="l3">{tx.date}</div>
        </li>
      {/each}
    </ul>
    {#if nextCursor}<button type="button" class="more" disabled={loadingMore} onclick={more}>{loadingMore ? 'Loading…' : 'Load more'}</button>{/if}
  {/if}
</div>

<style>
  .tx-tab { display: flex; flex-direction: column; gap: 10px; }
  .bar { display: flex; gap: 8px; }
  .search { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); background: transparent; color: inherit; font: inherit; }
  .filter-btn, .more, .option, .add { border: 0; background: color-mix(in srgb, currentColor 10%, transparent); color: inherit; border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit; }
  .suggest { list-style: none; margin: 0; padding: 4px; border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 8px; }
  .suggest li { display: flex; gap: 6px; align-items: center; }
  .pick { flex: 1; text-align: left; background: transparent; border: 0; color: inherit; font: inherit; padding: 6px; cursor: pointer; }
  .panel { display: flex; flex-direction: column; gap: 8px; border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 8px; padding: 10px; }
  .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .check { display: flex; gap: 8px; align-items: center; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { border: 0; border-radius: 999px; padding: 4px 10px; cursor: pointer; background: color-mix(in srgb, var(--palette-chartQual1, #2563eb) 20%, transparent); color: inherit; font: inherit; font-size: 12px; }
  .rows { list-style: none; margin: 0; padding: 0; }
  .tx { padding: 8px 4px; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
  .l1 { display: flex; justify-content: space-between; font-weight: 600; }
  .l2 { font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .l3 { font-size: 11px; opacity: 0.6; }
  .dot { width: 8px; height: 8px; border-radius: 2px; }
  .positive { color: #16a34a; }
  .negative { color: inherit; }
  .muted { opacity: 0.7; }
  .err { color: #dc2626; }
  small { opacity: 0.6; margin-left: 6px; }
</style>
