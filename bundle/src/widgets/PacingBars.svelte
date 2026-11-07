<script>
  import { mount, unmount } from 'svelte';
  import { computeBarState, collectCategoryIds, buildPacingRows, buildPacingItems } from './pacing-data';
  import { fetchApi } from '../api-client';
  import CategoryBreakdownModal from './CategoryBreakdownModal.svelte';

  // Each entry is either a plain category id string (its own bar) or a
  // rollup object `{ title, budgets: [categoryId, ...] }` that combines
  // several categories' spent/available amounts into one bar labeled
  // `title` -- see buildPacingRows in pacing-data.js for the shaping logic.
  //
  // With `allGroups`, one rollup per visible expense category group is built
  // from /api/category-groups and put in front of `items` (see
  // buildPacingItems), so a group added later shows up by itself -- unless
  // `groupIds` pins exactly which groups to show, and in what order.
  let { items = [], allGroups = false, groupIds = undefined } = $props();

  let rows = $state(null);
  let errorMessage = $state(null);

  // The modal is mounted imperatively onto `document.body` -- not rendered
  // inline in this component's own tree -- so its `position: fixed`
  // backdrop is never a descendant of a `transform`-ed ancestor (Actual's
  // Reports page positions each widget's grid-item with a CSS transform via
  // react-grid-layout, which per spec becomes the containing block for any
  // `position: fixed` descendant, confining an inline-rendered backdrop to
  // the widget's own box instead of the real viewport).
  let modalInstance = null;

  function openBreakdown(category) {
    if (modalInstance) {
      unmount(modalInstance);
      modalInstance = null;
    }

    modalInstance = mount(CategoryBreakdownModal, {
      target: document.body,
      props: {
        categoryId: category.id,
        categoryName: category.name,
        groupId: category.groupId,
        groupName: category.groupName,
        onClose: closeBreakdown,
      },
    });
  }

  function openRollupBreakdown(row) {
    if (modalInstance) {
      unmount(modalInstance);
      modalInstance = null;
    }

    modalInstance = mount(CategoryBreakdownModal, {
      target: document.body,
      props: {
        categoryIds: row.memberIds,
        rollupTitle: row.name,
        onClose: closeBreakdown,
      },
    });
  }

  function closeBreakdown() {
    if (modalInstance) {
      unmount(modalInstance);
      modalInstance = null;
    }
  }

  function currentMonth() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  async function load() {
    errorMessage = null;
    rows = null;

    try {
      const month = currentMonth();
      let effectiveItems = items;
      if (allGroups) {
        const groupsResponse = await fetchApi('/api/category-groups');
        if (!groupsResponse.ok) {
          errorMessage = `Category groups unavailable (${groupsResponse.status})`;
          return;
        }
        const { groups } = await groupsResponse.json();
        effectiveItems = buildPacingItems({ items, allGroups, groupIds }, groups);
      }
      const params = new URLSearchParams({ month, categories: collectCategoryIds(effectiveItems).join(',') });
      const response = await fetchApi(`/api/budget-pacing?${params}`);

      if (!response.ok) {
        errorMessage = `Pacing data unavailable (${response.status})`;
        return;
      }

      const data = await response.json();
      rows = buildPacingRows(effectiveItems, data.categories).map((row) => ({
        ...row,
        bar: computeBarState(
          { budgeted: row.budgeted, spent: row.spent },
          { daysElapsed: data.daysElapsed, daysInMonth: data.daysInMonth },
        ),
      }));
    } catch (err) {
      errorMessage = 'Pacing data unavailable: could not reach insights-api.';
    }
  }

  load();

  function formatCents(cents) {
    return (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }
</script>

<!-- Shared bar markup for both row kinds -- a single-category row opens
     the modal scoped to that one category, a rollup row opens it scoped
     to the rollup's whole member-category list (see openRollupBreakdown). -->
{#snippet barContent(row)}
  <div class="pacing-row-header">
    <span class="pacing-name">{row.name}</span>
    <span class="pacing-amounts">
      {formatCents(row.spent)} / {formatCents(row.budgeted)}
    </span>
  </div>
  <div class="pacing-track">
    <div
      class="pacing-fill pacing-fill--{row.bar.status}"
      style:width="{row.bar.fillPct}%"
    ></div>
    <div class="pacing-tick" style:left="{row.bar.tickPct}%"></div>
  </div>
{/snippet}

<div class="actualmint-pacing-bars">
  {#if errorMessage}
    <p class="pacing-error" role="alert">{errorMessage}</p>
  {:else if rows === null}
    <p class="pacing-loading">Loading budget pacing…</p>
  {:else if rows.length === 0}
    <p class="pacing-empty">No pacing categories to show.</p>
  {:else}
    {#each rows as row (row.id)}
      {#if row.kind === 'category'}
        <button type="button" class="pacing-row" onclick={() => openBreakdown(row)}>
          {@render barContent(row)}
        </button>
      {:else}
        <button type="button" class="pacing-row pacing-row--rollup" onclick={() => openRollupBreakdown(row)}>
          {@render barContent(row)}
        </button>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .actualmint-pacing-bars {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
    box-sizing: border-box;
    font-family: inherit;
    /* Establishes this widget's own box (not the viewport) as the sizing
       context for the @container query below, since it's mounted into a
       host element of unpredictable width inside an Actual report page. */
    container-type: inline-size;
  }

  .pacing-error {
    color: #b91c1c;
    font-weight: 600;
  }

  .pacing-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    /* Reset <button> defaults so this keeps looking like the plain row it
       was before becoming keyboard-accessible (button semantics). */
    background: none;
    border: none;
    padding: 0;
    margin: 0;
    font: inherit;
    color: inherit;
    text-align: inherit;
    cursor: pointer;
  }

  .pacing-row-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.85rem;
  }

  .pacing-name {
    font-weight: 600;
  }

  .pacing-amounts {
    color: #555;
  }

  .pacing-track {
    position: relative;
    width: 100%;
    height: 0.9rem;
    background: #e5e7eb;
    border-radius: 0.25rem;
    overflow: visible;
  }

  .pacing-fill {
    position: absolute;
    inset: 0 auto 0 0;
    height: 100%;
    border-radius: 0.25rem;
    max-width: 100%;
    transition: width 0.2s ease;
  }

  .pacing-fill--under {
    background: #22c55e;
  }

  .pacing-fill--near {
    background: #f59e0b;
  }

  .pacing-fill--over {
    background: #ef4444;
  }

  .pacing-tick {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 2px;
    background: #000;
    transform: translateX(-1px);
  }

  /* Narrow (phone-width) containers: stack amounts under the category
     name instead of letting them squeeze onto one tight line. */
  @container (max-width: 480px) {
    .pacing-row-header {
      flex-direction: column;
    }
  }
</style>
