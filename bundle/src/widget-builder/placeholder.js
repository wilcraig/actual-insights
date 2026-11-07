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
  const body = toBody ? toBody(values) : fields.length === 1 ? values[fields[0].key] : values;
  return `{{INSIGHTS:${widgetId}:${JSON.stringify(body)}}}`;
}

/**
 * Pacing bars: with "Category Groups" ticked the body is
 * `{ categoryIds, allGroups: true }`; otherwise the legacy bare array of
 * category ids, so existing dashboards and placeholders are unchanged.
 */
export function pacingBody(values) {
  const categoryIds = Array.isArray(values.categoryIds) ? values.categoryIds : [];
  return values.allGroups === true ? { categoryIds, allGroups: true } : categoryIds;
}
