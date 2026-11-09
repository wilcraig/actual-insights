<script>
  import { untrack } from 'svelte';
  import {
    initialState,
    drillInto,
    zoomOut,
    currentMonth,
    buildBreakdownParams,
    stepMonth,
    earliestAllowedMonth,
    canStepBack,
    canStepForward,
    monthLabel,
    shiftMonth,
  } from './breakdown-nav';
  import { fetchApi } from '../api-client';
  import CategoryBreakdownDonut from './CategoryBreakdownDonut.svelte';

  // An empty array (the default) means "every expense group," the same
  // convention as account-balances's accountIds and pacing-bars'
  // categoryIds -- a non-empty list curates the donut down to just those
  // groups (see breakdown-nav.js's "standalone donut widget" entry point).
  // `date` (YYYY-MM-DD) scopes every level to that one day instead of the
  // current month. A user-made "Transfers" group is always left out: it
  // holds moves between accounts, not spending (same rule as the treemap,
  // calendar, and Sankey).
  // `monthNav` (default on) shows previous/next month arrows above the donut;
  // it is ignored (no arrows) when `date` is set.
  let { groupIds = [], date = null, showLegend = false, monthNav = true } = $props();
  const showMonthNav = untrack(() => monthNav && !date);
  const TRANSFER_GROUP = /^transfers?$/i;

  // groupIds is only ever read at mount (not reactive to later prop
  // changes, matching CategoryBreakdownModal.svelte's same pattern), hence
  // untrack().
  let nav = $state(untrack(() => initialState({ groupIds })));
  // The month being shown; the arrows change this while `nav` (the drill
  // state) stays put, so drilling granularity is kept across months.
  let month = $state(currentMonth());
  let earliestMonth = $state(null);
  let breakdown = $state(null);
  let errorMessage = $state(null);

  // Request-sequence guard, same pattern as CategoryBreakdownModal.svelte:
  // load() re-fires on every navigation, and the user can trigger a new
  // navigation before a slower in-flight request resolves.
  let loadSeq = 0;

  async function load(currentNav, shownMonth) {
    const seq = ++loadSeq;
    errorMessage = null;
    breakdown = null;

    try {
      const params = buildBreakdownParams(currentNav, shownMonth, date);
      const response = await fetchApi(`/api/spending-breakdown?${params}`);

      if (seq !== loadSeq) return; // a newer navigation has since started; discard this response

      if (!response.ok) {
        errorMessage = `Spending breakdown unavailable (${response.status})`;
        return;
      }

      const data = await response.json();
      if (seq !== loadSeq) return; // a newer navigation started while this response body was parsing
      if (typeof data.earliestMonth === 'string') earliestMonth = data.earliestMonth;
      if (currentNav.level === 'groups') {
        const slices = data.slices.filter((s) => !TRANSFER_GROUP.test(s.label.trim()));
        breakdown = { ...data, slices, total: slices.reduce((sum, s) => sum + s.amountCents, 0) };
      } else {
        breakdown = data;
      }
    } catch (err) {
      if (seq !== loadSeq) return;
      errorMessage = 'Spending breakdown unavailable: could not reach insights-api.';
    }
  }

  // Re-fetch on mount and on every navigation-state transition.
  $effect(() => {
    load(nav, month);
  });

  const current = currentMonth();
  const earliest = $derived(earliestAllowedMonth(earliestMonth, current));
  const backDisabled = $derived(!canStepBack(month, earliest));
  const forwardDisabled = $derived(!canStepForward(month, current));

  function handleMonthStep(delta) {
    month = stepMonth(month, delta, earliest, current);
  }

  function handleSliceClick(sliceId) {
    const slice = breakdown?.slices.find((s) => s.id === sliceId);
    if (!slice) return;
    nav = drillInto(nav, slice);
  }

  function handleBreadcrumbClick(level) {
    while (nav.level !== level && nav.level !== 'groups') {
      nav = zoomOut(nav);
    }
  }

  function handleBack() {
    nav = zoomOut(nav);
  }
</script>

<div class="actualmint-spending-breakdown-donut">
  {#if showMonthNav}
    <div class="breakdown-month-nav">
      <button
        type="button"
        class="month-arrow month-prev"
        aria-label={`Previous month, ${monthLabel(shiftMonth(month, -1))}`}
        disabled={backDisabled}
        onclick={() => handleMonthStep(-1)}
      >
        ‹
      </button>
      <span class="month-label" aria-live="polite">{monthLabel(month)}</span>
      <button
        type="button"
        class="month-arrow month-next"
        aria-label={`Next month, ${monthLabel(shiftMonth(month, 1))}`}
        disabled={forwardDisabled}
        onclick={() => handleMonthStep(1)}
      >
        ›
      </button>
    </div>
  {/if}

  <nav class="breakdown-breadcrumb" aria-label="Breakdown level">
    <button
      type="button"
      class="breadcrumb-item"
      class:breadcrumb-current={nav.level === 'groups'}
      onclick={() => handleBreadcrumbClick('groups')}
    >
      Groups
    </button>
    {#if nav.groupName}
      <span class="breadcrumb-sep">/</span>
      <button
        type="button"
        class="breadcrumb-item"
        class:breadcrumb-current={nav.level === 'categories'}
        onclick={() => handleBreadcrumbClick('categories')}
      >
        {nav.groupName}
      </button>
    {/if}
    {#if nav.categoryName}
      <span class="breadcrumb-sep">/</span>
      <button
        type="button"
        class="breadcrumb-item"
        class:breadcrumb-current={nav.level === 'payees'}
        onclick={() => handleBreadcrumbClick('payees')}
      >
        {nav.categoryName}
      </button>
    {/if}
    {#if nav.payeeName}
      <span class="breadcrumb-sep">/</span>
      <button type="button" class="breadcrumb-item breadcrumb-current" onclick={() => handleBreadcrumbClick('transactions')}>
        {nav.payeeName}
      </button>
    {/if}
  </nav>

  {#if nav.level !== 'groups'}
    <button type="button" class="breakdown-back" onclick={handleBack}>← Back</button>
  {/if}

  {#if errorMessage}
    <p class="breakdown-error" role="alert">{errorMessage}</p>
  {:else if breakdown === null}
    <p class="breakdown-loading">Loading spending breakdown…</p>
  {:else if nav.level === 'transactions'}
    {#if breakdown.transactions.length === 0}
      <p class="breakdown-empty">No transactions.</p>
    {:else}
      <ul class="breakdown-transactions">
        {#each breakdown.transactions as txn (txn.id)}
          <li class="breakdown-transaction">
            <span class="transaction-date">{txn.date}</span>
            <span class="transaction-notes">{txn.notes || txn.importedPayee || ''}</span>
            <span class="transaction-amount">${(txn.amountCents / 100).toFixed(2)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else if showMonthNav && breakdown.slices.length === 0}
    <p class="breakdown-empty">No spending in {monthLabel(month)}</p>
  {:else}
    <CategoryBreakdownDonut slices={breakdown.slices} total={breakdown.total} onSliceClick={handleSliceClick} {showLegend} />
  {/if}
</div>

<style>
  .actualmint-spending-breakdown-donut {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
    container-type: inline-size;
  }

  .breakdown-month-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }

  .month-label {
    font-weight: 600;
    min-width: 8rem;
    text-align: center;
  }

  .month-arrow {
    background: none;
    border: 1px solid #ccc;
    border-radius: 0.375rem;
    width: 2rem;
    height: 2rem;
    font: inherit;
    font-size: 1.25rem;
    line-height: 1;
    color: inherit;
    cursor: pointer;
  }

  .month-arrow:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .month-arrow:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }

  .breakdown-breadcrumb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.85rem;
  }

  .breadcrumb-item {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: #2563eb;
    cursor: pointer;
    text-decoration: underline;
  }

  .breadcrumb-current {
    color: inherit;
    font-weight: 600;
    text-decoration: none;
    cursor: default;
  }

  .breadcrumb-sep {
    color: #888;
  }

  .breakdown-error {
    color: #b91c1c;
    font-weight: 600;
  }

  .breakdown-loading,
  .breakdown-empty {
    color: #666;
  }

  .breakdown-back {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.85rem;
    color: #2563eb;
    cursor: pointer;
    align-self: flex-start;
  }

  .breakdown-transactions {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .breakdown-transaction {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
    border-bottom: 1px solid #eee;
    padding-bottom: 0.5rem;
  }

  .transaction-date {
    flex: 0 0 auto;
    color: #888;
  }

  .transaction-notes {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .transaction-amount {
    flex: 0 0 auto;
    font-weight: 600;
  }
</style>
