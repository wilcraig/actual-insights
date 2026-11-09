<script>
  import { onMount, tick } from 'svelte';
  import { WIDGET_REGISTRY } from './registry';
  import { metaFor } from './widget-meta';
  import { describePickerError } from './picker-error';
  import { fetchApi } from '../api-client';
  import { visibleExpenseGroups } from '../widgets/pacing-data';
  import { moveEntry } from './group-order';
  import { copyText } from './clipboard';
  import { mountPreview } from './preview';
  import {
    PICKER_SOURCES,
    isPickerField,
    defaultValues,
    showsGroupList,
    isComplete,
    configFor,
    placeholderFor,
  } from './builder-state';
  import {
    actualApi,
    addTextWidget,
    countText,
    dashboardIdFromPath,
    refreshUntilVisible,
  } from './add-to-dashboard';
  import {
    applyGroupIds,
    locateDashboardWidget,
    saveWidgetText,
    valuesFromBody,
  } from './edit-widget';

  // The full-screen widget builder: the form on the left, the real widget
  // rendering live on the right. `initial` opens it on an existing widget
  // (edit mode); `onclose` is called to dismiss it (controller.js destroys it).
  let { initial = null, onclose = () => {} } = $props();

  const editing = initial !== null;
  const firstWidgetId = WIDGET_REGISTRY.some((w) => w.id === initial?.widgetId)
    ? initial.widgetId
    : (WIDGET_REGISTRY[0]?.id ?? '');

  let selectedWidgetId = $state(firstWidgetId);
  let values = $state({});
  let pickerData = $state({});
  let pickerErrors = $state({});
  let filterText = $state({});
  // Pacing bars' "Category Groups" list: rows of { id, name, checked } in the
  // order the user arranges them; null until loaded.
  let groupRows = $state(null);
  let groupError = $state('');
  let status = $state('');
  let statusKind = $state('info');
  let busy = $state(false);
  let needsReload = $state(false);
  let dialogEl = $state(null);
  let previewHost = $state(null);

  let widget = $derived(WIDGET_REGISTRY.find((w) => w.id === selectedWidgetId) ?? null);
  let meta = $derived(metaFor(selectedWidgetId));
  let groupListShown = $derived(showsGroupList(widget, values));
  let complete = $derived(isComplete(widget, values, groupRows));
  let built = $derived(configFor(widget, values, groupRows));
  let text = $derived(placeholderFor(widget, values, groupRows));
  // Changes only when the widget or its parsed config does, so unrelated
  // state (filters, status text) never re-renders the preview.
  let previewKey = $derived(built ? JSON.stringify([widget.id, built.body ?? null]) : '');

  async function loadGroupRows(savedGroupIds = null) {
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
      const rows = visibleExpenseGroups(data.groups).map((g) => ({ id: g.id, name: g.name, checked: true }));
      groupRows = savedGroupIds ? applyGroupIds(rows, savedGroupIds) : rows;
    } catch {
      groupError = describePickerError(null);
    }
  }

  function setAllGroups(checked) {
    values = { ...values, allGroups: checked };
    if (checked && groupRows === null && !groupError) loadGroupRows();
  }

  async function loadPickerData(field) {
    pickerErrors = { ...pickerErrors, [field.key]: null };
    pickerData = { ...pickerData, [field.key]: null };
    const { path, responseKey } = PICKER_SOURCES[field.type];
    try {
      const response = await fetchApi(path);
      const error = describePickerError(response);
      if (error) {
        pickerErrors = { ...pickerErrors, [field.key]: error };
        return;
      }
      const data = await response.json();
      const list = data[responseKey];
      if (!Array.isArray(list)) {
        // A 200 with no usable array reads as a failure, not an endless "Loading…".
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

  // Switches to a widget, starting its form from `start` (the saved form when
  // editing) or its defaults.
  function selectWidget(widgetId, start = null) {
    selectedWidgetId = widgetId;
    const next = WIDGET_REGISTRY.find((w) => w.id === widgetId);
    filterText = {};
    groupRows = null;
    groupError = '';
    status = '';
    needsReload = false;
    if (!next) {
      values = {};
      return;
    }
    values = { ...defaultValues(next), ...(start?.values ?? {}) };
    for (const field of next.fields) {
      if (isPickerField(field)) loadPickerData(field);
    }
    if (showsGroupList(next, values)) loadGroupRows(start?.groupIds ?? null);
  }

  function selectedLabels(field) {
    return (values[field.key] ?? []).length;
  }

  function toggleOption(fieldKey, optionId) {
    const current = values[fieldKey] ?? [];
    values = {
      ...values,
      [fieldKey]: current.includes(optionId) ? current.filter((id) => id !== optionId) : [...current, optionId],
    };
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

  function selectShown(field) {
    const shown = filteredOptions(field).map((option) => option.id);
    values = { ...values, [field.key]: [...new Set([...(values[field.key] ?? []), ...shown])] };
  }

  function clearSelection(field) {
    values = { ...values, [field.key]: [] };
  }

  function say(message, kind = 'info') {
    status = message;
    statusKind = kind;
  }

  async function handleCopy() {
    if (!text) return;
    say((await copyText(text)) ? 'Copied the widget text.' : 'Copy failed. Open "Widget text" below and select it.', 'info');
  }

  async function afterWrite(wrote, successMessage) {
    const seen = await refreshUntilVisible({ doc: document, win: window, text, before: wrote.before });
    if (seen) {
      onclose();
      return;
    }
    needsReload = true;
    say(`${successMessage} If it doesn't appear, reload the page.`, 'ok');
  }

  async function handleAdd() {
    if (!complete || busy) return;
    const api = actualApi(window);
    const dashboardId = dashboardIdFromPath(window.location.pathname);
    if (!api || !dashboardId) {
      say('Open a dashboard and try again, or use Copy widget text and paste it into a Text widget yourself.', 'error');
      return;
    }
    busy = true;
    say('Adding to your dashboard…');
    try {
      const before = countText(document, text);
      await addTextWidget({ send: api.send, dashboardId, text, size: meta.size });
      await afterWrite({ before }, 'Added to your dashboard.');
    } catch {
      say('Actual would not add the widget. Use Copy widget text instead.', 'error');
    } finally {
      busy = false;
    }
  }

  async function handleSave() {
    if (!complete || busy || !editing) return;
    const api = actualApi(window);
    const dashboardId = dashboardIdFromPath(window.location.pathname);
    if (!api || !dashboardId) {
      say('Open the dashboard and try again, or use Copy widget text.', 'error');
      return;
    }
    busy = true;
    say('Saving…');
    try {
      const found = await locateDashboardWidget({ query: api.query, q: api.q, dashboardId, raw: initial.raw });
      if (!found) {
        say('Could not find this widget on the dashboard. Use Copy widget text instead.', 'error');
        return;
      }
      const before = countText(document, text);
      await saveWidgetText({ send: api.send, widget: found, raw: initial.raw, newText: text });
      await afterWrite({ before }, 'Saved.');
    } catch {
      say('Actual would not save the widget. Use Copy widget text instead.', 'error');
    } finally {
      busy = false;
    }
  }

  function onKeydown(event) {
    // Keep Actual's own shortcuts from firing while typing in the dialog.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose();
      return;
    }
    if (event.key !== 'Tab' || !dialogEl) return;
    const focusable = [...dialogEl.querySelectorAll('button, select, input, textarea, summary, [href]')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMount(() => {
    if (editing) {
      const start = valuesFromBody(WIDGET_REGISTRY.find((w) => w.id === firstWidgetId), initial.body);
      selectWidget(firstWidgetId, start);
    } else {
      selectWidget(firstWidgetId);
    }
    tick().then(() => dialogEl?.querySelector('select')?.focus());
  });

  // Live preview: draw the real widget with the current config, a moment after
  // the last change so typing and clicking stay snappy.
  $effect(() => {
    const key = previewKey;
    const host = previewHost;
    if (!host || !key) return undefined;
    const [id, body] = JSON.parse(key);
    let teardown = () => {};
    const timer = setTimeout(() => {
      teardown = mountPreview(host, id, body);
    }, 250);
    return () => {
      clearTimeout(timer);
      teardown();
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="insights-wb-overlay" role="presentation" onkeydown={onKeydown}>
  <div
    class="insights-wb-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="insights-wb-title"
    bind:this={dialogEl}
  >
    <header class="insights-wb-header">
      <h2 id="insights-wb-title">{editing ? 'Edit widget' : 'Widget builder'}</h2>
      <button type="button" class="insights-wb-close" aria-label="Close widget builder" onclick={onclose}>✕</button>
    </header>

    <div class="insights-wb-body">
      <section class="insights-wb-config" aria-label="Widget options">
        <label class="insights-wb-field">
          <span class="insights-wb-label">Widget</span>
          <select value={selectedWidgetId} onchange={(e) => selectWidget(e.target.value)}>
            {#each WIDGET_REGISTRY as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
          {#if meta.description}<span class="insights-wb-help">{meta.description}</span>{/if}
        </label>

        {#if widget}
          {#each widget.fields as field (field.key)}
            <div class="insights-wb-field">
              {#if field.type === 'checkbox'}
                <label class="insights-wb-check">
                  <input
                    type="checkbox"
                    checked={values[field.key] === true}
                    onchange={(e) => (field.key === 'allGroups' ? setAllGroups(e.target.checked) : (values = { ...values, [field.key]: e.target.checked }))}
                  />
                  <span class="insights-wb-label">{field.label}</span>
                </label>
                {#if field.help}<span class="insights-wb-help">{field.help}</span>{/if}
              {:else if field.type === 'select'}
                <label class="insights-wb-field-inner">
                  <span class="insights-wb-label">{field.label}</span>
                  <select value={values[field.key]} onchange={(e) => { values = { ...values, [field.key]: e.target.value }; }}>
                    {#each field.options as option (option.value)}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  </select>
                </label>
              {:else}
                <div class="insights-wb-picker-head">
                  <span class="insights-wb-label">{field.label}</span>
                  <span class="insights-wb-count">
                    {selectedLabels(field) > 0 ? `${selectedLabels(field)} selected` : field.optional || (field.optionalWhen && values[field.optionalWhen]) ? 'none = all' : 'none selected'}
                  </span>
                </div>
                {#if pickerErrors[field.key]}
                  <p class="insights-wb-error" role="alert">{pickerErrors[field.key]}</p>
                {:else if pickerData[field.key] === null || pickerData[field.key] === undefined}
                  <p class="insights-wb-muted">Loading…</p>
                {:else}
                  <input
                    type="text"
                    class="insights-wb-filter"
                    placeholder="Filter…"
                    aria-label={`Filter ${field.label}`}
                    value={filterText[field.key] ?? ''}
                    oninput={(e) => { filterText = { ...filterText, [field.key]: e.target.value }; }}
                  />
                  <div class="insights-wb-picker-actions">
                    <button type="button" class="insights-wb-link" onclick={() => selectShown(field)}>Select shown</button>
                    <button type="button" class="insights-wb-link" onclick={() => clearSelection(field)}>Clear</button>
                  </div>
                  <ul class="insights-wb-options">
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

          {#if groupListShown}
            <div class="insights-wb-field">
              <span class="insights-wb-label">Groups to show, in order</span>
              {#if groupError}
                <p class="insights-wb-error" role="alert">{groupError}</p>
              {:else if groupRows === null}
                <p class="insights-wb-muted">Loading…</p>
              {:else}
                <ul class="insights-wb-options insights-wb-group-list">
                  {#each groupRows as row, index (row.id)}
                    <li class="insights-wb-group-row">
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
                        class="insights-wb-move"
                        aria-label={`Move ${row.name} up`}
                        disabled={index === 0}
                        onclick={() => { groupRows = moveEntry(groupRows, index, -1); }}
                      >↑</button>
                      <button
                        type="button"
                        class="insights-wb-move"
                        aria-label={`Move ${row.name} down`}
                        disabled={index === groupRows.length - 1}
                        onclick={() => { groupRows = moveEntry(groupRows, index, 1); }}
                      >↓</button>
                    </li>
                  {/each}
                </ul>
                <span class="insights-wb-help">Groups created later will not appear until the widget is edited.</span>
              {/if}
            </div>
          {/if}
        {/if}

        <details class="insights-wb-text">
          <summary>Widget text</summary>
          <!--
            Must stay inside a form control's `.value` (never plain text
            content): mount.js scans the whole page for placeholder-shaped
            text nodes, so showing this string as visible text would make the
            builder's own output get picked up and mounted as a live widget.
          -->
          <textarea class="insights-wb-textarea" readonly value={text} onclick={(e) => e.target.select()}></textarea>
        </details>
      </section>

      <section class="insights-wb-preview" aria-label="Preview">
        <div class="insights-wb-preview-title">
          <span>Preview</span>
          <span class="insights-wb-muted">Updates as you change options</span>
        </div>
        <div class="insights-wb-preview-stage">
          <div class="insights-wb-card" style={`width: ${meta.size.w <= 4 ? 'min(100%, 26rem)' : meta.size.w <= 6 ? 'min(100%, 40rem)' : '100%'}`}>
            {#if !built}
              <p class="insights-wb-hint">Pick at least one option on the left to see the widget.</p>
            {/if}
            <div class="insights-wb-preview-host" bind:this={previewHost} hidden={!built}></div>
          </div>
        </div>
      </section>
    </div>

    <footer class="insights-wb-footer">
      <p class={`insights-wb-status insights-wb-status-${statusKind}`} role="status" aria-live="polite">{status}</p>
      <div class="insights-wb-actions">
        {#if needsReload}
          <button type="button" class="insights-wb-btn" onclick={() => window.location.reload()}>Reload page</button>
        {/if}
        <button type="button" class="insights-wb-btn" onclick={handleCopy} disabled={!complete}>Copy widget text</button>
        <button type="button" class="insights-wb-btn" onclick={onclose}>{editing ? 'Cancel' : 'Close'}</button>
        {#if editing}
          <button type="button" class="insights-wb-btn insights-wb-primary" onclick={handleSave} disabled={!complete || busy}>Save changes</button>
        {:else}
          <button type="button" class="insights-wb-btn insights-wb-primary" onclick={handleAdd} disabled={!complete || busy}>Add to dashboard</button>
        {/if}
      </div>
    </footer>
  </div>
</div>

<style>
  .insights-wb-overlay {
    position: fixed;
    inset: 0;
    z-index: 100000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: rgba(0, 0, 0, 0.5);
    font-family: inherit;
    font-size: 0.9rem;
  }

  .insights-wb-dialog {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 78rem;
    height: 100%;
    max-height: 52rem;
    overflow: hidden;
    border-radius: 0.75rem;
    background: var(--color-pageBackground, #fff);
    color: var(--color-pageText, #111);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
  }

  .insights-wb-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--color-tableBorder, #ddd);
  }

  .insights-wb-header h2 {
    margin: 0;
    font-size: 1.15rem;
  }

  .insights-wb-close {
    cursor: pointer;
    border: none;
    background: transparent;
    color: inherit;
    font-size: 1.1rem;
    padding: 0.25rem 0.5rem;
  }

  .insights-wb-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .insights-wb-config {
    flex: 0 0 22rem;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    border-right: 1px solid var(--color-tableBorder, #ddd);
  }

  .insights-wb-preview {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--color-tableRowHeaderBackground, #f4f4f5);
  }

  .insights-wb-preview-title {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
    padding: 0.75rem 1rem 0;
    font-weight: 600;
  }

  .insights-wb-preview-stage {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1rem;
  }

  .insights-wb-card {
    box-sizing: border-box;
    max-width: 100%;
    min-height: 6rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--color-tableBorder, #ddd);
    background: var(--color-tableBackground, #fff);
    color: var(--color-tableText, #111);
  }

  .insights-wb-hint {
    margin: 0;
    color: var(--color-pageTextSubdued, #555);
  }

  .insights-wb-field,
  .insights-wb-field-inner {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .insights-wb-label {
    font-weight: 600;
  }

  .insights-wb-check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .insights-wb-help,
  .insights-wb-muted,
  .insights-wb-count {
    margin: 0;
    font-size: 0.8rem;
    color: var(--color-pageTextSubdued, #555);
  }

  .insights-wb-picker-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .insights-wb-picker-actions {
    display: flex;
    gap: 0.75rem;
  }

  .insights-wb-link {
    cursor: pointer;
    border: none;
    background: transparent;
    padding: 0;
    color: var(--color-pageTextLink, #2563eb);
    font: inherit;
    font-size: 0.8rem;
  }

  .insights-wb-filter {
    box-sizing: border-box;
    width: 100%;
  }

  .insights-wb-options {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 14rem;
    overflow-y: auto;
  }

  .insights-wb-group-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .insights-wb-group-row label {
    flex: 1;
  }

  .insights-wb-move {
    cursor: pointer;
    padding: 0 0.4rem;
  }

  .insights-wb-error {
    margin: 0;
    color: var(--color-errorText, #b91c1c);
  }

  .insights-wb-text summary {
    cursor: pointer;
    font-weight: 600;
  }

  .insights-wb-textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 5rem;
    margin-top: 0.5rem;
    font-family: monospace;
    font-size: 0.8rem;
  }

  .insights-wb-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--color-tableBorder, #ddd);
  }

  .insights-wb-status {
    margin: 0;
    flex: 1;
    min-height: 1.2em;
    font-size: 0.85rem;
  }

  .insights-wb-status-ok {
    color: var(--color-noticeText, #166534);
  }

  .insights-wb-status-error {
    color: var(--color-errorText, #b91c1c);
  }

  .insights-wb-actions {
    display: flex;
    gap: 0.5rem;
  }

  .insights-wb-btn {
    cursor: pointer;
    padding: 0.5rem 1rem;
    border-radius: 0.25rem;
    border: 1px solid var(--color-buttonNormalBorder, #ccc);
    background: var(--color-buttonNormalBackground, #fff);
    color: var(--color-buttonNormalText, #222);
    font: inherit;
  }

  .insights-wb-btn:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .insights-wb-primary {
    border-color: var(--color-buttonPrimaryBackground, #2563eb);
    background: var(--color-buttonPrimaryBackground, #2563eb);
    color: var(--color-buttonPrimaryText, #fff);
  }

  /* Narrow screens: options above the preview, one scrolling column. */
  @media (max-width: 760px) {
    .insights-wb-overlay {
      padding: 0;
    }

    .insights-wb-dialog {
      max-height: none;
      border-radius: 0;
    }

    .insights-wb-body {
      flex-direction: column;
      overflow-y: auto;
    }

    .insights-wb-config {
      flex: none;
      overflow: visible;
      border-right: none;
      border-bottom: 1px solid var(--color-tableBorder, #ddd);
    }

    .insights-wb-preview-stage {
      overflow: visible;
    }

    .insights-wb-footer {
      flex-direction: column;
      align-items: stretch;
    }

    .insights-wb-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
    }
  }
</style>
