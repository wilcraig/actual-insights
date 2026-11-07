/**
 * Moves the entry at `index` by `delta` places (-1 up, +1 down) and returns a
 * new array; out-of-range moves return the list unchanged.
 * @template T
 * @param {T[]} list
 * @param {number} index
 * @param {number} delta
 * @returns {T[]}
 */
export function moveEntry(list, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** The checked rows' ids, in the rows' current order. */
export function checkedGroupIds(rows) {
  return rows.filter((row) => row.checked).map((row) => row.id);
}
