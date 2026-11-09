<script>
  import { onMount } from 'svelte';
  import { getMode, setMode } from './chipmunk-api';
  import { setChipmunkMode } from './mode-state';

  // The "Chipmunk mode" switch on the General tab. Hidden until the server
  // answers with a recognisable state, so a failure leaves the tab as it was.
  let loaded = $state(false);
  let enabled = $state(false);
  let entitled = $state(false);
  let reason = $state('');
  let saving = $state(false);
  let errorText = $state('');

  function apply(state) {
    if (!state || typeof state.enabled !== 'boolean' || typeof state.entitled !== 'boolean') return false;
    enabled = state.enabled;
    entitled = state.entitled;
    reason = state.reason ?? '';
    setChipmunkMode(state);
    return true;
  }

  onMount(async () => {
    try {
      loaded = apply(await getMode());
    } catch {
      loaded = false;
    }
  });

  async function toggle(event) {
    const want = event.target.checked;
    saving = true;
    errorText = '';
    try {
      if (!apply(await setMode(want))) throw new Error('Unexpected response');
    } catch (err) {
      errorText = err.message || 'Could not save.';
      event.target.checked = enabled;
    } finally {
      saving = false;
    }
  }
</script>

{#if loaded}
  <div class="setting-row chipmunk-mode-row">
    <span class="setting-text">
      <span class="setting-label">Chipmunk mode</span>
      <span class="setting-desc">
        {#if entitled}
          Show Reports, Accounts, Transactions and Budget here the way the Chipmunk phone app does.
        {:else}
          Not available{reason ? ` (${reason})` : ''}.
        {/if}
      </span>
      {#if errorText}<span class="setting-desc" role="alert">{errorText}</span>{/if}
    </span>
    <input type="checkbox" id="insights-chipmunk-mode" checked={enabled} disabled={!entitled || saving} onchange={toggle} />
  </div>
{/if}
