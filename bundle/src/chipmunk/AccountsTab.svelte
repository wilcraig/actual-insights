<script>
  import { onMount } from 'svelte';
  import { getAccounts, syncAccounts } from './chipmunk-api';
  import { layoutAccounts, loadExpanded, saveExpanded, balanceTone, formatMoney } from './logic';

  // The phone's Accounts page: On budget / Off budget, groups collapsed until
  // opened (remembered in this browser), green/red balances.
  let sections = $state([]);
  let status = $state('loading');
  let errorText = $state('');
  let expanded = $state(new Set());
  let syncing = $state(false);
  let syncMessage = $state('');
  let syncFailed = $state(false);

  function syncErrorText(err) {
    if (err && err.status === 409) return 'A sync is already running';
    if (err && err.status === 502) return 'Bank sync failed. Check the bank connection in Actual and try again';
    if (err && err.message === 'timeout') return 'The sync is taking too long. Check Actual and try again';
    return 'Could not sync. Try again';
  }

  async function sync() {
    if (syncing) return;
    syncing = true;
    syncMessage = '';
    syncFailed = false;
    try {
      await syncAccounts();
      syncMessage = 'Synced just now';
      await load({ quiet: true });
    } catch (err) {
      syncFailed = true;
      syncMessage = syncErrorText(err);
    } finally {
      syncing = false;
    }
  }

  function storage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  function toggle(id) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
    const s = storage();
    if (s) saveExpanded(s, next);
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) status = 'loading';
    try {
      sections = layoutAccounts(await getAccounts());
      status = 'ready';
    } catch (err) {
      errorText = err.message;
      status = 'error';
    }
  }

  onMount(() => {
    const s = storage();
    if (s) expanded = loadExpanded(s);
    load();
  });
</script>

<div class="accounts-tab">
  <div class="sync-bar">
    <button type="button" class="sync-btn" disabled={syncing} aria-busy={syncing ? 'true' : 'false'} onclick={sync}>
      {#if syncing}<span class="spinner" aria-hidden="true"></span>Syncing&hellip;{:else}Sync{/if}
    </button>
    <span class="sync-msg" class:err={syncFailed} role="status" aria-live="polite">{syncMessage}</span>
  </div>
  {#if status === 'loading'}
    <p class="note">Loading&hellip;</p>
  {:else if status === 'error'}
    <p class="note err" role="alert">{errorText}</p>
  {:else if sections.length === 0}
    <p class="note">No open accounts.</p>
  {:else}
    {#each sections as section (section.label)}
      <h3>{section.label}</h3>
      <ul class="list">
        {#each section.rows as row (row.type === 'group' ? `g:${row.group.id}` : `a:${row.account.id}`)}
          {#if row.type === 'account'}
            <li class="row account"><span class="name">{row.account.name}</span><span class="bal {balanceTone(row.account.balance)}">{formatMoney(row.account.balance)}</span></li>
          {:else}
            <li class="group" data-group-id={row.group.id}>
              <button type="button" class="row head" aria-expanded={expanded.has(row.group.id) ? 'true' : 'false'} onclick={() => toggle(row.group.id)}>
                <span class="chev" aria-hidden="true">{expanded.has(row.group.id) ? '▾' : '▸'}</span>
                <span class="name">{row.group.name}</span>
                <span class="bal {balanceTone(row.subtotal)}">{formatMoney(row.subtotal)}</span>
              </button>
              {#if expanded.has(row.group.id)}
                <ul class="list inner">
                  {#each row.accounts as a (a.id)}
                    <li class="row account"><span class="name">{a.name}</span><span class="bal {balanceTone(a.balance)}">{formatMoney(a.balance)}</span></li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/if}
        {/each}
      </ul>
    {/each}
  {/if}
</div>

<style>
  .sync-bar { display: flex; align-items: center; gap: 12px; margin: 0 0 4px; }
  .sync-btn { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
  .sync-btn:hover:not(:disabled) { background: color-mix(in srgb, currentColor 8%, transparent); }
  .sync-btn:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  .sync-btn:disabled { opacity: 0.7; cursor: default; }
  .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor; animation: sync-spin 0.8s linear infinite; }
  @keyframes sync-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
  .sync-msg { font-size: 13px; opacity: 0.8; }
  .sync-msg.err { color: #dc2626; opacity: 1; }
  .accounts-tab h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin: 12px 0 4px; }
  .list { list-style: none; margin: 0; padding: 0; }
  .inner { padding-left: 22px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 10px 4px; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
  .head { width: 100%; background: transparent; border: 0; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); color: inherit; font: inherit; font-weight: 600; cursor: pointer; text-align: left; }
  .name { flex: 1; min-width: 0; }
  .bal { font-variant-numeric: tabular-nums; }
  .positive { color: #16a34a; }
  .negative { color: #dc2626; }
  .note { opacity: 0.75; }
  .err { color: #dc2626; opacity: 1; }
</style>
