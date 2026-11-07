<script>
  import { fetchApi } from '../api-client';

  // The selected accounts' current balances as a plain list. An empty
  // accountIds (the default) means every open account, like the chart.
  // showTotal adds a final "Total" row.
  let { accountIds = [], showTotal = false } = $props();

  let data = $state(null);
  let errorMessage = $state(null);

  async function load() {
    errorMessage = null;
    data = null;
    try {
      const params = new URLSearchParams({ range: '1M' });
      if (accountIds.length > 0) params.set('accounts', accountIds.join(','));
      const response = await fetchApi(`/api/account-balances?${params}`);
      if (!response.ok) {
        errorMessage = `Account balances unavailable (${response.status})`;
        return;
      }
      data = await response.json();
    } catch (err) {
      errorMessage = 'Account balances unavailable: could not reach insights-api.';
    }
  }

  load();

  function formatCents(cents) {
    return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }

  // The newest point of each account's series is its balance today.
  let rows = $derived(
    (data?.accounts ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      cents: a.points.length > 0 ? a.points[a.points.length - 1].balanceCents : 0,
    })),
  );
  let total = $derived(rows.reduce((sum, r) => sum + r.cents, 0));
</script>

<div class="actualmint-account-balance-list">
  {#if errorMessage}
    <p class="abl-error" role="alert">{errorMessage}</p>
  {:else if data === null}
    <p class="abl-loading">Loading account balances…</p>
  {:else if rows.length === 0}
    <p class="abl-empty">No accounts to show.</p>
  {:else}
    <ul class="abl-list">
      {#each rows as row (row.id)}
        <li class="abl-row">
          <span class="abl-name">{row.name}</span>
          <span class="abl-amount" class:abl-pos={row.cents > 0} class:abl-neg={row.cents < 0}>{formatCents(row.cents)}</span>
        </li>
      {/each}
      {#if showTotal}
        <li class="abl-row abl-row--total">
          <span class="abl-name">Total</span>
          <span class="abl-amount" class:abl-pos={total > 0} class:abl-neg={total < 0}>{formatCents(total)}</span>
        </li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .actualmint-account-balance-list {
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
  }
  .abl-error {
    color: #b91c1c;
    font-weight: 600;
  }
  .abl-loading,
  .abl-empty {
    color: #555;
  }
  .abl-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .abl-row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid #e5e7eb;
  }
  .abl-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .abl-amount {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    white-space: nowrap;
  }
  .abl-pos {
    color: #15803d;
  }
  .abl-neg {
    color: #b91c1c;
  }
  .abl-row--total {
    border-bottom: none;
    border-top: 2px solid #d1d5db;
    font-weight: 700;
  }
</style>
