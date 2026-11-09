<script>
  import { onMount } from 'svelte';
  import { getAccounts } from './chipmunk-api';
  import { layoutAccounts, loadExpanded, saveExpanded, balanceTone, formatMoney } from './logic';

  // The phone's Accounts page: On budget / Off budget, groups collapsed until
  // opened (remembered in this browser), green/red balances.
  let sections = $state([]);
  let status = $state('loading');
  let errorText = $state('');
  let expanded = $state(new Set());

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

  async function load() {
    status = 'loading';
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
