<script>
  import { onMount } from 'svelte';
  import { listTokens, createToken, revokeToken } from './mobile-api';
  import { qrSvg } from './qr';

  // The Insights page's Mobile app tab: pair the Chipmunk companion app by
  // creating a revocable device token. The token is a secret the server
  // returns exactly once; it lives only in `issued` (component state) until
  // the user dismisses the block or leaves the tab. It is never written to
  // web storage, the console, the URL or an error message.

  const MAX_DEVICES = 10;

  let tokens = $state([]);
  let loaded = $state(false);
  let loadError = $state(null);
  let label = $state('');
  let busy = $state(false);
  let error = $state(null);
  let issued = $state(null); // { token, pairingUrl, svg } until dismissed
  let copyStatus = $state(null);
  let confirmingId = $state(null);
  let revokingId = $state(null);

  let atLimit = $derived(tokens.length >= MAX_DEVICES);
  let canCreate = $derived(!busy && !atLimit && label.trim() !== '');

  async function load() {
    loadError = null;
    try {
      tokens = (await listTokens()).tokens || [];
    } catch (err) {
      loadError = err.message;
    } finally {
      loaded = true;
    }
  }

  function dismiss() {
    issued = null;
    copyStatus = null;
  }

  onMount(() => {
    load();
    // Reopening the page starts clean: never keep a secret on screen.
    const onShown = () => {
      dismiss();
      load();
    };
    document.addEventListener('insights:page-shown', onShown);
    return () => {
      document.removeEventListener('insights:page-shown', onShown);
      dismiss();
    };
  });

  async function create() {
    busy = true;
    error = null;
    dismiss();
    try {
      const created = await createToken(label.trim());
      const pairingUrl = `chipmunk://pair?u=${encodeURIComponent(window.location.origin)}&t=${encodeURIComponent(created.token)}`;
      issued = { token: created.token, pairingUrl, svg: qrSvg(pairingUrl, { cellSize: 4, margin: 4 }) };
      label = '';
      await load();
    } catch (err) {
      error = err.message;
    } finally {
      busy = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(issued.token);
      copyStatus = 'Copied.';
    } catch {
      copyStatus = 'Could not copy automatically. Select the token above and copy it manually.';
    }
  }

  async function revoke(id) {
    revokingId = id;
    error = null;
    try {
      await revokeToken(id);
      tokens = tokens.filter((t) => t.id !== id);
      confirmingId = null;
    } catch (err) {
      error = err.message;
    } finally {
      revokingId = null;
    }
  }

  function formatWhen(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }
</script>

<div class="actualmint-mobile-tab settings-section">
  <div class="section-header">
    <h3 class="section-title">Mobile app</h3>
  </div>

  <div class="settings-list">
    <p class="mobile-note">
      A device token lets the Chipmunk companion app and its widgets read a budget summary from this server. It is read-only and gives access to nothing else. Create one per device and revoke it here at any time.
    </p>

    <p class="secret-warning" role="note">
      The QR code and the token contain a secret. Anyone who has them can read your budget summary. Do not screenshot or share them.
    </p>

    <h4 class="group-label">Pair a new device</h4>
    <div class="action-row">
      <label class="form-row" for="mobile-label">
        <span class="setting-desc">Label</span>
        <input id="mobile-label" class="abt-input label-input" type="text" maxlength="60" placeholder="e.g. Ann's phone"
          bind:value={label} disabled={atLimit} />
      </label>
      <button type="button" class="abt-btn create-token" disabled={!canCreate} onclick={create}>{busy ? 'Creating…' : 'Create token'}</button>
    </div>
    {#if atLimit}
      <p class="mobile-note">Device limit reached. Revoke a device to pair another.</p>
    {/if}
    {#if error}
      <p class="mobile-error" role="alert">{error}</p>
    {/if}

    {#if issued}
      <div class="new-token" role="status">
        <strong>Copy this now. It will not be shown again.</strong>
        <code class="token-value">{issued.token}</code>
        <div class="action-row">
          <button type="button" class="abt-btn copy-token" onclick={copy}>Copy</button>
          {#if copyStatus}<span class="copy-status mobile-note" role="status">{copyStatus}</span>{/if}
        </div>
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        <!-- Safe: the SVG string is built by qrSvg() from the encoder's boolean module grid and numbers only; no part of it is raw user input. -->
        <div class="qr">{@html issued.svg}</div>
        <code class="pairing-url">{issued.pairingUrl}</code>
        <div class="action-row">
          <button type="button" class="abt-btn done" onclick={dismiss}>Done</button>
        </div>
      </div>
    {/if}

    <h4 class="group-label">Paired devices</h4>
    {#if loadError}
      <p class="mobile-error" role="alert">{loadError}</p>
    {:else if !loaded}
      <p class="mobile-note">Loading devices…</p>
    {:else}
      <p class="mobile-note device-count">{tokens.length} of {MAX_DEVICES} devices</p>
      {#if tokens.length === 0}
        <p class="empty-state mobile-note">No devices paired yet.</p>
      {/if}
      {#each tokens as t (t.id)}
        <div class="token-row" data-token-id={t.id}>
          <span class="setting-text">
            <span class="setting-label">{t.label}</span>
            <span class="setting-desc">Created {formatWhen(t.createdAt)} · {t.lastUsedAt ? `Last used ${formatWhen(t.lastUsedAt)}` : 'Never used'}</span>
          </span>
          {#if confirmingId === t.id}
            <span class="confirm-bar">
              <span class="mobile-note">Revoke this device? It stops working immediately.</span>
              <button type="button" class="abt-btn confirm-revoke" disabled={revokingId === t.id} onclick={() => revoke(t.id)}>{revokingId === t.id ? 'Revoking…' : 'Revoke'}</button>
              <button type="button" class="abt-btn cancel-revoke" onclick={() => { confirmingId = null; }}>Cancel</button>
            </span>
          {:else}
            <button type="button" class="abt-btn revoke" onclick={() => { confirmingId = t.id; }}>Revoke</button>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .actualmint-mobile-tab {
    display: flex;
    flex-direction: column;
  }

  .group-label {
    margin: 16px 0 4px;
  }

  .form-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 4px 0;
  }

  .action-row {
    display: flex;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 6px;
    margin: 8px 0;
  }

  .mobile-note {
    margin: 0;
    font-size: 12px;
    opacity: 0.65;
  }

  .secret-warning {
    margin: 8px 0;
    padding: 8px 10px;
    border-radius: 6.5px;
    border: 1px solid #b45309;
    color: #b45309;
    font-size: 12px;
    font-weight: 600;
  }

  .mobile-error {
    margin: 4px 0;
    color: #b91c1c;
    font-size: 12px;
  }

  .new-token {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0;
    padding: 10px;
    border-radius: 6.5px;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
    font-size: 12px;
  }

  .token-value,
  .pairing-url {
    word-break: break-all;
    user-select: all;
    font-size: 12px;
  }

  .qr :global(svg) {
    display: block;
    width: 200px;
    height: 200px;
  }

  .token-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  }

  .confirm-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }

  /* Same ABT-shaped controls as SummariesTab.svelte. */
  .abt-input,
  .abt-btn {
    height: 30px;
    border-radius: 6.5px;
    border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: inherit;
    font: inherit;
    font-size: 12px;
    box-sizing: border-box;
  }

  .abt-input {
    padding: 0 8px;
  }

  .abt-btn {
    padding: 0 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .abt-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
