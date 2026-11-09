# Chipmunk mode

## What it is

Chipmunk mode (server-side setting, default **off**) turns the **whole** web app into Chipmunk: with it on, loading any Actual URL
shows a full-viewport Chipmunk shell over Actual's UI. Off, nothing changes for anyone (the bundle runs Actual's side
synchronously, exactly as before; the only addition is one non-blocking `GET /api/chipmunk-mode`, skipped for a minute after a cached "off").

Same menus, names, behaviours and visual language as the phone/Mac app, laid out for a desktop browser (it is not a stretched phone UI).
Phone width works as a fallback (sidebar becomes a hamburger drawer).

| Screen | Phone behaviour kept | Desktop additions |
|---|---|---|
| **Reports** (home) | the report title dropdown (every dashboard page and saved report, choice remembered) | **Actual's own Reports page**, the original experience: the Insights widgets, Add new widget, Widget builder, Edit dashboard, widget editing and removal, all as with the mode off (see below) |
| **Accounts** | On budget / Off budget, collapsible groups remembered, green/red balances | centred wider column |
| **Transactions** | one search bar + Filter, typeahead with "add to filter", chips, Uncategorized, paging | dense sortable table (Date/Payee/Category/Amount, `aria-sort`), multi-select (click, Ctrl/Cmd-click, Shift-click range, Space), selected total, detail pane beside the list, `j`/`k`/arrows, Esc |
| **Budget** | month arrows, collapsed groups, repeat marker, budget-series editor with dry-run review | centred wider column |
| **Settings** | | Chipmunk-mode switch (turning off asks first), subscription status text (verified date etc.), theme (follows system), shortcuts list |
| **More Insights** | | the existing Insights page (General, Summaries, Channels, Forecast, Mobile app) shown unchanged inside the shell; **Widget builder** opens Actual's Reports (it lives on that page) |
| **Search (Cmd/Ctrl-K)** | | command palette: screens, reports, accounts ("Transactions in X"), payees/categories (typeahead), free-text transaction search, Insights tabs, Open Actual |

Shortcuts: Cmd/Ctrl-1..4 (Reports, Accounts, Transactions, Budget), Cmd/Ctrl-, (Settings), Cmd/Ctrl-K. Browsers often keep Cmd/Ctrl-1..4 for their
own tabs, so **Alt-1..4** also work.

## Takeover design

Code: `bundle/src/chipmunk/shell/` (`takeover.js` decision + escape hatches, `mount-shell.js`, `ChipmunkShell.svelte`, `CommandPalette.svelte`,
`SettingsScreen.svelte`, `routes.js`). `bundle/src/index.js` runs the always-on bits (CSS fixes, text size, theme), then `startTakeover()`.
Everything Actual-side (redirect to Reports, widget mounting, builder, Insights page overlay, sidebar entry) is `startActual()`, which runs once:
immediately when the shell is not taking over, or later if the person opens Actual / turns the mode off / the shell fails.

- **Decision** (`decideTakeover`): shell iff mode `enabled && entitled` and not bypassed, not broken, not failed-open.
  First paint uses the answer cached in `localStorage` (`insights:chipmunk:mode`), so there is no flash of Actual. A server check
  (`GET /api/chipmunk-mode`, non-blocking) confirms. **Fail open**: request fails, not signed in (401), junk answer, not entitled, or Actual is on
  `/login`/`/bootstrap` -> plain Actual (the cached answer is kept for next time; a failed check is retried on navigation, at most every 30 s, and straight away after leaving `/login`).
- **Cover**: a `position:fixed` host at z-index 2147483000 with its own scrolling. Actual's top-level elements get `inert`, `aria-hidden`
  and `visibility:hidden` (restored afterwards); nothing is destroyed, so Actual's state is intact.
- **Open Actual** (sidebar): bypass for this browser *session* only (`sessionStorage`), the mode stays on. Actual starts, and a floating
  **Back to Chipmunk** pill returns to the same shell screen (shell hash saved). A reload in the session stays in Actual with the pill.
  Turning the mode on again clears the bypass. Widget builder uses the same path (`/reports`).
- **Turning off** (Settings, with confirmation; or the General tab switch, one click as before): shell hides, Actual starts, cache updated. Turning on
  from the General tab takes over at once.
- **Safety**: if the shell throws on mount or show, it is destroyed, Actual is shown, and a small dismissible notice says so. A screen that throws
  shows an error with Try again / Open Actual (`svelte:boundary`), never a blank page.
- **Routes** (URL hash, so any Actual path works and Actual's router is untouched): `#/chipmunk/<reports|accounts|transactions|budget|settings>`;
  the Insights page keeps `#actual-insights[/tab]` (also `#/chipmunk/insights/<tab>`). Anything else is Reports. Back/forward work.
- **The old Insights page is unchanged** by Chipmunk mode: `route.js`, `tabs.js`, `InsightsPage.svelte`, `mount-page.js` are as before the mode existed.
  The General tab keeps its Chipmunk-mode row.
- The shell's classes are all prefixed `cm-` (Actual's own CSS has generic `.sidebar`, `.content`... rules that otherwise leak in).

### Reports screen: Actual's own page inside the shell

The Reports screen is no longer a Chipmunk card grid. It shows **Actual's real Reports page**, so everything that exists with the mode off is there
(widget grid, Add new widget, Widget builder modal, Edit dashboard, editing/removing widgets, Actual's own dashboard menu and tooltips). Only the report dropdown is Chipmunk's.

- **How:** Actual's React app stays mounted underneath. On the Reports screen `takeover.js` (`actualApi.reveal(slot)`) un-hides it and `shell/actual-layout.js` sizes
  `#root` to the screen's slot (`position: relative`, `top`, left margin, width, height; no transform and no z-index, so no stacking context), hides Actual's sidebar(s) and title bar
  (found from `[data-testid="help-menu-button"]` as in `docs/insights-page-hosting-notes.md`, plus ABT's `.sidebar`), and keeps them hidden while React re-renders. Leaving the screen
  (`conceal`), Open Actual, turning the mode off or a shell failure undoes all of it (the tests check no leftover style, `inert` or hidden mark).
- **Layering:** while the Reports screen is up the shell host drops to `z-index: 50`, background transparent and `pointer-events: none` (only the sidebar, top bar and report header take clicks),
  so Actual's own modals/popovers and the widget builder (z-index 100 and up) layer above the shell chrome. On every other screen the host is the top cover again (`2147483000`) and
  Actual is `inert`, `aria-hidden` and `visibility: hidden`. The command palette and context menus live in the host and show over the Reports page.
- **Dropdown:** lists `/api/chipmunk/report-list`. A dashboard page is `/reports/<id>`, a saved report `/reports/custom/<id>` (`shell/report-routes.js`). Picking one moves Actual's router with
  `history.pushState` + a `popstate` event (react-router listens to it), keeping the shell hash. It also follows Actual: switching dashboard in Actual's own menu updates the dropdown, and a dashboard just created
  in Actual is picked up (the list is re-read at 0.8, 3 and 8 s while the server catches up on the sync). Choice order on entering: the palette's pick, the report Actual is already on, the remembered choice, the default dashboard.
  The palette's "Report: ..." entries use the same path.
- **Keys:** the shell's Ctrl/Cmd-K and screen shortcuts stop propagation, so Actual's own search does not open on top of the palette.
- **Needs a budget open:** Actual shows its Reports page only after a budget file is loaded in this browser. On a browser that has not opened it yet, Actual shows its file picker in the slot with a
  note ("Actual needs your budget file open in this browser"); once the file loads and Actual lands on `/budget`, the shell sends it back to Reports (at most once every 1.5 s). `/login` and `/bootstrap` still fail open to plain Actual.
- **What starts:** only the Reports parts of the Actual-side bundle (`startReports()`: widget mounting, the builder, edit buttons) start for the Reports screen. The rest (redirect to Reports, the Insights overlay,
  the Settings card, the sidebar entry) starts only on Open Actual / mode off / failure, so the Insights page inside the shell is not mounted twice. With the mode off the sequence is the same as before.
- **Removed:** the Chipmunk card grid (`ReportsTab`, `ReportCard`, chart tooltips) had no remaining user and is gone. `/api/chipmunk/reports` and `getReports` stay (server contract unchanged) but are unused by the web UI.

### Writes from the desktop shell

All audited as writer `web`, using the phone's own write logic (`api/src/mobile/v1/write.js`: validation against fresh data, one write at a time, audit line, sync to the Actual server).
`/api/mobile/v1` is unchanged.

- `PATCH /api/chipmunk/transactions` `{ ids, changes }`: **bulk** edit of up to 50 transactions (the UI batches larger selections), `changes` being one or more of
  `category` (id or null), `cleared`, `excluded`, `hidden`, `notes`. Unknown keys, duplicate or malformed ids, empty bodies: 400. Any unknown id: 404 and nothing is written.
  Rows the change is not allowed on (transfer, split parent, closed account, reconciled cleared flag, hidden/excluded conflict) are **skipped and reported**:
  `{ updated, unchanged, skipped: [{ id, reason }] }`. One write-lock pass; one audit line per changed transaction; **one** Actual sync at the end (none for flag-only changes).
  The web view is the owner's, so the phone's hidden-accounts scoping is not applied here.
- `PUT /api/chipmunk/budget/:month/categories/:id` `{ budgeted }` (cents, 0..1e12) and `POST /api/chipmunk/budget/:month/move` `{ from, to, amount }`: the phone's set and move.
- Transactions table: the selection bar offers Categorize, Mark cleared, Hide, Exclude; the same actions are in the right-click menu (which acts on the selection, or selects the
  row under the pointer). Every action first shows a plain-words confirmation (what, how many, and that there is no undo in this view for hide/exclude; the filter's **Show hidden**
  brings hidden rows back, and the menu has Show again / Include).
- Budget screen: click a category's budgeted amount to edit it in place. Enter saves, Tab saves and moves to the next category, Esc cancels. **Repeat...** in the editor opens the series
  editor with the typed amount. Right-click a category: Edit amount, Move money from here (pick target and amount), Repeat/Series, Copy name. Right-click a group: expand/collapse.
- Transactions table columns (Date, Category, Amount) resize by dragging the header edge, arrow keys on the edge (Shift for bigger steps), double-click to reset; widths are remembered in `localStorage`.

### Not done

- **Drag to reorder**: the phone data model has no order to write (account order is Actual's sidebar order, read-only; report and category order are not editable through the phone API), so nothing was added.
- Not covered: bulk notes editing in the UI (the route accepts `notes`), unhide for individual rows without the filter.
- One side effect: the phone API's 15 s read cache is not cleared by a web write (phones can show old values for up to 15 s).

## How it works

- `GET /api/chipmunk-mode` -> `{ enabled, entitled, reason, lastVerifiedAt, validUntil, mode }` (`mode` is `strict`, `dev` or `open`). `PUT` with `{ enabled }` (session
  auth, like the other settings). Stored in `chipmunk-mode.json` in the Insights data dir; missing file = off.
- All "is it available?" decisions go through `chipmunkEntitled()` in `api/src/chipmunk/entitlement.js`. `enabled` reported to the bundle is `stored && entitled`. Turning the mode
  on while not entitled is a 403, and the data routes below refuse too.
- Thin web routes `/api/chipmunk/{report-list,reports,accounts,transactions,transactions/suggest}` sit behind the
  normal Actual-session guard and call the **same builders** the phone API uses (`api/src/mobile/v1/*`); `/api/mobile/v1` is untouched. By design the web is the owner's, so
  "hidden from phone" accounts are not hidden here.

## Budget series on the web

The Budget screen calls `/api/chipmunk/budget/:month` and `/api/chipmunk/budget-series` (GET, POST, PUT `/:id`, DELETE `/:id`).
They call the phone's own `buildBudgetMonth`, `buildSeriesList`, `saveSeries` and `deleteSeries`, so every rule is shared:
one series per category (409 on a second), dry run changes nothing, create/update overwrite the covered months from the
later of the start month and now, past months are never touched, delete keeps months already written, writes are
audit-logged (as `web` instead of a token id), and the daily scheduler extends indefinite series as before. The web user is
the signed-in Actual user, so there is no read/write scope. The Budget screen offers series only (no separate "just this
month" write); "just this month" on the phone stays a phone feature. One side effect: the phone API's 15 s read cache is not
cleared by a web write, so a phone can show the old amounts for up to 15 s.

## Limits

Cards the phone renders from sankey/timeline/multiseries data show as a short placeholder on the web (the web's own
widgets already draw those, on the Reports page). Apart from budget series, these screens are read-only (no transaction or budget-amount editing).

## Subscription proof (who may turn it on)

Chipmunk mode is for people with an active Chipmunk subscription. The apps hold the store subscription and prove it to
*this* server; there is no Chipmunk backend. Contract: `POST`/`GET /api/mobile/v1/entitlement` in the Chipmunk repo's
`native-v1.schema.json` (`entitlementRequest`, `entitlementResponse`). Any valid device token may call it (read scope is
enough); POST counts against the write rate limit (20/min), GET against the read limit. Proofs are never logged or stored.

- **Apple**: the StoreKit 2 signed transaction. Verified offline with `@apple/app-store-server-library` against Apple's
  roots vendored in `api/src/chipmunk/apple-roots/` (Apple Root CA - G3, G2 and the older Apple Root CA, DER; SHA-256 pinned
  in code and checked on load; online OCSP checks are off, so verification needs no network). Bundle id
  `app.chipmunkbudget.chipmunk`, product `chipmunk.monthly` or `chipmunk.yearly`, environment Production or Sandbox.
  Expiry comes from the transaction.
- **Google**: the Play purchase JSON plus its signature, checked (RSA-SHA1, or SHA256) against `CHIPMUNK_PLAY_PUBLIC_KEY`
  (the base64 licensing public key from the Play Console). Package, product and `purchaseState 0` are required. Until the
  key is set, Google proofs answer `reason: not_configured`. Play JSON has no expiry, so only the check-in window applies.
- **Validity**: entitled iff the last accepted proof is at most 30 days + 7 days grace old and, for Apple, the transaction's
  own expiry + 7 days has not passed. A newer proof extends it; an older renewal period never rewinds a later one.
  Apps re-send daily. State is `chipmunk-entitlement.json` in the data dir: platform, product id, sha256 of the original
  transaction id, expiry, verification time.
- **Answers**: `verified`, `expired` (genuine proof, but the subscription or window ran out), `unverified` (bad signature,
  chain, bundle or product), `not_configured`, `none` (GET only, nothing ever sent). Bad bodies are 400.
- **Web**: the General tab toggle shows who verified it and until when, or how to unlock it, and a "Test mode" note when the
  server is not strict.

### Server mode: `CHIPMUNK_ENTITLEMENT_MODE`

| Value | Meaning |
|---|---|
| unset | **strict** (production). Everything above is enforced. |
| `dev` | Structurally valid Apple JWS is accepted without checking the certificate chain (Xcode StoreKit-testing transactions only verify here); Play signatures are not checked, and Google works without a key. Bundle id, product and expiry are still checked. Logs a loud warning at start. |
| `open` | Always entitled, no proof needed (demos). Reported as `reason: verified` with `lastVerifiedAt: null` until a proof has arrived, `validUntil: null`. |

Anyone with a device token can unlock Chipmunk mode on a `dev` or `open` server; never use them on a real server.

### Local testing with a dev proof

```sh
# demo server (Chipmunk repo tools/demo-server) in dev mode:
CHIPMUNK_ENTITLEMENT_MODE=dev ~/Code/chipmunk/tools/demo-server/demo-server.sh up   # the script passes the variable to the container
# mint a proof and post it (token from the environment, never echoed):
export CHIPMUNK_DEVICE_TOKEN=<token from Insights > Mobile app>
node api/tools/mint-dev-proof.js --post http://127.0.0.1:5181 --product yearly --days 30
node api/tools/mint-dev-proof.js            # just print the proof
```

A strict server answers `unverified` to these proofs by design. Nothing here has been tested against a real App Store or Play
purchase; the unit tests use a generated certificate chain trusted in place of Apple's roots.
