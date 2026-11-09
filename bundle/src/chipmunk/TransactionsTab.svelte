<script>
  import { onMount } from 'svelte';
  import { getTransactions, suggest, getAccounts, getBudget, patchTransactions } from './chipmunk-api';
  import ContextMenu from './ContextMenu.svelte';
  import { takeTxHandoff } from './shell/handoff';
  import { emptyFilter, toQuery, chips, removeChip, applySuggestion, suggestionRows, loadColumns, saveColumns, clampColumn, DEFAULT_COLUMNS, colorFor, formatMoney, balanceTone } from './logic';

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
  let showHidden = $state(false);
  let ticket = 0;
  let suggestTimer = null;
  let suggestTicket = 0;

  async function load() {
    const mine = ++ticket;
    status = 'loading';
    try {
      const r = await getTransactions(toQuery(filter, { account: account || undefined, limit: 50, showHidden: showHidden || undefined }));
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
      const r = await getTransactions(toQuery(filter, { account: account || undefined, limit: 50, cursor: nextCursor, showHidden: showHidden || undefined }));
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

  // ---- Bulk actions (category, cleared, hide, exclude) ----
  // Always confirmed in plain words first; sent in batches of at most 50
  // (the server's limit), each batch one write pass and one sync.
  const BATCH = 50;
  let categories = $state([]);
  let picking = $state(false);
  let pickCategory = $state('');
  let pending = $state(null); // { summary, warning, changes, ids }
  let writing = $state(false);
  let resultText = $state('');
  let writeError = $state('');
  let menu = $state(null); // { x, y }

  const selectedIds = () => sorted.filter((r) => selected.has(r.id)).map((r) => r.id);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function ask(summary, changes, warning = '') {
    const ids = selectedIds();
    if (ids.length === 0) return;
    resultText = '';
    writeError = '';
    picking = false;
    pending = { summary: summary.replace('{n}', plural(ids.length, 'transaction')), warning, changes, ids };
  }

  async function startPick() {
    if (selectedIds().length === 0) return;
    picking = true;
    pending = null;
    if (categories.length === 0) {
      try {
        const now = new Date();
        const b = await getBudget(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
        categories = (b.groups ?? []).flatMap((g) => (g.categories ?? []).map((c) => ({ id: c.id, name: c.name, group: g.name })));
      } catch {
        categories = [];
      }
    }
  }

  function confirmPick() {
    const c = categories.find((x) => x.id === pickCategory);
    if (!c) return;
    ask(`Set the category of {n} to ${c.group} > ${c.name}?`, { category: c.id }, 'This changes the transactions in Actual.');
  }

  async function applyPending() {
    const job = pending;
    if (!job) return;
    writing = true;
    writeError = '';
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    try {
      for (let i = 0; i < job.ids.length; i += BATCH) {
        const r = await patchTransactions(job.ids.slice(i, i + BATCH), job.changes);
        updated += r.updated?.length ?? 0;
        unchanged += r.unchanged?.length ?? 0;
        skipped += r.skipped?.length ?? 0;
      }
      pending = null;
      resultText = `${plural(updated, 'transaction')} updated${unchanged ? `, ${unchanged} already as asked` : ''}${skipped ? `, ${skipped} skipped (not allowed on transfers, split parents, reconciled rows or closed accounts)` : ''}.`;
      await load();
    } catch (err) {
      writeError = err.message || 'Could not save.';
      pending = null;
      if (updated) await load();
    } finally {
      writing = false;
    }
  }

  function openMenu(event, tx) {
    event.preventDefault();
    activeId = tx.id;
    if (!selected.has(tx.id)) {
      selected = new Set([tx.id]);
      anchorId = tx.id;
    }
    menu = { x: event.clientX, y: event.clientY, payee: tx.payee };
  }

  const HIDE_WARNING = 'They stop appearing here and in Insights. There is no undo in this view; "Show hidden" in the filter brings them back.';
  const menuItems = $derived.by(() => {
    const n = selected.size;
    const who = n === 1 ? 'transaction' : `${n} transactions`;
    return [
      { label: `Categorize ${who}\u2026`, run: startPick },
      { label: 'Mark cleared', run: () => ask('Mark {n} as cleared?', { cleared: true }, 'This changes the transactions in Actual.') },
      { label: 'Mark uncleared', run: () => ask('Mark {n} as uncleared?', { cleared: false }, 'This changes the transactions in Actual.') },
      { separator: true },
      { label: 'Hide', danger: true, run: () => ask('Hide {n}?', { hidden: true }, HIDE_WARNING) },
      { label: 'Exclude from Insights', run: () => ask('Exclude {n} from Insights?', { excluded: true }, 'They stay in the list but stop counting in Insights.') },
      { label: 'Include in Insights', run: () => ask('Include {n} in Insights again?', { excluded: false }) },
      { label: 'Show again (unhide)', run: () => ask('Show {n} again?', { hidden: false }) },
      { separator: true },
      { label: 'Search for this payee', disabled: n !== 1 || !menu?.payee, run: () => change({ ...filter, text: menu?.payee ?? '' }) },
      { label: 'Copy payee', disabled: n !== 1 || !menu?.payee, run: () => navigator.clipboard?.writeText(menu?.payee ?? '') },
    ];
  });

  // ---- Resizable columns, remembered per browser ----
  let cols = $state({ ...DEFAULT_COLUMNS });
  const store = () => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  function startResize(event, id) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startW = cols[id];
    const move = (e) => {
      cols = { ...cols, [id]: clampColumn(id, startW + (e.clientX - startX)) };
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const s = store();
      if (s) saveColumns(s, cols);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function keyResize(event, id) {
    const step = event.shiftKey ? 40 : 10;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    cols = { ...cols, [id]: clampColumn(id, cols[id] + (event.key === 'ArrowRight' ? step : -step)) };
    const s = store();
    if (s) saveColumns(s, cols);
  }
  function resetColumn(id) {
    cols = { ...cols, [id]: DEFAULT_COLUMNS[id] };
    const s = store();
    if (s) saveColumns(s, cols);
  }

  onMount(async () => {
    const s0 = store();
    if (s0) cols = loadColumns(s0);
    const handoff = takeTxHandoff();
    if (handoff?.filter) {
      filter = handoff.filter;
      field = filter.text ?? '';
    }
    if (handoff?.account) account = handoff.account;
    load();
    try {
      accounts = (await getAccounts()).accounts ?? [];
    } catch {
      accounts = [];
    }
  });

  const chipList = $derived(chips(filter));

  // Desktop table: client-side sort of the loaded rows, multi-select (click,
  // Shift-click range, Space), a detail pane for the active row, j/k or arrows.
  let sortKey = $state('date');
  let sortDir = $state('desc');
  let selected = $state(new Set());
  let activeId = $state(null);
  let anchorId = null;

  const catName = (tx) => (tx.split ? 'Split' : tx.transfer ? 'Transfer' : tx.category ? tx.category.name : 'Uncategorized');
  const sorters = {
    date: (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0),
    payee: (a, b) => (a.payee ?? '').localeCompare(b.payee ?? ''),
    category: (a, b) => catName(a).localeCompare(catName(b)),
    amount: (a, b) => a.amount - b.amount,
  };
  const sorted = $derived.by(() => {
    const out = [...rows].sort(sorters[sortKey]);
    return sortDir === 'desc' ? out.reverse() : out;
  });
  const active = $derived(rows.find((r) => r.id === activeId) ?? null);
  const selectedTotal = $derived(rows.filter((r) => selected.has(r.id)).reduce((n, r) => n + r.amount, 0));

  function sortBy(key) {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else {
      sortKey = key;
      sortDir = key === 'date' || key === 'amount' ? 'desc' : 'asc';
    }
  }

  function pickRow(event, tx) {
    activeId = tx.id;
    const next = new Set(selected);
    if (event.shiftKey && anchorId) {
      const ids = sorted.map((r) => r.id);
      const [a, b] = [ids.indexOf(anchorId), ids.indexOf(tx.id)].sort((x, y) => x - y);
      for (const id of ids.slice(a, b + 1)) next.add(id);
    } else if (event.metaKey || event.ctrlKey || event.target.type === 'checkbox') {
      if (next.has(tx.id)) next.delete(tx.id);
      else next.add(tx.id);
      anchorId = tx.id;
    } else {
      next.clear();
      next.add(tx.id);
      anchorId = tx.id;
    }
    selected = next;
  }

  function onTableKey(event) {
    if (event.target.matches('input[type=search], select, textarea') || event.metaKey || event.ctrlKey || event.altKey) return;
    const ids = sorted.map((r) => r.id);
    const i = ids.indexOf(activeId);
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      activeId = ids[Math.min(ids.length - 1, i + 1)] ?? ids[0];
      if (!event.shiftKey) selected = new Set([activeId]);
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      activeId = ids[Math.max(0, i - 1)] ?? ids[0];
      if (!event.shiftKey) selected = new Set([activeId]);
    } else if (event.key === ' ' && activeId) {
      event.preventDefault();
      const next = new Set(selected);
      if (next.has(activeId)) next.delete(activeId);
      else next.add(activeId);
      selected = next;
    } else if (event.key === 'Escape') {
      selected = new Set();
      activeId = null;
    } else if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && activeId) {
      event.preventDefault();
      const r = document.querySelector(`[data-tx-id="${activeId}"]`)?.getBoundingClientRect();
      const tx = rows.find((x) => x.id === activeId);
      menu = { x: (r?.left ?? 100) + 40, y: (r?.bottom ?? 100), payee: tx?.payee };
      return;
    } else return;
    queueMicrotask(() => document.querySelector(`[data-tx-id="${activeId}"]`)?.scrollIntoView?.({ block: 'nearest' }));
  }
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
      <label class="check"><input type="checkbox" checked={showHidden} onchange={(e) => { showHidden = e.target.checked; load(); }} /> Show hidden</label>
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
    {#if selected.size > 0}
      <div class="selbar" role="toolbar" aria-label="Actions for the selection">
        <span role="status">{selected.size} selected{#if selected.size > 1} &middot; <span class={balanceTone(selectedTotal)}>{formatMoney(selectedTotal)}</span>{/if}</span>
        <button type="button" class="more" disabled={writing} onclick={startPick}>Categorize&hellip;</button>
        <button type="button" class="more" disabled={writing} onclick={() => ask('Mark {n} as cleared?', { cleared: true }, 'This changes the transactions in Actual.')}>Mark cleared</button>
        <button type="button" class="more" disabled={writing} onclick={() => ask('Hide {n}?', { hidden: true }, HIDE_WARNING)}>Hide</button>
        <button type="button" class="more" disabled={writing} onclick={() => ask('Exclude {n} from Insights?', { excluded: true }, 'They stay in the list but stop counting in Insights.')}>Exclude</button>
        <button type="button" class="more" onclick={() => (selected = new Set())}>Clear</button>
      </div>
    {/if}
    {#if picking}
      <div class="panel pickbar">
        <label class="check">Category
          <select aria-label="Category for the selection" bind:value={pickCategory}>
            <option value="">Choose&hellip;</option>
            {#each categories as c (c.id)}<option value={c.id}>{c.group} &gt; {c.name}</option>{/each}
          </select>
        </label>
        <button type="button" class="more" disabled={!pickCategory} onclick={confirmPick}>Continue</button>
        <button type="button" class="more" onclick={() => (picking = false)}>Cancel</button>
      </div>
    {/if}
    {#if pending}
      <div class="panel confirm" role="alertdialog" aria-label="Confirm">
        <strong>{pending.summary}</strong>
        {#if pending.warning}<span class="muted">{pending.warning}</span>{/if}
        <span class="confirm-actions">
          <button type="button" class="more apply" disabled={writing} onclick={applyPending}>{writing ? 'Working\u2026' : 'Apply'}</button>
          <button type="button" class="more" disabled={writing} onclick={() => (pending = null)}>Cancel</button>
        </span>
      </div>
    {/if}
    {#if resultText}<p class="result" role="status">{resultText}</p>{/if}
    {#if writeError}<p class="err" role="alert">{writeError}</p>{/if}
    <div class="split" class:with-detail={!!active}>
      <div class="table-wrap">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <table class="grid" aria-label="Transactions" onkeydown={onTableKey}>
          <colgroup><col class="k-sel" /><col style="width:{cols.date}px" /><col /><col style="width:{cols.category}px" /><col style="width:{cols.amount}px" /></colgroup>
          <thead>
            <tr>
              <th class="c-sel"></th>
              {#each [['date', 'Date'], ['payee', 'Payee'], ['category', 'Category'], ['amount', 'Amount']] as [key, label] (key)}
                <th class="c-{key}" aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" class="th" onclick={() => sortBy(key)}>{label}{#if sortKey === key}<span aria-hidden="true"> {sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>{/if}</button>
                  {#if key !== 'payee'}<span class="rz" role="separator" aria-orientation="vertical" aria-label="Resize {label} column" tabindex="0" onpointerdown={(e) => startResize(e, key)} onkeydown={(e) => keyResize(e, key)} ondblclick={() => resetColumn(key)}></span>{/if}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each sorted as tx (tx.id)}
              <tr class="tx" class:sel={selected.has(tx.id)} class:cur={activeId === tx.id} data-tx-id={tx.id} tabindex="0" onclick={(e) => pickRow(e, tx)} oncontextmenu={(e) => openMenu(e, tx)} onfocus={() => { if (!activeId) activeId = tx.id; }}>
                <td class="c-sel"><input type="checkbox" aria-label="Select {tx.payee ?? 'transaction'}" checked={selected.has(tx.id)} /></td>
                <td class="c-date">{tx.date}</td>
                <td class="c-payee payee">{tx.payee ?? 'No payee'}</td>
                <td class="c-category"><span class="dot" style="background:{colorFor(tx.color, 11)}"></span>{#if tx.split}Split{:else if tx.transfer}Transfer{:else if tx.category}{tx.categoryGroup ? `${tx.categoryGroup} > ` : ''}{tx.category.name}{:else}Uncategorized{/if}</td>
                <td class="c-amount amt {balanceTone(tx.amount)}">{formatMoney(tx.amount)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if active}
        <aside class="detail" aria-label="Transaction detail">
          <button type="button" class="more close" aria-label="Close detail" onclick={() => (activeId = null)}>&times;</button>
          <h3>{active.payee ?? 'No payee'}</h3>
          <p class="big amt {balanceTone(active.amount)}">{formatMoney(active.amount)}</p>
          <dl>
            <dt>Date</dt><dd>{active.date}</dd>
            <dt>Category</dt><dd>{catName(active)}{#if active.categoryGroup && active.category}<small>{active.categoryGroup}</small>{/if}</dd>
            {#if active.account?.name ?? active.accountName}<dt>Account</dt><dd>{active.account?.name ?? active.accountName}</dd>{/if}
            {#if active.notes}<dt>Notes</dt><dd>{active.notes}</dd>{/if}
          </dl>
        </aside>
      {/if}
    </div>
    {#if nextCursor}<button type="button" class="more" disabled={loadingMore} onclick={more}>{loadingMore ? 'Loading…' : 'Load more'}</button>{/if}
  {/if}
  {#if menu}<ContextMenu x={menu.x} y={menu.y} items={menuItems} label="Transaction actions" onClose={() => (menu = null)} />{/if}
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
  .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
  @media (min-width: 1000px) { .split.with-detail { grid-template-columns: minmax(0, 1fr) 320px; } .detail { position: sticky; top: 8px; } }
  .table-wrap { overflow-x: auto; }
  .grid { width: 100%; border-collapse: collapse; font-size: 14px; }
  .grid th { text-align: left; font-weight: 600; font-size: 12px; position: sticky; top: 0; background: var(--cm-bg, Canvas); border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); padding: 0; }
  .th { border: 0; background: transparent; color: inherit; font: inherit; padding: 8px 10px; cursor: pointer; width: 100%; text-align: inherit; opacity: 0.75; }
  .th:hover { opacity: 1; }
  .grid td { overflow: hidden; text-overflow: ellipsis; padding: 7px 10px; border-bottom: 1px solid color-mix(in srgb, currentColor 8%, transparent); white-space: nowrap; }
  .grid .c-payee { white-space: normal; font-weight: 500; }
  .grid .c-amount, .grid th.c-amount .th { text-align: right; font-variant-numeric: tabular-nums; }
  .grid .c-sel { width: 28px; padding-right: 0; }
  .tx { cursor: default; }
  .tx:hover { background: color-mix(in srgb, currentColor 5%, transparent); }
  .tx.sel { background: color-mix(in srgb, var(--palette-chartQual1, #2563eb) 14%, transparent); }
  .tx.cur { outline: 2px solid var(--palette-chartQual1, #2563eb); outline-offset: -2px; }
  .tx:focus-visible { outline: 2px solid var(--palette-chartQual1, #2563eb); outline-offset: -2px; }
  .rz { position: absolute; top: 0; right: 0; bottom: 0; width: 7px; cursor: col-resize; touch-action: none; }
  .rz:hover, .rz:focus-visible { background: color-mix(in srgb, var(--palette-chartQual1, #2563eb) 50%, transparent); outline: none; }
  .grid { table-layout: fixed; }
  .k-sel { width: 30px; }
  .pickbar, .confirm { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 10px; }
  .confirm { flex-direction: column; align-items: flex-start; }
  .confirm-actions { display: flex; gap: 8px; }
  .apply { background: var(--palette-chartQual1, #2563eb); color: #fff; }
  .result { margin: 0; font-size: 13px; }
  @media (max-width: 759px) { .grid { table-layout: auto; } .grid td { overflow: visible; text-overflow: clip; white-space: normal; } .grid td.c-amount { white-space: nowrap; } .grid col { width: auto !important; } .rz { display: none; } }
  .selbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 6px 10px; border-radius: 8px; background: color-mix(in srgb, var(--palette-chartQual1, #2563eb) 14%, transparent); }
  .detail { border: 1px solid color-mix(in srgb, currentColor 15%, transparent); border-radius: 12px; padding: 14px 16px; position: relative; }
  .detail h3 { margin: 0 24px 4px 0; }
  .detail .big { font-size: 24px; font-weight: 700; margin: 0 0 8px; }
  .detail dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; }
  .detail dt { opacity: 0.6; }
  .detail dd { margin: 0; }
  .close { position: absolute; top: 8px; right: 8px; padding: 0 9px; }
  @media (max-width: 759px) { .grid .c-sel { display: none; } .grid .c-date { display: none; } .grid td, .grid th .th { padding: 8px 6px; } }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
  .positive { color: #16a34a; }
  .negative { color: inherit; }
  .muted { opacity: 0.7; }
  .err { color: #dc2626; }
  small { opacity: 0.6; margin-left: 6px; }
</style>
