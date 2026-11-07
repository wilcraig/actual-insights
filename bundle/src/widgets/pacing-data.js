// Pure data-shaping for the Pacing Bars widget: turns one category's
// {budgeted, spent} (integer cents, from /api/budget-pacing) plus the
// month's {daysElapsed, daysInMonth} into the numbers PacingBars.svelte
// needs to draw a bar — no DOM, no fetch, so it's cheap to unit test.

/**
 * @param {{ budgeted: number, spent: number }} amounts
 * @param {{ daysElapsed: number, daysInMonth: number }} month
 * @returns {{ fillPct: number, tickPct: number, status: 'under' | 'near' | 'over' }}
 */
export function computeBarState({ budgeted, spent }, { daysElapsed, daysInMonth }) {
  // `spent` is clamped to a minimum of 0 before computing the fill: a
  // refund-heavy category can have net inflow for the month (negative
  // `spent`, by this point in the pipeline), which must never render as a
  // negative-width bar.
  const fillPct = budgeted > 0 ? Math.max(0, Math.min(spent / budgeted, 1)) * 100 : 0;
  const tickPct = (daysElapsed / daysInMonth) * 100;

  let status;
  if (spent > budgeted) {
    status = 'over';
  } else if (fillPct >= 90) {
    status = 'near';
  } else {
    status = 'under';
  }

  return { fillPct, tickPct, status };
}

// This account's budget type is "tracking": a category with carryover
// enabled rolls its prior month's surplus or deficit into `balance`, while
// one with carryover off has `balance === budgeted - spent` for the month
// alone. Either way, `balance + spent` recovers "total available to spend
// this cycle" -- the right denominator to pace against -- without needing
// to branch on the carryover flag: when there's no rollover the term is
// zero and this reduces to the plain monthly `budgeted` figure.
function effectiveBudget(category) {
  return category.balance + category.spent;
}

/**
 * Collects every category id referenced by a pacing-bars `items` config,
 * whether as a plain category id string or inside a rollup's `budgets`
 * list, deduplicated, for a single batched /api/budget-pacing request.
 * @param {(string | { title: string, budgets: string[] })[]} items
 * @returns {string[]}
 */
export function collectCategoryIds(items) {
  const ids = new Set();
  for (const item of items) {
    if (typeof item === 'string') {
      ids.add(item);
    } else if (item && Array.isArray(item.budgets)) {
      for (const id of item.budgets) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Turns the widget's `items` config plus the API's flat per-category
 * results into the rows PacingBars.svelte renders. A plain category id
 * becomes its own 'category' row; a `{title, budgets}` rollup becomes one
 * 'rollup' row whose spent/budgeted are the sum across its member
 * categories' spent and rollover-aware available amounts. A rollup with no
 * resolvable members (every listed id absent from the API response, e.g. a
 * deleted category) is omitted rather than shown as an empty $0 bar; an
 * item that's neither a known string id nor a well-formed rollup object is
 * skipped the same way, so a malformed placeholder degrades quietly
 * instead of crashing the widget.
 * @param {(string | { title: string, budgets: string[] })[]} items
 * @param {{ id: string, name: string, groupId: string, groupName: string, spent: number, balance: number }[]} categories
 * @returns {Array<{ kind: 'category' | 'rollup', id: string, name: string, spent: number, budgeted: number, groupId?: string, groupName?: string }>}
 */
export function buildPacingRows(items, categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const rows = [];
  const usedRollupIds = new Set();

  for (const item of items) {
    if (typeof item === 'string') {
      const cat = byId.get(item);
      if (!cat) continue;
      rows.push({
        kind: 'category',
        id: cat.id,
        name: cat.name,
        groupId: cat.groupId,
        groupName: cat.groupName,
        spent: cat.spent,
        budgeted: effectiveBudget(cat),
      });
      continue;
    }

    if (item && typeof item === 'object' && typeof item.title === 'string' && Array.isArray(item.budgets)) {
      const members = item.budgets.map((id) => byId.get(id)).filter(Boolean);
      if (members.length === 0) continue;
      // Two groups can share a name; the row id is a keyed-each key, so it
      // must stay unique.
      let rollupId = `rollup:${item.title}`;
      for (let n = 2; usedRollupIds.has(rollupId); n += 1) rollupId = `rollup:${item.title}#${n}`;
      usedRollupIds.add(rollupId);
      rows.push({
        kind: 'rollup',
        id: rollupId,
        name: item.title,
        spent: members.reduce((sum, c) => sum + c.spent, 0),
        budgeted: members.reduce((sum, c) => sum + effectiveBudget(c), 0),
        // The resolved member category ids actually present this month (a
        // listed id absent from the API response -- e.g. deleted -- is
        // already excluded from `members` above), for the breakdown modal
        // to drill into.
        memberIds: members.map((c) => c.id),
      });
    }
  }

  return rows;
}

/**
 * Reads a pacing-bars placeholder body, which is either the legacy bare array
 * (category id strings and `{ title, budgets }` rollups) or the object the
 * widget builder emits when "Category Groups" is ticked:
 * `{ categoryIds: [...], allGroups: true, groupIds?: [...] }`. Anything else
 * reads as empty. `groupIds` (strings only) is present only when the object
 * carries an array of them.
 * @param {unknown} config
 * @returns {{ items: (string | { title: string, budgets: string[] })[], allGroups: boolean, groupIds?: string[] }}
 */
export function parsePacingConfig(config) {
  if (Array.isArray(config)) return { items: config, allGroups: false };
  if (config && typeof config === 'object') {
    const parsed = {
      items: Array.isArray(config.categoryIds) ? config.categoryIds : [],
      allGroups: config.allGroups === true,
    };
    if (parsed.allGroups && Array.isArray(config.groupIds)) {
      parsed.groupIds = config.groupIds.filter((id) => typeof id === 'string');
    }
    return parsed;
  }
  return { items: [], allGroups: false };
}

/**
 * The visible expense groups, in the order given (Actual's order from
 * /api/category-groups): income, transfer and empty groups are left out
 * (hidden groups and categories are already dropped by the API).
 * @param {{ id?: string, name: string, isIncome?: boolean, isTransfer?: boolean, categoryIds?: string[] }[]} groups
 * @returns {{ id: string, name: string, categoryIds: string[] }[]}
 */
export function visibleExpenseGroups(groups) {
  const out = [];
  for (const group of groups || []) {
    if (!group || group.isIncome || group.isTransfer) continue;
    const categoryIds = Array.isArray(group.categoryIds) ? group.categoryIds.filter((id) => typeof id === 'string') : [];
    if (categoryIds.length === 0 || typeof group.name !== 'string') continue;
    out.push({ id: group.id, name: group.name, categoryIds });
  }
  return out;
}

/**
 * The widget's final `items` list. With allGroups: one rollup
 * `{ title: groupName, budgets: [categoryIds] }` per visible expense group,
 * then the explicitly picked items. Without `groupIds` that is every visible
 * group in Actual's order; with `groupIds` it is only those groups, in
 * exactly that order (ids that no longer exist are ignored, duplicates
 * folded, groups created later are not added).
 * @param {{ items: unknown[], allGroups: boolean, groupIds?: string[] }} parsed
 * @param {Parameters<typeof visibleExpenseGroups>[0]} groups
 */
export function buildPacingItems({ items, allGroups, groupIds }, groups) {
  if (!allGroups) return items;
  let visible = visibleExpenseGroups(groups);
  if (Array.isArray(groupIds)) {
    const byId = new Map(visible.map((g) => [g.id, g]));
    visible = [...new Set(groupIds)].map((id) => byId.get(id)).filter(Boolean);
  }
  return [...visible.map((g) => ({ title: g.name, budgets: g.categoryIds })), ...items];
}
