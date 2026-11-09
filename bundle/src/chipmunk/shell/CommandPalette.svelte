<script>
  import { onMount, tick } from 'svelte';
  import { getReportList, getAccounts, suggest } from '../chipmunk-api';
  import { saveReportChoice, emptyFilter, applySuggestion, suggestionRows } from '../logic';
  import { SCREENS, INSIGHTS_TABS, paletteMatch } from './routes';
  import { setTxHandoff, setReportHandoff } from './handoff';

  // Cmd/Ctrl-K: jump to any screen, report, account or payee/category, search
  // transactions, or leave for Actual. Lists load once, when first opened.
  let { onClose, go, openActual } = $props();

  let query = $state('');
  let index = $state(0);
  let reports = $state([]);
  let accounts = $state([]);
  let found = $state([]);
  let input;
  let timer = null;
  let ticket = 0;

  const base = [
    ...SCREENS.map((s) => ({ label: s.label, group: 'Go to', run: () => go(s.id) })),
    { label: 'Settings', group: 'Go to', run: () => go('settings') },
    ...INSIGHTS_TABS.map((t) => ({ label: `Insights: ${t.label}`, group: 'More Insights', run: () => go('insights', t.id) })),
    { label: 'Widget builder (opens Actual)', group: 'Actions', run: () => openActual({ path: '/reports' }) },
    { label: 'Open Actual', group: 'Actions', run: () => openActual({}) },
  ];

  const items = $derived.by(() => {
    const q = query.trim();
    const dyn = [
      ...reports.map((r) => ({ label: `Report: ${r.title}`, group: 'Reports', run: () => { try { saveReportChoice(window.localStorage, r.id); } catch {} setReportHandoff(r.id); go('reports', undefined, true); } })),
      ...accounts.map((a) => ({ label: `Transactions in ${a.name}`, group: 'Accounts', run: () => { setTxHandoff({ account: a.id }); go('transactions', undefined, true); } })),
      ...found.map((row) => ({ label: `${row.kind === 'category' ? 'Category' : 'Payee'}: ${row.name}`, group: 'Transactions', run: () => { setTxHandoff({ filter: applySuggestion(emptyFilter(), row) }); go('transactions', undefined, true); } })),
    ];
    const all = [...base, ...dyn].filter((i) => !q || paletteMatch(i.label, q));
    if (q) all.push({ label: `Search transactions for “${q}”`, group: 'Transactions', run: () => { setTxHandoff({ filter: { ...emptyFilter(), text: q } }); go('transactions', undefined, true); } });
    return all.slice(0, 40);
  });

  $effect(() => {
    query;
    index = 0;
    clearTimeout(timer);
    const q = query.trim();
    if (q.length < 2) {
      found = [];
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++ticket;
      try {
        const r = await suggest(q, 6);
        if (mine === ticket) found = suggestionRows(r);
      } catch {
        if (mine === ticket) found = [];
      }
    }, 200);
  });

  function choose(item) {
    onClose();
    item?.run();
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      index = Math.min(items.length - 1, index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      index = Math.max(0, index - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(items[index]);
    }
  }

  onMount(async () => {
    await tick();
    input?.focus();
    getReportList().then((r) => (reports = r.reports ?? [])).catch(() => {});
    getAccounts().then((r) => (accounts = r.accounts ?? [])).catch(() => {});
  });
</script>

<div class="cm-pal-scrim" role="presentation" onclick={onClose}>
  <div class="cm-pal" role="dialog" aria-modal="true" aria-label="Command palette" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={onKey}>
    <input bind:this={input} bind:value={query} class="cm-pal-input" type="text" placeholder="Jump to a screen, report, account, payee or category&hellip;" aria-label="Command palette" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="cm-pal-list" />
    <ul class="cm-pal-list" id="cm-pal-list" role="listbox">
      {#each items as item, i (item.group + item.label)}
        <li role="option" aria-selected={i === index} class:cm-pal-on={i === index}>
          <button type="button" tabindex="-1" onclick={() => choose(item)} onmousemove={() => (index = i)}><span>{item.label}</span><small>{item.group}</small></button>
        </li>
      {/each}
      {#if items.length === 0}<li class="cm-pal-empty">Nothing matches.</li>{/if}
    </ul>
    <div class="cm-pal-foot">&uarr;&darr; to move &middot; Enter to open &middot; Esc to close</div>
  </div>
</div>

<style>
  .cm-pal-scrim { pointer-events: auto; position: absolute; inset: 0; z-index: 10; background: rgba(0, 0, 0, 0.45); display: flex; justify-content: center; align-items: flex-start; padding: 12vh 12px 0; }
  .cm-pal { width: min(620px, 100%); max-height: 70vh; display: flex; flex-direction: column; border-radius: 14px; overflow: hidden; background: var(--cm-bg, Canvas); color: var(--cm-fg, CanvasText); border: 1px solid var(--cm-line, rgba(128, 128, 128, 0.3)); box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45); }
  .cm-pal-input { border: 0; border-bottom: 1px solid var(--cm-line, rgba(128, 128, 128, 0.3)); padding: 14px 16px; font: inherit; font-size: 16px; background: transparent; color: inherit; outline: none; }
  .cm-pal-list { list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
  .cm-pal-list button { display: flex; justify-content: space-between; gap: 12px; width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
  .cm-pal-on button { background: color-mix(in srgb, var(--cm-accent, #2563eb) 20%, transparent); }
  .cm-pal-list small { opacity: 0.55; }
  .cm-pal-empty { padding: 12px; opacity: 0.6; }
  .cm-pal-foot { padding: 6px 14px; font-size: 12px; opacity: 0.55; border-top: 1px solid var(--cm-line, rgba(128, 128, 128, 0.3)); }
</style>
