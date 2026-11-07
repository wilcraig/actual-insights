// Pure helpers for the Subscription Renewal Radar: reading its placeholder
// body, filtering out excluded categories, and the vertical layout math.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The placeholder body is `null` (today's horizontal look) or
 * `{ layout?: 'vertical' | 'horizontal', excludeCategoryIds?: string[] }`.
 * An unknown layout falls back to horizontal; non-string ids are ignored.
 * @param {unknown} config
 * @returns {{ layout: 'horizontal' | 'vertical', excludeCategoryIds: string[] }}
 */
export function parseRadarConfig(config) {
  const object = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return {
    layout: object.layout === 'vertical' ? 'vertical' : 'horizontal',
    excludeCategoryIds: Array.isArray(object.excludeCategoryIds)
      ? object.excludeCategoryIds.filter((id) => typeof id === 'string')
      : [],
  };
}

/**
 * Drops items whose category id is excluded. An item with no known category
 * (missing, null or empty) is never excluded.
 * @template {{ categoryId?: string | null }} T
 * @param {T[]} items
 * @param {string[]} excludeCategoryIds
 * @returns {T[]}
 */
export function excludeCategories(items, excludeCategoryIds) {
  if (!excludeCategoryIds || excludeCategoryIds.length === 0) return items;
  const excluded = new Set(excludeCategoryIds);
  return items.filter((item) => typeof item.categoryId !== 'string' || !item.categoryId || !excluded.has(item.categoryId));
}

/** `text` shortened with an ellipsis so `measure(text)` fits in `maxWidth`. */
export function truncateToWidth(text, maxWidth, measure) {
  if (measure(text) <= maxWidth) return text;
  let end = text.length;
  while (end > 1 && measure(`${text.slice(0, end)}…`) > maxWidth) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Vertical layout: time runs top to bottom down one axis. Each item's dot
 * sits at its date; its label sits to the right of the axis at the same
 * height unless that would collide with the previous label, in which case it
 * is pushed down (a connector joins label to dot), so labels never overlap
 * however many renewals fall close together. Items must be sorted by date.
 *
 * @param {{ date: string, payeeName: string, amountCents: number }[]} items
 * @param {{ today: Date, windowDays: number, width: number, measure: (text: string) => number,
 *           pxPerDay?: number, rowHeight?: number, axisX?: number, marginTop?: number, marginBottom?: number,
 *           marginRight?: number, amountText?: (cents: number) => string }} options
 */
export function layoutVertical(items, options) {
  const {
    today,
    windowDays,
    width,
    measure,
    pxPerDay = 12,
    rowHeight = 34,
    axisX = 56,
    marginTop = 12,
    marginBottom = 12,
    marginRight = 12,
    amountText = (cents) => String(cents),
  } = options;

  const labelX = axisX + 22;
  const maxLabelWidth = Math.max(60, width - labelX - marginRight);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  const dayIndex = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return Math.round((new Date(y, m - 1, d) - midnight) / DAY_MS);
  };

  let nextFree = 0;
  const rows = items.map((item, index) => {
    const day = Math.min(Math.max(dayIndex(item.date), 0), windowDays);
    const dotY = marginTop + day * pxPerDay;
    // Top of this label's row: at the dot unless the previous row is in the way.
    const rowTop = Math.max(dotY - rowHeight / 2 + 6, nextFree);
    nextFree = rowTop + rowHeight;
    const amount = amountText(item.amountCents);
    const nameWidth = Math.max(30, maxLabelWidth - measure(` ${amount}`) - 4);
    return {
      index,
      dotY,
      rowTop,
      labelY: rowTop + 13, // first line baseline (name + amount)
      dateY: rowTop + 26, // second line baseline (date)
      displaced: Math.abs(rowTop + rowHeight / 2 - 6 - dotY) > 0.5,
      name: truncateToWidth(item.payeeName, nameWidth, measure),
      amount,
      labelX,
    };
  });

  const axisTop = marginTop;
  const axisBottom = Math.max(marginTop + windowDays * pxPerDay, nextFree - rowHeight + rowHeight / 2);
  const height = Math.max(axisBottom, nextFree) + marginBottom;

  const ticks = [];
  for (let day = 0; day <= windowDays; day += 7) ticks.push({ day, y: marginTop + day * pxPerDay });

  return { rows, ticks, axisX, axisTop, axisBottom, height, labelX };
}
