<script>
  import { onMount } from 'svelte';
  import { getMode, setMode } from './chipmunk-api';
  import { setChipmunkMode } from './mode-state';

  // `confirmOff`: ask before turning it off (the shell's Settings screen does;
  // the General tab keeps its one-click switch).
  let { confirmOff = false } = $props();
  let confirming = $state(false);

  // The "Chipmunk mode" switch on the General tab. Hidden until the server
  // answers with a recognisable state, so a failure leaves the tab as it was.
  let loaded = $state(false);
  let enabled = $state(false);
  let entitled = $state(false);
  let reason = $state('');
  let lastVerifiedAt = $state(null);
  let validUntil = $state(null);
  let serverMode = $state('strict');
  let saving = $state(false);
  let errorText = $state('');

  function apply(state) {
    if (!state || typeof state.enabled !== 'boolean' || typeof state.entitled !== 'boolean') return false;
    enabled = state.enabled;
    entitled = state.entitled;
    reason = state.reason ?? '';
    lastVerifiedAt = typeof state.lastVerifiedAt === 'string' ? state.lastVerifiedAt : null;
    validUntil = typeof state.validUntil === 'string' ? state.validUntil : null;
    serverMode = state.mode === 'dev' || state.mode === 'open' ? state.mode : 'strict';
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

  const REASONS = {
    none: 'No Chipmunk subscription has been confirmed yet.',
    expired: 'The last confirmation has run out (the subscription ended, or the app has not checked in for over a month).',
    unverified: 'The last proof from the app could not be verified.',
    not_configured: 'This server cannot check that store yet.',
  };
  const reasonText = (r) => REASONS[r] ?? 'No Chipmunk subscription has been confirmed.';

  function day(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function toggle(event) {
    const want = event.target.checked;
    if (!want && confirmOff) {
      event.target.checked = true;
      confirming = true;
      return;
    }
    await save(want, event.target);
  }

  async function confirmTurnOff() {
    confirming = false;
    await save(false, document.getElementById('insights-chipmunk-mode'));
  }

  async function save(want, box) {
    saving = true;
    errorText = '';
    try {
      if (!apply(await setMode(want))) throw new Error('Unexpected response');
    } catch (err) {
      errorText = err.message || 'Could not save.';
      if (box) box.checked = enabled;
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
          Turns the whole app into Chipmunk: Reports, Accounts, Transactions and Budget, as in the phone app. Use Open Actual in the sidebar to get to Actual itself.
        {:else}
          Open Chipmunk (iPhone, Mac or Android) once with a current subscription to unlock this.
        {/if}
      </span>
      {#if entitled && lastVerifiedAt}
        <span class="setting-desc chipmunk-verified">
          Verified by your Chipmunk app on {day(lastVerifiedAt)}; the app re-checks daily{validUntil ? ` (valid until ${day(validUntil)})` : ''}.
        </span>
      {:else if !entitled}
        <span class="setting-desc chipmunk-reason">{reasonText(reason)}</span>
      {/if}
      {#if serverMode !== 'strict'}
        <span class="setting-desc chipmunk-test-mode">Test mode: this server does not check the subscription{serverMode === 'dev' ? ' properly' : ''}.</span>
      {/if}
      {#if confirming}
        <span class="setting-desc chipmunk-confirm" role="alertdialog" aria-label="Turn off Chipmunk mode">
          Turn off Chipmunk mode? The whole app goes back to plain Actual.
          <button type="button" class="chipmunk-confirm-yes" onclick={confirmTurnOff}>Turn off</button>
          <button type="button" class="chipmunk-confirm-no" onclick={() => (confirming = false)}>Cancel</button>
        </span>
      {/if}
      {#if errorText}<span class="setting-desc" role="alert">{errorText}</span>{/if}
    </span>
    <input type="checkbox" id="insights-chipmunk-mode" checked={enabled} disabled={!entitled || saving} onchange={toggle} />
  </div>
{/if}
