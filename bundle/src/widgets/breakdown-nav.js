// Pure navigation-state for the category breakdown drill-down modal.
//
// No DOM, no fetch — just the level/identity bookkeeping needed to compute
// which `/api/spending-breakdown` request to make and which breadcrumb to
// render. Kept as a plain module (not Svelte state) so it's testable without
// mounting a component, and so the modal's own code stays a thin wrapper
// that calls these functions and re-fetches on every transition.
//
// Deliberate state shape: rather than a navigation *stack* (an array of
// past levels), NavState always carries the full identity it needs
// alongside the current `level`. That's enough to compute the breadcrumb
// and the next fetch at any level without replaying history, and it also
// means clicking into the same slice repeatedly can never accumulate
// duplicate history entries — there is no history array to append to, only
// a single current state that gets replaced.
//
// Levels, outermost to innermost: 'groups' -> 'categories' -> 'payees' ->
// 'transactions'. Three distinct entry points share this same state
// machine (disambiguated by which keys the caller passes to
// initialState()):
//   - a single category clicked in PacingBars: enters at 'payees', scoped
//     to that one category (and the real group it belongs to).
//   - a rollup bar clicked in PacingBars: enters at 'categories', scoped to
//     the rollup's own (arbitrary, not-a-real-group) category id list --
//     `categoryIds` is carried as sticky context through every further
//     transition, the same way `groupId`/`groupName` are for a normal
//     single-category entry, so zooming back out to 'categories' always
//     returns to this SAME rollup, never the real group of whichever
//     category happened to get clicked next.
//   - a standalone "pick your own groups" donut widget: enters at
//     'groups', scoped to a curated `groupIds` list (sticky context the
//     same way, so zooming back out to 'groups' shows that same curated
//     set, not every group).
// `categoryIds` and `groupIds` are therefore carried through every
// transition unchanged once set at entry; `groupId`/`groupName`/
// `categoryId`/`categoryName`/`payeeId`/`payeeName` are the "current
// position" fields that change as the user navigates.

const LEVELS = ['groups', 'categories', 'payees', 'transactions'];

function levelIndex(level) {
  return LEVELS.indexOf(level);
}

const EMPTY_POSITION = {
  groupId: null,
  groupName: null,
  categoryId: null,
  categoryName: null,
  payeeId: null,
  payeeName: null,
};

// Builds the initial state for whichever of the three entry shapes the
// caller passes:
//   - { categoryId, categoryName, groupId, groupName } -- single category.
//   - { categoryIds, rollupTitle } -- a rollup's member categories.
//   - { groupIds } -- a curated list of real groups.
export function initialState(options) {
  if (options.categoryId != null) {
    const { categoryId, categoryName, groupId, groupName } = options;
    return { ...EMPTY_POSITION, level: 'payees', groupId, groupName, categoryId, categoryName, categoryIds: null, groupIds: null };
  }

  if (options.categoryIds != null) {
    const { categoryIds, rollupTitle } = options;
    return { ...EMPTY_POSITION, level: 'categories', groupName: rollupTitle, categoryIds, groupIds: null };
  }

  // options.groupIds != null
  const { groupIds } = options;
  return { ...EMPTY_POSITION, level: 'groups', categoryIds: null, groupIds };
}

// Moves one level out: transactions -> payees -> categories -> groups.
// Zooming out from 'groups' is a documented no-op — it returns the same
// state unchanged (never null, never throws), so a modal wired naively to
// a "zoom out" button can call this repeatedly without ever getting stuck
// or crashing. `categoryIds`/`groupIds` (the sticky entry-point context)
// are always carried through unchanged.
export function zoomOut(state) {
  const index = levelIndex(state.level);
  if (index <= 0) {
    return state;
  }

  const targetLevel = LEVELS[index - 1];
  const sticky = { categoryIds: state.categoryIds, groupIds: state.groupIds };

  if (targetLevel === 'transactions') {
    // Unreachable: zoomOut is never called starting from before
    // 'transactions' into a level below 'groups'. Kept for exhaustiveness.
    return state;
  }

  if (targetLevel === 'payees') {
    return { ...EMPTY_POSITION, ...sticky, level: 'payees', groupId: state.groupId, groupName: state.groupName, categoryId: state.categoryId, categoryName: state.categoryName };
  }

  if (targetLevel === 'categories') {
    return { ...EMPTY_POSITION, ...sticky, level: 'categories', groupId: state.groupId, groupName: state.groupName };
  }

  // targetLevel === 'groups'
  return { ...EMPTY_POSITION, ...sticky, level: 'groups' };
}

// Today's month as a YYYY-MM string, the unit /api/spending-breakdown's
// `month` query parameter expects. Shared by every caller of
// buildBreakdownParams() below so "what month is it" is computed the same
// way everywhere.
export function currentMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Builds the /api/spending-breakdown query params for a given nav state --
// shared by every caller (the drill-down modal, and a standalone donut
// widget) so the two never drift out of sync on how a NavState maps to a
// request.
// Pass `date` (YYYY-MM-DD) instead of a month to scope to that single day.
export function buildBreakdownParams(nav, month, date = null) {
  const params = new URLSearchParams(date ? { date, level: nav.level } : { month, level: nav.level });

  if (nav.level === 'groups') {
    // A curated subset (the standalone donut widget's entry point); an
    // absent/empty groupIds means "every expense group," so the param is
    // only set when there's an actual restriction to apply.
    if (nav.groupIds && nav.groupIds.length > 0) {
      params.set('groupIds', nav.groupIds.join(','));
    }
  } else if (nav.level === 'categories') {
    // A rollup's member categories are an arbitrary id list (not a real
    // group), so it's sent as categoryIds instead of groupId -- see this
    // file's entry-point comment.
    if (nav.categoryIds) {
      params.set('categoryIds', nav.categoryIds.join(','));
    } else {
      params.set('groupId', nav.groupId);
    }
  } else if (nav.level === 'payees' || nav.level === 'transactions') {
    params.set('categoryId', nav.categoryId);
  }

  if (nav.level === 'transactions') {
    // The "(No payee)" bucket's slice id is `null`, which can't travel as a
    // literal query-param value distinguishable from "absent" -- the API's
    // own NO_PAYEE_SENTINEL ("__none__") carries that case.
    params.set('payeeId', nav.payeeId === null ? '__none__' : nav.payeeId);
  }

  return params;
}

// Drills one level in, into the clicked `slice` ({ id, label }). A no-op
// at the leaf level ('transactions') -- a single transaction row has
// nothing further to drill into -- returning the same state unchanged.
export function drillInto(state, slice) {
  const sticky = { categoryIds: state.categoryIds, groupIds: state.groupIds };

  if (state.level === 'groups') {
    return { ...EMPTY_POSITION, ...sticky, level: 'categories', groupId: slice.id, groupName: slice.label };
  }

  if (state.level === 'categories') {
    return { ...EMPTY_POSITION, ...sticky, level: 'payees', groupId: state.groupId, groupName: state.groupName, categoryId: slice.id, categoryName: slice.label };
  }

  if (state.level === 'payees') {
    return {
      ...EMPTY_POSITION,
      ...sticky,
      level: 'transactions',
      groupId: state.groupId,
      groupName: state.groupName,
      categoryId: state.categoryId,
      categoryName: state.categoryName,
      payeeId: slice.id,
      payeeName: slice.label,
    };
  }

  // state.level === 'transactions': leaf level, nothing to drill into.
  return state;
}

// ---------------------------------------------------------------------------
// Month stepping (the standalone donut widget's previous/next month arrows).
// Months are 'YYYY-MM' strings, the same unit as currentMonth() and the API's
// `month` parameter.

// How far back the arrows may go when the API doesn't report an earliest month.
export const FALLBACK_MONTHS_BACK = 24;

const MONTH_RE = /^(\d{4})-(\d{2})$/;

function monthIndex(month) {
  const [, year, mm] = MONTH_RE.exec(month);
  return Number(year) * 12 + (Number(mm) - 1);
}

function monthFromIndex(index) {
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// `month` moved by `delta` months (negative = earlier), crossing years.
export function shiftMonth(month, delta) {
  return monthFromIndex(monthIndex(month) + delta);
}

// The earliest month the arrows may reach: the API's `earliestMonth` when it
// is a valid month, else FALLBACK_MONTHS_BACK months before `current`. Never
// later than `current`.
export function earliestAllowedMonth(earliestMonth, current = currentMonth()) {
  if (typeof earliestMonth === 'string' && MONTH_RE.test(earliestMonth)) {
    return earliestMonth < current ? earliestMonth : current;
  }
  return shiftMonth(current, -FALLBACK_MONTHS_BACK);
}

// Clamps `month` into [earliest, current].
export function clampMonth(month, earliest, current = currentMonth()) {
  if (month > current) return current;
  if (month < earliest) return earliest;
  return month;
}

// Steps `month` by `delta` (+1/-1), clamped to [earliest, current].
export function stepMonth(month, delta, earliest, current = currentMonth()) {
  return clampMonth(shiftMonth(month, delta), earliest, current);
}

export function canStepBack(month, earliest) {
  return month > earliest;
}

export function canStepForward(month, current = currentMonth()) {
  return month < current;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// 'November 2026' for '2026-11' (fixed English names, no Intl/timezone dependence).
export function monthLabel(month) {
  const [, year, mm] = MONTH_RE.exec(month);
  return `${MONTH_NAMES[Number(mm) - 1]} ${year}`;
}

// ---------------------------------------------------------------------------
// The spending-breakdown-donut placeholder config: either the legacy bare
// array of group ids, or { groupIds: [...], monthNav: true|false }. Month
// arrows are ON unless monthNav is explicitly false.
export function parseDonutConfig(config) {
  const object = config && typeof config === 'object' && !Array.isArray(config);
  const rawIds = Array.isArray(config) ? config : object ? config.groupIds : [];
  const groupIds = Array.isArray(rawIds) ? rawIds.filter((id) => typeof id === 'string') : [];
  const monthNav = !(object && config.monthNav === false);
  return { groupIds, monthNav };
}
