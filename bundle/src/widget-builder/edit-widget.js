import { defaultValues, isPickerField } from './builder-state';

// Reopening the builder on a widget it made. The placeholder text a widget
// carries already holds everything the builder chose (the widget id and the
// config body), so editing reads the form back out of that text instead of
// storing anything extra on the dashboard. That also makes widgets pasted by
// hand, or made before this existed, editable.

const CLOSING = '}}';
// Same prefixes as mount.js (not imported, so this stays free of mount.js's module).
const PLACEHOLDER_PREFIX = '{{INSIGHTS:';
const LEGACY_PLACEHOLDER_PREFIX = '{{ACTUALMINT:';

/**
 * Finds the first `{{INSIGHTS:<id>:<json>}}` (or legacy `{{ACTUALMINT:...}}`)
 * in `text` whose JSON parses.
 * @returns {{ widgetId: string, body: unknown, raw: string } | null}
 */
export function parsePlaceholderText(text) {
  if (typeof text !== 'string') return null;
  for (const prefix of [PLACEHOLDER_PREFIX, LEGACY_PLACEHOLDER_PREFIX]) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(prefix, from);
      if (start === -1) break;
      from = start + prefix.length;
      const colon = text.indexOf(':', from);
      if (colon === -1) break;
      const widgetId = text.slice(from, colon);
      if (!/^[a-z0-9-]+$/.test(widgetId)) continue;
      // The body can end in `}` itself, so try each `}}` until one parses.
      let searchFrom = colon + 1;
      for (;;) {
        const end = text.indexOf(CLOSING, searchFrom);
        if (end === -1) break;
        try {
          const body = JSON.parse(text.slice(colon + 1, end));
          return { widgetId, body, raw: text.slice(start, end + CLOSING.length) };
        } catch {
          searchFrom = end + 1;
        }
      }
    }
  }
  return null;
}

const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

/**
 * The form state that would produce `body` for `widget`: the inverse of
 * bodyOf()/toBody. Anything unusable falls back to the field's default.
 * @returns {{ values: Record<string, unknown>, groupIds: string[] | null }}
 */
export function valuesFromBody(widget, body) {
  const values = defaultValues(widget);
  let groupIds = null;
  const object = body && typeof body === 'object' && !Array.isArray(body);

  if (widget.id === 'pacing-bars') {
    // Legacy bare array, or {categoryIds, allGroups, groupIds}.
    values.categoryIds = strings(object ? body.categoryIds : body);
    values.allGroups = object && body.allGroups === true;
    if (values.allGroups && Array.isArray(body.groupIds)) groupIds = strings(body.groupIds);
    return { values, groupIds };
  }

  if (widget.id === 'spending-breakdown-donut') {
    // Legacy bare array or a missing key reads as checked; only monthNav:false is unchecked.
    values.monthNav = !(object && body.monthNav === false);
    return { values, groupIds };
  }

  const fields = widget.fields;
  const pick = (field, raw) => {
    if (isPickerField(field)) values[field.key] = strings(raw);
    else if (field.type === 'checkbox') values[field.key] = raw === true;
    else if (field.type === 'select' && field.options.some((option) => option.value === raw)) values[field.key] = raw;
  };

  if (fields.length === 1 && !object) {
    // A single-field widget's body is that field's raw value (e.g. a bare id array).
    pick(fields[0], body);
  } else if (Array.isArray(body) && fields.length > 0) {
    // Older multi-field widgets accepted a bare array for their first field (account-balances).
    pick(fields[0], body);
  } else if (object) {
    for (const field of fields) if (field.key in body) pick(field, body[field.key]);
  }
  return { values, groupIds };
}

/**
 * Reorders loaded group rows to follow a saved groupIds list: those groups
 * first, checked, in that order; every other group after, unchecked.
 */
export function applyGroupIds(rows, groupIds) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chosen = groupIds.filter((id) => byId.has(id)).map((id) => ({ ...byId.get(id), checked: true }));
  const rest = rows.filter((row) => !groupIds.includes(row.id)).map((row) => ({ ...row, checked: false }));
  return [...chosen, ...rest];
}

function parseMeta(meta) {
  if (meta && typeof meta === 'object') return meta;
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Finds the dashboard Text widget whose content contains `raw`, on the given
 * dashboard. With several identical widgets the first match is returned (they
 * are interchangeable until edited).
 * @returns {Promise<{ id: string, meta: Record<string, unknown> } | null>}
 */
export async function locateDashboardWidget({ query, q, dashboardId, raw }) {
  const result = await query(q('dashboard').select('*'));
  for (const row of result?.data ?? []) {
    if (row.type !== 'markdown-card' || row.tombstone) continue;
    if (row.dashboard_page_id && dashboardId && row.dashboard_page_id !== dashboardId) continue;
    const meta = parseMeta(row.meta);
    if (meta && typeof meta.content === 'string' && meta.content.includes(raw)) return { id: row.id, meta };
  }
  return null;
}

/**
 * Replaces `raw` with `newText` inside the widget's Text content (keeping any
 * markdown around it) and saves it through Actual's own update handler.
 * @throws when Actual refuses
 */
export async function saveWidgetText({ send, widget, raw, newText }) {
  const content = widget.meta.content.replace(raw, () => newText);
  const result = await send('dashboard-update-widget', { id: widget.id, meta: { ...widget.meta, content } });
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    throw new Error('Actual could not save the widget.');
  }
}
