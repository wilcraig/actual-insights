<script>
  import { onMount, setContext } from 'svelte';
  import ReportsScreen from './ReportsScreen.svelte';
  import AccountsTab from '../AccountsTab.svelte';
  import TransactionsTab from '../TransactionsTab.svelte';
  import BudgetTab from '../BudgetTab.svelte';
  import SettingsScreen from './SettingsScreen.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import InsightsPage from '../../insights-page/InsightsPage.svelte';
  import { SCREENS, INSIGHTS_TABS, parseHash, hashFor, shortcutTarget, isPaletteKey } from './routes';
  import { watchRoute } from '../../widget-builder/route-watcher';

  // The whole app while Chipmunk mode is on: a sidebar (a drawer on narrow
  // screens) with the phone app's four screens, Settings, More Insights (the
  // existing Insights page, unchanged) and Open Actual. Each screen is the
  // component the Insights tabs used before; the shell only adds the frame.
  let { openActual, actual = null, host = null, win = window, visible = true } = $props();
  setContext('cm-actual', actual);

  const SCREEN_COMPONENTS = { reports: ReportsScreen, accounts: AccountsTab, transactions: TransactionsTab, budget: BudgetTab, settings: SettingsScreen };
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  const mod = mac ? '⌘' : 'Ctrl+';

  let route = $state(parseHash(win.location.hash));
  let drawer = $state(false);
  let alive = true;
  let palette = $state(false);
  let nonce = $state(0); // bumps to remount the current screen (palette jumps to the screen already open)

  const titles = Object.fromEntries([...SCREENS.map((s) => [s.id, s.label]), ['settings', 'Settings'], ['insights', 'Insights']]);
  let title = $derived(route.screen === 'insights' ? 'Insights' : titles[route.screen]);

  function sync() {
    if (alive) route = parseHash(win.location.hash);
  }

  function go(screen, tab, remount = false) {
    if (remount) nonce++;
    const hash = hashFor(screen, tab);
    drawer = false;
    if (win.location.hash !== hash) {
      win.history.pushState(win.history.state, '', `${win.location.pathname}${win.location.search}${hash}`);
    }
    sync();
  }

  function link(event, screen, tab) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return; // let the browser open a new tab
    event.preventDefault();
    go(screen, tab);
  }

  function onKey(event) {
    if (!visible) return;
    // Handled keys stop here: on the Reports screen Actual is live underneath
    // and has its own Ctrl/Cmd-K search that must not open as well.
    if (isPaletteKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      palette = !palette;
      return;
    }
    if (palette) return;
    if (event.key === 'Escape' && drawer) {
      drawer = false;
      return;
    }
    const target = shortcutTarget(event);
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      go(target);
    }
  }

  onMount(() => {
    // A bare or foreign hash becomes the canonical Reports address, so Back behaves.
    if (!win.location.hash || parseHash(win.location.hash).screen === 'reports') {
      if (win.location.hash !== hashFor('reports')) {
        win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}${hashFor('reports')}`);
      }
    }
    // The pushState hook is never removed (other bundle code wraps it too); `alive` mutes it.
    watchRoute(win, sync);
    win.addEventListener('hashchange', sync);
    win.addEventListener('keydown', onKey, true);
    return () => {
      alive = false;
      win.removeEventListener('hashchange', sync);
      win.removeEventListener('keydown', onKey, true);
    };
  });

  // On the Reports screen Actual's own page shows through the shell: the host
  // sinks below Actual's modals and the widget builder (z-index 100 and up),
  // stops painting and catching clicks outside the chrome.
  const reveal = $derived(visible && route.screen === 'reports' && !!actual);
  $effect(() => {
    if (!host) return;
    host.style.zIndex = reveal ? '50' : '2147483000';
    host.style.pointerEvents = reveal ? 'none' : '';
    host.style.background = reveal ? 'transparent' : 'Canvas';
  });

  // Re-read the address whenever the shell is shown again (after Open Actual / Back).
  $effect(() => {
    if (visible) sync();
  });
</script>

<div class="cm-shell" class:cm-reveal={reveal} class:cm-drawer-open={drawer} data-chipmunk-shell-root>
  <header class="cm-topbar">
    <button type="button" class="cm-hamburger" aria-label="Menu" aria-expanded={drawer} onclick={() => (drawer = !drawer)}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" /></svg>
    </button>
    <span class="cm-topbar-title">{title}</span>
  </header>

  {#if drawer}<button type="button" class="cm-scrim" aria-label="Close menu" onclick={() => (drawer = false)}></button>{/if}

  <nav class="cm-sidebar" aria-label="Chipmunk">
    <div class="cm-brand"><span class="cm-logo" aria-hidden="true">C</span><span>Chipmunk</span></div>

    <button type="button" class="cm-linklike cm-find" onclick={() => (palette = true)}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <span class="cm-label">Search&hellip;</span><kbd class="cm-hint">{mod}K</kbd>
    </button>

    <ul class="cm-items">
      {#each SCREENS as s (s.id)}
        <li>
          <a href={hashFor(s.id)} class:cm-active={route.screen === s.id} aria-current={route.screen === s.id ? 'page' : undefined} onclick={(e) => link(e, s.id)}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              {#if s.id === 'reports'}<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
              {:else if s.id === 'accounts'}<rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M16 15h2" />
              {:else if s.id === 'transactions'}<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
              {:else}<circle cx="12" cy="12" r="9" /><path d="M12 3v9h9" />{/if}
            </svg>
            <span class="cm-label">{s.label}</span>
            <kbd class="cm-hint">{mod}{s.shortcut}</kbd>
          </a>
        </li>
      {/each}
    </ul>

    <div class="cm-section-label">More Insights</div>
    <ul class="cm-items cm-small">
      {#each INSIGHTS_TABS as t (t.id)}
        <li>
          <a href={hashFor('insights', t.id)} class:cm-active={route.screen === 'insights' && route.tab === t.id} aria-current={route.screen === 'insights' && route.tab === t.id ? 'page' : undefined} onclick={(e) => link(e, 'insights', t.id)}>
            <span class="cm-label">{t.label}</span>
          </a>
        </li>
      {/each}
      <li><button type="button" class="cm-linklike" onclick={() => openActual({ path: '/reports' })}><span class="cm-label">Widget builder</span><span class="cm-ext" aria-hidden="true">in Actual</span></button></li>
    </ul>

    <div class="cm-spacer"></div>
    <ul class="cm-items">
      <li>
        <a href={hashFor('settings')} class:cm-active={route.screen === 'settings'} aria-current={route.screen === 'settings' ? 'page' : undefined} onclick={(e) => link(e, 'settings')}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></svg>
          <span class="cm-label">Settings</span>
        </a>
      </li>
      <li>
        <button type="button" class="cm-linklike cm-open-actual" onclick={() => openActual({})}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
          <span class="cm-label">Open Actual</span>
        </button>
      </li>
    </ul>
  </nav>

  {#if palette}<CommandPalette onClose={() => (palette = false)} {go} {openActual} />{/if}

  <main class="cm-content" id="chipmunk-main">
    <div class="cm-column" class:cm-wide={route.screen === 'transactions'} class:cm-mid={route.screen === 'accounts' || route.screen === 'budget'} class:cm-full={route.screen === 'reports'}>
      {#key `${route.screen}/${route.tab ?? ''}/${nonce}`}
        <svelte:boundary>
          {#if route.screen === 'insights'}
            <InsightsPage tabId={route.tab} />
          {:else}
            {@const Screen = SCREEN_COMPONENTS[route.screen]}
            <Screen />
          {/if}
          {#snippet failed(error, reset)}
            <div class="cm-crash" role="alert">
              <p>This screen hit a problem{error?.message ? `: ${error.message}` : ''}.</p>
              <button type="button" onclick={reset}>Try again</button>
              <button type="button" onclick={() => openActual({})}>Open Actual</button>
            </div>
          {/snippet}
        </svelte:boundary>
      {/key}
    </div>
  </main>
</div>

<style>
  .cm-shell {
    --cm-bg: #ffffff; --cm-fg: #1c1c1e; --cm-side: #f3f4f6; --cm-line: rgba(0, 0, 0, 0.1); --cm-accent: #2563eb;
    --palette-chartQual1: var(--cm-accent);
    color-scheme: light dark;
    position: absolute; inset: 0; display: grid; grid-template-columns: 248px 1fr; grid-template-rows: 1fr;
    background: var(--cm-bg); color: var(--cm-fg);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    .cm-shell { --cm-bg: #111214; --cm-fg: #ececf0; --cm-side: #1a1b1e; --cm-line: rgba(255, 255, 255, 0.12); --cm-accent: #6ea0ff; }
  }
  .cm-topbar, .cm-scrim { display: none; }
  .cm-sidebar { background: var(--cm-side); border-right: 1px solid var(--cm-line); padding: 16px 10px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
  .cm-brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; padding: 4px 10px 14px; }
  .cm-logo { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: var(--cm-accent); color: #fff; font-size: 16px; }
  .cm-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .cm-items a, .cm-linklike { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; color: inherit; text-decoration: none; background: transparent; border: 0; font: inherit; cursor: pointer; text-align: left; min-height: 38px; }
  .cm-items a:hover, .cm-linklike:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
  .cm-items a.cm-active { background: color-mix(in srgb, var(--cm-accent) 18%, transparent); color: var(--cm-accent); font-weight: 600; }
  .cm-items a:focus-visible, .cm-linklike:focus-visible, .cm-hamburger:focus-visible { outline: 2px solid var(--cm-accent); outline-offset: 1px; }
  .cm-label { flex: 1; }
  .cm-hint, .cm-ext { font-size: 11px; opacity: 0.5; font-family: inherit; }
  .cm-small .cm-label { font-size: 14px; }
  .cm-small a, .cm-small .cm-linklike { padding-left: 38px; min-height: 34px; }
  .cm-section-label { margin: 14px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.55; }
  .cm-spacer { flex: 1; min-height: 12px; }
  .cm-open-actual { border: 1px solid var(--cm-line); }
  .cm-content { overflow-y: auto; min-width: 0; -webkit-overflow-scrolling: touch; }
  .cm-column { max-width: 760px; margin: 0 auto; padding: 24px 20px 48px; box-sizing: border-box; }
  .cm-column.cm-mid { max-width: 1040px; }
  .cm-column.cm-wide { max-width: 1760px; }
  .cm-column.cm-full { max-width: none; padding: 0; height: 100%; box-sizing: border-box; }
  .cm-reveal { background: transparent; pointer-events: none; }
  .cm-reveal .cm-content { overflow: hidden; background: transparent; }
  .cm-reveal .cm-sidebar, .cm-reveal .cm-topbar, .cm-reveal .cm-scrim { pointer-events: auto; }
  .cm-find { border: 1px solid var(--cm-line); margin-bottom: 8px; opacity: 0.85; }
  .cm-crash { border: 1px solid #dc2626; border-radius: 10px; padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .cm-crash p { flex-basis: 100%; margin: 0; }
  .cm-crash button { border: 0; border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit; color: inherit; background: color-mix(in srgb, currentColor 12%, transparent); }

  @media (max-width: 759px) {
    .cm-shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .cm-topbar { display: flex; align-items: center; gap: 8px; padding: calc(env(safe-area-inset-top, 0px) + 6px) 8px 6px; border-bottom: 1px solid var(--cm-line); background: var(--cm-side); }
    .cm-hamburger { border: 0; background: transparent; color: inherit; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 8px; cursor: pointer; }
    .cm-topbar-title { font-weight: 600; font-size: 17px; }
    .cm-sidebar { position: absolute; z-index: 3; top: 0; bottom: 0; left: 0; width: min(290px, 84vw); transform: translateX(-102%); visibility: hidden; transition: transform 0.2s ease, visibility 0s linear 0.2s; padding-top: calc(env(safe-area-inset-top, 0px) + 16px); box-shadow: none; }
    .cm-drawer-open .cm-sidebar { transform: none; visibility: visible; transition: transform 0.2s ease, visibility 0s; box-shadow: 0 0 40px rgba(0, 0, 0, 0.4); }
    .cm-scrim { display: block; position: absolute; inset: 0; z-index: 2; border: 0; background: rgba(0, 0, 0, 0.4); cursor: default; }
    .cm-hint { display: none; }
    .cm-column.cm-full { padding: 0; }
    .cm-column, .cm-column.cm-wide, .cm-column.cm-mid { padding: 16px 14px calc(env(safe-area-inset-bottom, 0px) + 40px); }
  }
  @media (prefers-reduced-motion: reduce) { .cm-sidebar { transition: none; } }
</style>
