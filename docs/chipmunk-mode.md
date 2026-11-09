# Chipmunk mode

A switchable mode (server-side setting, default **off**) that makes the Actual Insights web pages mirror what a
person sees in the Chipmunk phone app. Off, nothing changes for anyone.

## What the phone does that the web did not

| Phone | Web today | Chipmunk mode on the web |
|---|---|---|
| Home = the default report; the title is a dropdown of every dashboard page and saved report | Actual's Reports page, one dashboard at a time | **Reports** tab: title dropdown from `/report-list`, cards from `/reports` in server order, donut month arrows, choice remembered per browser |
| Accounts: On budget / Off budget, account groups collapsible (collapsed by default, remembered), red for negative balances, subtotal per group | Actual's own sidebar | **Accounts** tab: same structure, collapsed by default, remembered in localStorage, green/red balances |
| Transactions: one search bar plus a filter button, typeahead (merchants and categories) with "add to filter", filter chips, Uncategorized chip with count | Per-account register in Actual | **Transactions** tab: combined search + filter bar, typeahead, chips, load-more paging |
| Budget (Budget Config): month arrows, groups collapsed first with totals, repeat marker on categories with a series | Actual's own Budget page | **Budget** tab: same, plus the **budget series** editor: Repeat for N months / until a month / every month, always a dry-run review of each month's current and new amount before Confirm; edit or stop an existing series |
| Palette of 12 colour keys | Insights' own chart colours | Same hex table as the phone for cards and transaction colour chips |

## What stays as it is

The widget builder, the Insights widgets and how they draw charts, Actual's own transaction sidebar and registers,
and every existing Insights tab (General, Summaries, Channels, Forecast, Mobile app). Chipmunk mode adds four tabs
in front of them (Reports, Accounts, Transactions, Budget); the old tabs remain, General included. Actual's own
Budget page is untouched (the Budget tab is an addition, not a replacement).

## How it works

- `GET /api/chipmunk-mode` -> `{ enabled, entitled, reason, lastVerifiedAt: null }`. `PUT` with `{ enabled }` (session
  auth, like the other settings). Stored in `chipmunk-mode.json` in the Insights data dir; missing file = off.
- All "is it available?" decisions go through `chipmunkEntitled()` in `api/src/chipmunk/entitlement.js`. Today it
  returns `{ entitled: true, reason: 'unlicensed-dev' }`; a later phase replaces the body with real subscription
  verification and nothing else changes. `enabled` reported to the bundle is `stored && entitled`. Turning the mode
  on while not entitled is a 403, and the data routes below refuse too.
- Thin web routes `/api/chipmunk/{report-list,reports,accounts,transactions,transactions/suggest}` sit behind the
  normal Actual-session guard and call the **same builders** the phone API uses (`api/src/mobile/v1/*`). No logic is
  duplicated and `/api/mobile/v1` is untouched: no new fields, no changed validation, so installed phone builds are
  unaffected. Difference by design: the web is the owner's, so the "hidden from phone" accounts are not hidden here
  (the phone's scoped client is not applied) and the phone's per-token transaction flags still apply (same store).
- The bundle reads the mode when the Insights page opens. The tab list, default tab and tab hashes depend on it
  (`route.js` takes an optional `chipmunk` flag; without it the functions behave exactly as before).
- The toggle is a row on the General tab: "Chipmunk mode".

## Budget series on the web

The Budget tab calls `/api/chipmunk/budget/:month` and `/api/chipmunk/budget-series` (GET, POST, PUT `/:id`, DELETE `/:id`).
They call the phone's own `buildBudgetMonth`, `buildSeriesList`, `saveSeries` and `deleteSeries`, so every rule is shared:
one series per category (409 on a second), dry run changes nothing, create/update overwrite the covered months from the
later of the start month and now, past months are never touched, delete keeps months already written, writes are
audit-logged (as `web` instead of a token id), and the daily scheduler extends indefinite series as before. The web user is
the signed-in Actual user, so there is no read/write scope. The Budget tab offers series only (no separate "just this
month" write); "just this month" on the phone stays a phone feature. One side effect: the phone API's 15 s read cache is not
cleared by a web write, so a phone can show the old amounts for up to 15 s.

## Limits

Cards the phone renders from sankey/timeline/multiseries data show as a short placeholder on the web (the web's own
widgets already draw those, on the Reports page). Apart from budget series, these tabs are read-only (no transaction or budget-amount editing).
