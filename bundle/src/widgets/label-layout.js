/**
 * Spreads direct labels down a column so none overlap, keeping each as close
 * to where it wants to be as the spacing allows.
 *
 * Labels keep their top-to-bottom order. Each is pushed down just far enough to
 * clear the one above; if that runs past `max`, the block is pushed back up
 * from the bottom. If there is not room for every label between `min` and
 * `max`, they stack from `min` at exactly `gap` apart (the caller grows the
 * chart instead; see rowsNeeded).
 *
 * @param {number[]} desired each label's preferred centre y, in any order
 * @param {{ gap: number, min: number, max: number }} bounds `gap` is the
 *   minimum distance between neighbouring centres
 * @returns {number[]} the placed centre y of each label, same order as `desired`
 */
export function spreadLabels(desired, { gap, min, max }) {
  const order = desired.map((y, index) => index).sort((a, b) => desired[a] - desired[b] || a - b);
  const placed = new Array(desired.length);
  let previous = -Infinity;
  for (const index of order) {
    const y = Math.max(desired[index], min, previous + gap);
    placed[index] = y;
    previous = y;
  }
  // Past the bottom edge: pull the overflowing tail back up, never above the
  // label before it, so order and spacing hold.
  let limit = max;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const index = order[i];
    if (placed[index] > limit) placed[index] = limit;
    limit = placed[index] - gap;
  }
  // If pulling up pushed the first labels above `min`, restack from `min`.
  if (order.length > 0 && placed[order[0]] < min) {
    order.forEach((index, i) => {
      placed[index] = min + i * gap;
    });
  }
  return placed;
}

/** The height a column of `count` labels needs: `count` rows plus the margins. */
export function heightForLabels(count, { gap, top, bottom, minHeight }) {
  return Math.max(minHeight, Math.ceil(count * gap + top + bottom));
}

/** `name` cut to `max` characters with an ellipsis, so a long name stays inside its column. */
export function truncateName(name, max) {
  const text = String(name ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}
