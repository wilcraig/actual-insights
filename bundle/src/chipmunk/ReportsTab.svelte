<script>
  import { onMount } from 'svelte';
  import { getReportList, getReports } from './chipmunk-api';
  import { effectiveReport, loadReportChoice, saveReportChoice } from './logic';
  import ReportCard from './ReportCard.svelte';

  // The phone's Home: the report's title is a dropdown of every dashboard page
  // and saved report; cards come in the server's order. The pick is remembered.
  let list = $state(null);
  let reportId = $state(null);
  let cards = $state([]);
  let status = $state('loading'); // loading | ready | error
  let errorText = $state('');
  let monthCards = $state({}); // card id -> the card for the month picked on it
  let busy = $state({});
  let monthErrors = $state({});
  let ticket = 0;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  function storage() {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }

  async function load(id) {
    const mine = ++ticket;
    status = 'loading';
    monthCards = {};
    monthErrors = {};
    try {
      const r = await getReports({ report: id ?? undefined });
      if (mine !== ticket) return;
      cards = r.cards ?? [];
      status = 'ready';
    } catch (err) {
      if (mine !== ticket) return;
      errorText = err.message;
      status = 'error';
    }
  }

  async function start() {
    try {
      list = await getReportList();
    } catch (err) {
      errorText = err.message;
      status = 'error';
      return;
    }
    const s = storage();
    reportId = effectiveReport(list, reportId, s ? loadReportChoice(s) : null);
    await load(reportId);
  }

  function pick(event) {
    reportId = event.target.value;
    const s = storage();
    if (s) saveReportChoice(s, reportId);
    load(reportId);
  }

  async function showMonth(card, month) {
    const id = card.id;
    monthErrors = { ...monthErrors, [id]: '' };
    busy = { ...busy, [id]: true };
    try {
      const r = await getReports({ report: reportId ?? undefined, month });
      const next = (r.cards ?? []).find((c) => c.id === id && c.monthNav?.month === month);
      if (!next) throw new Error('That month is not available.');
      monthCards = { ...monthCards, [id]: next };
    } catch (err) {
      monthErrors = { ...monthErrors, [id]: err.message };
    } finally {
      busy = { ...busy, [id]: false };
    }
  }

  onMount(start);
</script>

<div class="reports-tab">
  <div class="title-row">
    {#if list && list.reports.length > 0}
      <select class="title-select" aria-label="Report" value={reportId} onchange={pick}>
        {#each list.reports as r (r.id)}<option value={r.id}>{r.title}</option>{/each}
      </select>
    {:else}
      <h3 class="title">Reports</h3>
    {/if}
    <button type="button" class="refresh" onclick={() => load(reportId)}>Refresh</button>
  </div>

  {#if status === 'loading'}
    <p class="note">Loading&hellip;</p>
  {:else if status === 'error'}
    <p class="note err" role="alert">{errorText}</p>
  {:else if cards.length === 0}
    <p class="note">No reports yet. Add widgets to a dashboard page in Actual's Reports.</p>
  {:else}
    {#each cards as card (card.id)}
      <ReportCard card={monthCards[card.id] ?? card} {currentMonth} busy={!!busy[card.id]} error={monthErrors[card.id] ?? ''} onMonth={showMonth} />
    {/each}
  {/if}
</div>

<style>
  .reports-tab { display: flex; flex-direction: column; gap: 12px; }
  .title-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .title, .title-select { margin: 0; font-size: 18px; font-weight: 600; }
  .title-select { background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px; padding: 4px 8px; max-width: 70%; }
  .refresh { border: 0; background: color-mix(in srgb, currentColor 10%, transparent); color: inherit; border-radius: 999px; padding: 4px 12px; cursor: pointer; }
  .note { opacity: 0.75; margin: 0; }
  .err { color: #dc2626; opacity: 1; }
</style>
