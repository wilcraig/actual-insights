<script>
  import { saveSeries, stopSeries } from './chipmunk-api';
  import { seriesBody, parseAmountToCents, formatMoney, shiftMonth } from './logic';

  // Repeat a category's amount: N months, until a month, or every month, with
  // a dry-run review (each month's current and new amount) before anything is
  // written. `series` set = editing/stopping the category's existing series.
  let { category, series = null, month, currentMonth, onDone, onCancel } = $props();

  let amountText = $state(((series?.amount ?? category.budgeted) / 100).toFixed(2));
  let mode = $state(series?.mode ?? 'months');
  let months = $state(series?.months ?? 3);
  let untilMonth = $state(series?.untilMonth ?? shiftMonth(month, 2));
  let review = $state(null); // dry-run response
  let busy = $state(false);
  let errorText = $state('');
  let confirmStop = $state(false);

  // Existing series: the rewrite starts from the later of its start and now.
  const startMonth = $derived(series ? (series.startMonth < currentMonth ? currentMonth : series.startMonth) : month < currentMonth ? currentMonth : month);

  function body(dryRun) {
    const cents = parseAmountToCents(amountText);
    if (cents === null) return null;
    return seriesBody({ categoryId: category.id, amountCents: cents, startMonth, mode, months: Number(months), untilMonth, dryRun }, { isUpdate: !!series });
  }

  async function doReview() {
    errorText = '';
    const b = body(true);
    if (!b) {
      errorText = 'Enter an amount like 450.00.';
      return;
    }
    busy = true;
    try {
      review = await saveSeries(b, series?.id ?? null);
    } catch (err) {
      errorText = err.status === 409 ? 'This category already has a series. Edit it instead.' : err.status === 400 ? 'Those settings are not valid (check the months and dates).' : err.message;
    } finally {
      busy = false;
    }
  }

  async function confirm() {
    busy = true;
    errorText = '';
    try {
      await saveSeries(body(false), series?.id ?? null);
      onDone();
    } catch (err) {
      errorText = err.message;
    } finally {
      busy = false;
    }
  }

  async function stop() {
    busy = true;
    try {
      await stopSeries(series.id);
      onDone();
    } catch (err) {
      errorText = err.message;
      busy = false;
    }
  }
</script>

<div class="series-form" role="group" aria-label="Repeat {category.name}">
  <h4>{series ? 'Edit series' : 'Repeat'} &middot; {category.name}</h4>
  {#if !review}
    <label>Amount <input class="amount" inputmode="decimal" bind:value={amountText} /></label>
    <label>Repeat
      <select class="mode" bind:value={mode}>
        <option value="months">For a number of months</option>
        <option value="until">Until a month</option>
        <option value="indefinite">Every month</option>
      </select>
    </label>
    {#if mode === 'months'}<label>Months <input class="months" type="number" min="1" max="60" bind:value={months} /></label>{/if}
    {#if mode === 'until'}<label>Until <input class="until" type="month" bind:value={untilMonth} /></label>{/if}
    <p class="hint">Starts {startMonth}. Months already past are never changed.</p>
    <div class="buttons">
      <button type="button" class="review" disabled={busy} onclick={doReview}>Review</button>
      {#if series}<button type="button" class="stop" disabled={busy} onclick={() => (confirmStop = true)}>Stop series</button>{/if}
      <button type="button" class="cancel" onclick={onCancel}>Cancel</button>
    </div>
    {#if confirmStop}
      <p class="hint">Months the series already wrote keep their amounts. Nothing is written or removed after this.</p>
      <button type="button" class="stop-confirm" disabled={busy} onclick={stop}>Stop series</button>
      <button type="button" onclick={() => (confirmStop = false)}>Keep series</button>
    {/if}
  {:else}
    <p class="hint">{review.changes.length} month{review.changes.length === 1 ? '' : 's'} will be set to {formatMoney(review.changes[0]?.after ?? 0)}.</p>
    <table class="changes">
      <thead><tr><th>Month</th><th>Now</th><th>New</th></tr></thead>
      <tbody>{#each review.changes as c (c.month)}<tr><td>{c.month}</td><td>{formatMoney(c.before)}</td><td>{formatMoney(c.after)}</td></tr>{/each}</tbody>
    </table>
    <div class="buttons">
      <button type="button" class="confirm" disabled={busy} onclick={confirm}>Confirm</button>
      <button type="button" class="back" onclick={() => (review = null)}>Back</button>
    </div>
  {/if}
  {#if errorText}<p class="err" role="alert">{errorText}</p>{/if}
</div>

<style>
  .series-form { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 10px; margin: 6px 0; }
  h4 { margin: 0; }
  label { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  input, select { padding: 4px 8px; background: transparent; color: inherit; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: 6px; font: inherit; }
  .hint { margin: 0; font-size: 12px; opacity: 0.7; }
  .err { margin: 0; color: #dc2626; }
  .buttons { display: flex; gap: 8px; }
  button { border: 0; background: color-mix(in srgb, currentColor 10%, transparent); color: inherit; border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit; }
  .review, .confirm { background: color-mix(in srgb, var(--palette-chartQual1, #2563eb) 25%, transparent); }
  .stop, .stop-confirm { color: #dc2626; }
  .changes { width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; } th:first-child, td:first-child { text-align: left; }
</style>
