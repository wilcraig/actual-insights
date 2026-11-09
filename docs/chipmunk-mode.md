# Chipmunk mode

## What it is

Chipmunk mode (server-side setting, default **off**) turns the **whole** web app into Chipmunk: with it on, loading any Actual URL
shows a full-viewport Chipmunk shell over Actual's UI. Off, nothing changes for anyone (the bundle runs Actual's side
synchronously, exactly as before; the only addition is one non-blocking `GET /api/chipmunk-mode`, skipped for a minute after a cached "off").

Same menus, names, behaviours and visual language as the phone/Mac app, laid out for a desktop browser (it is not a stretched phone UI).
Phone width works as a fallback (sidebar becomes a hamburger drawer).

| Screen | Phone behaviour kept | Desktop additions |
|---|---|---|
| **Reports** (home) | title dropdown of every dashboard page / saved report, cards in server order, donut month arrows, choice remembered | cards in an auto-fill grid (3+ columns on wide screens) |
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

### Not done yet

Bulk actions on selected transactions (categorize, hide/exclude; needs new server routes), inline editing of budget amounts, drag to reorder,
right-click context menus, hover tooltips on charts, resizable table columns. The server contract is unchanged (`/api/chipmunk/*` and `/api/mobile/v1`).

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
