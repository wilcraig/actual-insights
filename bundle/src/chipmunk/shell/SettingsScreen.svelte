<script>
  import ChipmunkModeRow from '../ChipmunkModeRow.svelte';

  // The shell's Settings: the Chipmunk-mode switch (turning it off asks first),
  // the subscription status the row already shows, and appearance.
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const mod = mac ? '⌘' : 'Ctrl+';
  let dark = $state(false);
  $effect(() => {
    const q = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!q) return;
    dark = q.matches;
    const on = (e) => (dark = e.matches);
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  });
</script>

<div class="cm-settings-screen">
  <h2>Settings</h2>

  <section>
    <h3>Chipmunk mode</h3>
    <div class="settings-section"><div class="settings-list"><ChipmunkModeRow confirmOff={true} /></div></div>
  </section>

  <section>
    <h3>Appearance</h3>
    <p class="cm-row"><span>Theme</span><span class="cm-value">Follows your device ({dark ? 'dark' : 'light'} now)</span></p>
  </section>

  <section>
    <h3>Keyboard shortcuts</h3>
    <ul class="cm-keys">
      <li><kbd>{mod}1</kbd> Reports</li>
      <li><kbd>{mod}2</kbd> Accounts</li>
      <li><kbd>{mod}3</kbd> Transactions</li>
      <li><kbd>{mod}4</kbd> Budget</li>
      <li><kbd>{mod},</kbd> Settings</li>
      <li><kbd>{mod}K</kbd> Command palette (screens, reports, accounts, payees, categories)</li>
      <li><kbd>j</kbd> <kbd>k</kbd> <kbd>Space</kbd> Move, select in the transactions table; <kbd>Shift</kbd>-click selects a range</li>
    </ul>
    <p class="cm-hint">If your browser keeps {mod}1 to 4 for its own tabs, use <kbd>Alt+1</kbd> to <kbd>Alt+4</kbd>.</p>
  </section>
</div>

<style>
  .cm-settings-screen { display: flex; flex-direction: column; gap: 20px; }
  h2 { margin: 0; font-size: 22px; }
  h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.65; }
  section { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; padding: 14px 16px; }
  .cm-row { display: flex; justify-content: space-between; gap: 12px; margin: 0; flex-wrap: wrap; }
  .cm-value { opacity: 0.75; }
  .cm-keys { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  kbd { font: 12px ui-monospace, monospace; padding: 2px 6px; border-radius: 5px; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); margin-right: 8px; }
  .cm-hint { margin: 10px 0 0; font-size: 13px; opacity: 0.7; }
  section :global(.chipmunk-confirm) { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  section :global(.chipmunk-confirm button) { border: 0; border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; color: inherit; background: color-mix(in srgb, currentColor 12%, transparent); }
  section :global(.chipmunk-confirm-yes) { background: #dc2626 !important; color: #fff !important; }
</style>
