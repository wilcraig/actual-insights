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

- `GET /api/chipmunk-mode` -> `{ enabled, entitled, reason, lastVerifiedAt, validUntil, mode }` (`mode` is `strict`, `dev` or `open`). `PUT` with `{ enabled }` (session
  auth, like the other settings). Stored in `chipmunk-mode.json` in the Insights data dir; missing file = off.
- All "is it available?" decisions go through `chipmunkEntitled()` in `api/src/chipmunk/entitlement.js`, which returns
  `{ entitled, reason, lastVerifiedAt, validUntil }` from the stored subscription proof (see below). `enabled` reported to the bundle is `stored && entitled`. Turning the mode
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
