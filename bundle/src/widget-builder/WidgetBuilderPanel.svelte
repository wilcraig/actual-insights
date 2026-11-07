<script>
  import { onMount, tick } from 'svelte';
  import { isReportsPath, watchRoute } from './route-watcher';
  import { buildPlaceholder } from './placeholder';
  import { copyText } from './clipboard';
  import { WIDGET_REGISTRY } from './registry';
  import { describePickerError } from './picker-error';
  import { fetchApi } from '../api-client';
  import { visibleExpenseGroups } from '../widgets/pacing-data';
  import { moveEntry, checkedGroupIds } from './group-order';

  // Whether this is shown at all is controlled externally, by
  // mount-toolbar.js attaching/detaching this component's own container
  // next to Actual's own "Add new widget" button -- not by this flag.
  // `open` only toggles the dropdown panel below the toggle button.
  let open = $state(false);
  let selectedWidgetId = $state(WIDGET_REGISTRY[0]?.id ?? '');
  let values = $state({});
  let pickerData = $state({});
  let pickerErrors = $state({});
  let filterText = $state({});
  let generatedText = $state('');
  let copyStatus = $state('');
  let generatedTextarea = $state(null);
  // Pacing bars' "Category Groups" list: rows of { id, name, checked } in the
  // order the user arranges them; null until loaded.
  let groupRows = $state(null);
  let groupError = $state('');

  async function loadGroupRows() {
    groupError = '';
    groupRows = null;
    try {
      const response = await fetchApi('/api/category-groups');
      const error = describePickerError(response);
      if (error) {
        groupError = error;
        return;
      }
      const data = await response.json();
      if (!Array.isArray(data.groups)) {
        groupError = describePickerError({ ok: false, status: response.status });
        return;
      }
      groupRows = visibleExpenseGroups(data.groups).map((g) => ({ id: g.id, name: g.name, checked: true }));
    } catch {
      groupError = describePickerError(null);
    }
  }

  function setAllGroups(checked) {
    values = { ...values, allGroups: checked };
    if (checked && groupRows === null && !groupError) loadGroupRows();
  }

  let showGroupList = $derived(selectedWidget?.id === 'pacing-bars' && values.allGroups === true);

  let selectedWidget = $derived(
    WIDGET_REGISTRY.find((widget) => widget.id === selectedWidgetId) ?? null,
  );

  onMount(() => {
    // Closes the dropdown if the user navigates away from Reports while it
    // was open, so it doesn't reappear already-open next time.
    const unwatch = watchRoute(window, (pathname) => {
      if (!isReportsPath(pathname)) open = false;
    });

    if (selectedWidgetId) {
      selectWidget(selectedWidgetId);
    }

    return unwatch;
  });

  function isPickerField(field) {
    return field.type === 'category-multiselect'
      || field.type === 'account-multiselect'
      || field.type === 'group-multiselect';
  }

  // path/responseKey per picker field type -- group-multiselect fetches from
  // the dedicated /api/category-groups endpoint rather than deriving groups
  // from /api/categories' flattened groupName (that route drops hidden
  // groups and the hidden flag itself, so a client-side dedup can't tell a
  // hidden group apart from one that doesn't exist).
  const PICKER_SOURCES = {
    'category-multiselect': { path: '/api/categories', responseKey: 'categories' },
    'account-multiselect': { path: '/api/accounts', responseKey: 'accounts' },
    'group-multiselect': { path: '/api/category-groups', responseKey: 'groups' },
  };

  async function loadPickerData(field) {
    pickerErrors = { ...pickerErrors, [field.key]: null };
    pickerData = { ...pickerData, [field.key]: null };

    const { path, responseKey } = PICKER_SOURCES[field.type];

    let response = null;
    try {
      response = await fetchApi(path);
      const error = describePickerError(response);
      if (error) {
        pickerErrors = { ...pickerErrors, [field.key]: error };
        return;
      }
      const data = await response.json();
      const list = data[responseKey];
      if (!Array.isArray(list)) {
        // Malformed response body (200 but no usable array) - treat it the
        // same as a non-ok response so the UI shows an error instead of
        // sitting on "Loading…" forever.
        pickerErrors = {
          ...pickerErrors,
          [field.key]: describePickerError({ ok: false, status: response.status }),
        };
        return;
      }
      pickerData = { ...pickerData, [field.key]: list };
    } catch {
      pickerErrors = { ...pickerErrors, [field.key]: describePickerError(null) };
    }
  }

  // Refetches a field's picker data if it previously failed, or hasn't
  // loaded yet. Skips fields that already have data so reopening the panel
  // doesn't needlessly re-fetch everything.
  function refreshPickerDataIfNeeded() {
    if (!selectedWidget) return;
    for (const field of selectedWidget.fields) {
      if (!isPickerField(field)) continue;
      const hasData = Array.isArray(pickerData[field.key]);
      const hasError = Boolean(pickerErrors[field.key]);
      if (!hasData || hasError) {
        loadPickerData(field);
      }
    }
  }

  function selectWidget(widgetId) {
    selectedWidgetId = widgetId;
    values = {};
    filterText = {};
    generatedText = '';
    copyStatus = '';
    groupRows = null;
    groupError = '';

    const widget = WIDGET_REGISTRY.find((w) => w.id === widgetId);
    if (!widget) return;

    for (const field of widget.fields) {
      if (isPickerField(field)) {
        values[field.key] = [];
        loadPickerData(field);
      } else if (field.type === 'checkbox') {
        values[field.key] = false;
      } else if (field.type === 'select') {
        // Defaults to its first option rather than left unset, so a
        // single-choice field never blocks canGenerate the way an
        // empty multiselect does.
        values[field.key] = field.options[0]?.value ?? '';
      }
    }
  }

  function toggleOpen() {
    open = !open;
    if (open) {
      refreshPickerDataIfNeeded();
    }
  }

  function toggleOption(fieldKey, optionId) {
    const current = values[fieldKey] ?? [];
    values[fieldKey] = current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId];
  }

  function filteredOptions(field) {
    const options = pickerData[field.key] ?? [];
    const query = (filterText[field.key] ?? '').trim().toLowerCase();
    if (!query) return options;
    return options.filter((option) => {
      const name = (option.name ?? '').toLowerCase();
      const groupName = (option.groupName ?? '').toLowerCase();
      return name.includes(query) || groupName.includes(query);
    });
  }

  // A widget with fields can't be generated with nothing selected for any
  // of them - that's the empty-placeholder pain point this feature exists
  // to prevent. A widget with no fields has nothing to select, so it's
  // always generatable.
  let canGenerate = $derived.by(() => {
    if (!selectedWidget) return false;
    if (selectedWidget.fields.length === 0) return true;
    // Category Groups ticked: needs a checked group or a picked category.
    if (showGroupList) {
      return (groupRows ?? []).some((row) => row.checked) || (values.categoryIds ?? []).length > 0;
    }
    return selectedWidget.fields.every(
      (field) => field.optional
        || field.type === 'checkbox'
        || (field.optionalWhen && values[field.optionalWhen] === true)
        || (values[field.key] ?? []).length > 0,
    );
  });

  async function handleGenerate() {
    if (!selectedWidget || !canGenerate) return;
    const finalValues = showGroupList && groupRows ? { ...values, groupIds: checkedGroupIds(groupRows) } : values;
    generatedText = buildPlaceholder(selectedWidget.id, selectedWidget.fields, finalValues, selectedWidget.toBody);
    copyStatus = '';
    // Select the textarea's contents immediately so Ctrl/Cmd+C works as a
    // fallback alongside the Copy button, without requiring a manual click.
    // Wait a tick so the textarea's value has actually been updated to the
    // newly generated text before selecting it.
    await tick();
    generatedTextarea?.select();
  }

  async function handleCopy() {
    const ok = await copyText(generatedText);
    copyStatus = ok ? 'Copied' : 'Copy failed — select the text above';
  }
</script>

<div class="actualmint-widget-builder">
    <button type="button" class="actualmint-wb-toggle" onclick={toggleOpen}>
      {open ? 'Close widget builder' : 'Widget builder'}
    </button>

    {#if open}
      <div class="actualmint-wb-panel">
        <label class="actualmint-wb-field">
          Widget
          <select
            value={selectedWidgetId}
            onchange={(e) => selectWidget(e.target.value)}
          >
            {#each WIDGET_REGISTRY as widget (widget.id)}
              <option value={widget.id}>{widget.label}</option>
            {/each}
          </select>
        </label>

        {#if selectedWidget}
          {#each selectedWidget.fields as field (field.key)}
            <div class="actualmint-wb-field">
              {#if field.type === 'checkbox'}
                <label class="actualmint-wb-checkbox">
                  <input
                    type="checkbox"
                    checked={values[field.key] === true}
                    onchange={(e) => (field.key === 'allGroups' ? setAllGroups(e.target.checked) : (values = { ...values, [field.key]: e.target.checked }))}
                  />
                  <span class="actualmint-wb-field-label">{field.label}</span>
                </label>
                {#if field.help}<p class="actualmint-wb-help">{field.help}</p>{/if}
              {:else}
              <span class="actualmint-wb-field-label">{field.label}</span>
              {#if field.type === 'select'}
                <select
                  value={values[field.key]}
                  onchange={(e) => { values = { ...values, [field.key]: e.target.value }; }}
                >
                  {#each field.options as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else if pickerErrors[field.key]}
                <p class="actualmint-wb-error" role="alert">{pickerErrors[field.key]}</p>
              {:else if pickerData[field.key] === null || pickerData[field.key] === undefined}
                <p class="actualmint-wb-loading">Loading…</p>
              {:else}
                <input
                  type="text"
                  class="actualmint-wb-filter"
                  placeholder="Filter…"
                  value={filterText[field.key] ?? ''}
                  oninput={(e) => { filterText = { ...filterText, [field.key]: e.target.value }; }}
                />
                <ul class="actualmint-wb-options">
                  {#each filteredOptions(field) as option (option.id)}
                    <li>
                      <label>
                        <input
                          type="checkbox"
                          checked={(values[field.key] ?? []).includes(option.id)}
                          onchange={() => toggleOption(field.key, option.id)}
                        />
                        {option.name}{option.groupName ? ` (${option.groupName})` : ''}
                      </label>
                    </li>
                  {/each}
                </ul>
              {/if}
              {/if}
            </div>
          {/each}

          {#if showGroupList}
            <div class="actualmint-wb-field actualmint-wb-groups">
              <span class="actualmint-wb-field-label">Groups to show, in order</span>
              {#if groupError}
                <p class="actualmint-wb-error" role="alert">{groupError}</p>
              {:else if groupRows === null}
                <p class="actualmint-wb-loading">Loading…</p>
              {:else}
                <ul class="actualmint-wb-options actualmint-wb-group-list">
                  {#each groupRows as row, index (row.id)}
                    <li class="actualmint-wb-group-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={row.checked}
                          aria-label={`Show ${row.name}`}
                          onchange={(e) => { groupRows = groupRows.map((r) => (r.id === row.id ? { ...r, checked: e.target.checked } : r)); }}
                        />
                        {row.name}
                      </label>
                      <button
                        type="button"
                        class="actualmint-wb-move"
                        aria-label={`Move ${row.name} up`}
                        disabled={index === 0}
                        onclick={() => { groupRows = moveEntry(groupRows, index, -1); }}
                      >&uarr;</button>
                      <button
                        type="button"
                        class="actualmint-wb-move"
                        aria-label={`Move ${row.name} down`}
                        disabled={index === groupRows.length - 1}
                        onclick={() => { groupRows = moveEntry(groupRows, index, 1); }}
                      >&darr;</button>
                    </li>
                  {/each}
                </ul>
                <p class="actualmint-wb-help">Groups created later will not appear until the widget is regenerated.</p>
              {/if}
            </div>
          {/if}
        {/if}

        <button
          type="button"
          class="actualmint-wb-generate"
          onclick={handleGenerate}
          disabled={!canGenerate}
        >
          Generate
        </button>

        <div class="actualmint-wb-output">
          <!--
            The generated placeholder must stay inside a form control's
            `.value` (never rendered as plain text content): mount.js scans
            the whole document.body for placeholder-shaped text nodes, so
            showing this string as visible text would make the panel's own
            output get mistakenly picked up and mounted as a live widget.
          -->
          <textarea
            class="actualmint-wb-textarea"
            readonly
            value={generatedText}
            bind:this={generatedTextarea}
            onclick={(e) => e.target.select()}
          ></textarea>
          <button type="button" class="actualmint-wb-copy" onclick={handleCopy} disabled={!generatedText}>
            Copy
          </button>
          {#if copyStatus}
            <span class="actualmint-wb-copy-status">{copyStatus}</span>
          {/if}
        </div>
      </div>
    {/if}
</div>

<style>
  .actualmint-widget-builder {
    /* A normal inline sibling of Actual's own "Add new widget" button
       (see mount-toolbar.js), not a fixed overlay -- `position: relative`
       only to anchor the dropdown panel below it (position: absolute). */
    position: relative;
    display: inline-block;
    margin-left: 0.5rem;
    z-index: 10;
    font-family: inherit;
    font-size: 0.9rem;
  }

  /* Styled as a plain secondary toolbar button (matching Actual's own
     "Edit dashboard" button next to it) now that this sits inline in the
     toolbar instead of floating as its own dark pill. */
  .actualmint-wb-toggle {
    cursor: pointer;
    padding: 0.5rem 1rem;
    border-radius: 0.25rem;
    border: 1px solid var(--color-buttonNormalBorder, #ccc);
    background: var(--color-buttonNormalBackground, #fff);
    color: var(--color-buttonNormalText, #222);
    font: inherit;
  }

  .actualmint-wb-panel {
    /* Anchored to the wrapper's own right edge (flush with the toggle
       button, since the wrapper's width is just that button) rather than
       left-aligned in normal flow -- the toggle sits wherever "Add new
       widget" happens to be (often near the right edge of the toolbar), so
       a left-aligned, fixed-width panel can run off the right edge of the
       viewport. Growing left from a right anchor instead keeps it on
       screen regardless of the button's own position. */
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 0.5rem;
    width: 20rem;
    max-height: 28rem;
    overflow-y: auto;
    padding: 1rem;
    border-radius: 0.5rem;
    background: #fff;
    color: #111;
    border: 1px solid #ccc;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .actualmint-wb-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .actualmint-wb-field-label {
    font-weight: 600;
  }

  .actualmint-wb-checkbox {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .actualmint-wb-help {
    margin: 0;
    font-size: 0.8rem;
    color: #555;
  }

  .actualmint-wb-group-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .actualmint-wb-group-row label {
    flex: 1;
  }

  .actualmint-wb-move {
    cursor: pointer;
    padding: 0 0.4rem;
  }

  .actualmint-wb-filter {
    box-sizing: border-box;
    width: 100%;
  }

  .actualmint-wb-options {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 10rem;
    overflow-y: auto;
  }

  .actualmint-wb-error {
    color: #b91c1c;
  }

  .actualmint-wb-loading {
    color: #555;
  }

  .actualmint-wb-output {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .actualmint-wb-textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 4rem;
    font-family: monospace;
    font-size: 0.8rem;
  }

  .actualmint-wb-copy-status {
    font-size: 0.8rem;
    color: #555;
  }
</style>
