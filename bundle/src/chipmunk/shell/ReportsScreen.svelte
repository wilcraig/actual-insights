<script>
  import { onMount, getContext } from 'svelte';
  import { getReportList } from '../chipmunk-api';
  import { effectiveReport, loadReportChoice, saveReportChoice } from '../logic';
  import { takeReportHandoff } from './handoff';
  import { reportPath, reportFromPath, isReportsPath } from './report-routes';

  // Reports, the original way: Actual's own Reports page (the Insights widgets,
  // Add new widget, Widget builder, Edit dashboard...) shows in the slot below.
  // Only the report dropdown is Chipmunk's: it lists every dashboard page and
  // saved report, and picking one moves Actual to that page or report.
  const actual = getContext('cm-actual');

  let list = $state(null);
  let reportId = $state(null);
  let errorText = $state('');
  let path = $state(window.location.pathname);
  let slot;

  function storage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  const entry = (id) => list?.reports.find((r) => r.id === id) ?? null;

  function show(id, { persist = true } = {}) {
    const e = entry(id);
    if (!e) return;
    reportId = e.id;
    const s = storage();
    if (persist && s) saveReportChoice(s, e.id);
    actual?.navigate(reportPath(e));
  }

  // Actual moved by itself (its own dashboard dropdown, a link): follow it. A
  // dashboard or report this list has not seen (just created in Actual) makes it
  // look again a few times: the server sees a new page only after Actual syncs.
  const RETRY_MS = [800, 3000, 8000];
  let retryTimers = [];
  async function relist() {
    try {
      list = await getReportList();
    } catch {
      return;
    }
    const e = reportFromPath(list, window.location.pathname);
    if (e) {
      reportId = e.id;
      retryTimers.forEach(clearTimeout);
      retryTimers = [];
    }
  }
  function follow(p) {
    path = p;
    const e = reportFromPath(list, p);
    if (e) {
      if (e.id !== reportId) {
        reportId = e.id;
        const s = storage();
        if (s) saveReportChoice(s, e.id);
      }
      return;
    }
    if (list && isReportsPath(p) && p !== '/reports' && p !== '/reports/') {
      retryTimers.forEach(clearTimeout);
      retryTimers = RETRY_MS.map((ms) => setTimeout(relist, ms));
    }
  }

  async function start() {
    try {
      list = await getReportList();
    } catch (err) {
      errorText = err.message;
      actual?.navigate('/reports');
      return;
    }
    const s = storage();
    const fromActual = reportFromPath(list, window.location.pathname)?.id ?? null;
    const picked = takeReportHandoff();
    const id = picked && entry(picked) ? picked : fromActual ?? effectiveReport(list, null, s ? loadReportChoice(s) : null);
    if (id) show(id, { persist: !!picked || !fromActual });
    else actual?.navigate('/reports');
  }

  onMount(() => {
    const off = actual?.onPath?.(follow);
    actual?.reveal(slot);
    start();
    return () => {
      retryTimers.forEach(clearTimeout);
      off?.();
      actual?.conceal();
    };
  });
</script>

<div class="cm-reports-screen">
  <div class="cm-reports-head">
    {#if list && list.reports.length > 0}
      <select class="cm-title-select" aria-label="Report" value={reportId} onchange={(e) => show(e.target.value)}>
        {#each list.reports as r (r.id)}<option value={r.id}>{r.title}</option>{/each}
      </select>
    {:else}
      <h3 class="cm-title">Reports</h3>
    {/if}
    {#if errorText}
      <span class="cm-reports-note" role="alert">{errorText}</span>
    {:else if !isReportsPath(path)}
      <span class="cm-reports-note" role="status">Actual needs your budget file open in this browser. Open it below, and Reports appears here.</span>
    {/if}
  </div>
  <div class="cm-actual-slot" bind:this={slot} data-testid="cm-actual-slot"></div>
</div>

<style>
  .cm-reports-screen { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .cm-reports-head { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--cm-bg, Canvas); color: var(--cm-fg, CanvasText); border-bottom: 1px solid var(--cm-line, rgba(128, 128, 128, 0.25)); flex: none; pointer-events: auto; }
  .cm-title, .cm-title-select { margin: 0; font-size: 18px; font-weight: 600; }
  .cm-title-select { background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; padding: 4px 8px; max-width: 70%; }
  .cm-reports-note { font-size: 13px; opacity: 0.75; }
  .cm-actual-slot { flex: 1; min-height: 0; }
</style>
