/**
 * Builds the markdown placeholder string that a Reports Text widget carries
 * for an Actual Insights widget, e.g. `{{INSIGHTS:pacing-bars:["catA","catB"]}}`.
 *
 * Single-field widgets emit the raw field value so the existing mount
 * callbacks (which receive the parsed JSON body directly) keep working.
 * Zero- or multi-field widgets emit an object keyed by each field's key.
 *
 * @param {string} widgetId
 * @param {{key: string}[]} fields
 * @param {Record<string, unknown>} values
 * @param {(values: Record<string, unknown>) => unknown} [toBody] a widget's own
 *   body shape, when the generic rule above is not what its mount expects
 * @returns {string}
 */
export function buildPlaceholder(widgetId, fields, values, toBody) {
  return `{{INSIGHTS:${widgetId}:${JSON.stringify(bodyOf(fields, values, toBody))}}}`;
}

/**
 * The JSON body of a widget's placeholder (what its mount callback receives
 * once parsed). The live preview mounts the widget with exactly this value, so
 * it and the generated placeholder can never disagree.
 */
export function bodyOf(fields, values, toBody) {
  return toBody ? toBody(values) : fields.length === 1 ? values[fields[0].key] : values;
}

/**
 * Pacing bars: with "Category Groups" ticked the body is
 * `{ categoryIds, allGroups: true, groupIds }` (groupIds = the checked groups
 * in the chosen order; left out when the group list was never loaded);
 * otherwise the legacy bare array of category ids, so existing dashboards
 * and placeholders are unchanged.
 */
export function pacingBody(values) {
  const categoryIds = Array.isArray(values.categoryIds) ? values.categoryIds : [];
  if (values.allGroups !== true) return categoryIds;
  const body = { categoryIds, allGroups: true };
  if (Array.isArray(values.groupIds)) body.groupIds = values.groupIds;
  return body;
}

/**
 * Spending breakdown donut: "Month arrows" ticked (the default) with no group
 * picking is the legacy-compatible `[]`; unticked is
 * `{ groupIds: [], monthNav: false }`. The builder has no group picker for
 * this widget, so groupIds is always empty (a hand-edited placeholder's groups
 * are not preserved by re-saving through the builder).
 */
export function donutBody(values) {
  return values.monthNav === false ? { groupIds: [], monthNav: false } : [];
}
