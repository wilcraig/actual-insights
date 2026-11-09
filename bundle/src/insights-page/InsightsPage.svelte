<script>
  import { TABS } from './tabs';
  import { navigateToInsights } from './route';

  // `tabId` comes from the URL hash (mount-page.js passes it in and
  // updates it on every route change), so the tab bar only ever asks for
  // a navigation and never keeps its own copy -- the back button, a typed
  // URL, and a click all land in the same place.
  let { tabId = 'general' } = $props();

  let current = $derived(TABS.find((tab) => tab.id === tabId) ?? TABS[0]);

  function selectTab(id) {
    navigateToInsights(window, id);
  }
</script>

<div class="actualmint-insights-page">
  <h2 class="page-title">Actual Insights</h2>

  <div class="tab-bar" role="tablist" aria-label="Actual Insights sections">
    {#each TABS as tab (tab.id)}
      <button
        type="button"
        role="tab"
        id="actualmint-insights-tab-{tab.id}"
        class="pill tab"
        class:pill--active={tab.id === current.id}
        aria-selected={tab.id === current.id ? 'true' : 'false'}
        aria-controls="actualmint-insights-panel"
        onclick={() => selectTab(tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <div
    class="tab-panel"
    role="tabpanel"
    id="actualmint-insights-panel"
    aria-labelledby="actualmint-insights-tab-{current.id}"
  >
    {#key current.id}
      <current.component label={current.label} />
    {/key}
  </div>
</div>

<style>
  .actualmint-insights-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 760px;
    margin: 0 auto;
    padding: 24px 20px 40px;
  }

  .page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
  }

  /* The tab bar reuses the pill chips the General tab already borrows
     from ABT (`.pill` / `.pill--active`, declared :global() in
     GeneralTab.svelte), scoped here under .tab-bar since those globals
     only apply inside a .settings-section. Same values, kept in step. */
  .tab-bar {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .tab-bar .tab {
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: inherit;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .tab-bar .tab.pill--active {
    background: color-mix(in srgb, var(--palette-chartQual1, #2563eb) 20%, transparent);
    border-color: var(--palette-chartQual1, #2563eb);
    color: var(--palette-chartQual1, #2563eb);
  }

  .tab-bar .tab:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
</style>
