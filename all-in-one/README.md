# All-in-one image

One container that runs **Actual Budget**, **Actual Budget Tweaks (ABT)** and **Actual Insights** behind a single port.
It exists for hosts that run one image on one HTTPS port (for example PikaPods) and to make a self-hosted install a single
`docker run`. Each optional layer can be switched off.

```
browser --> :5006  insights-proxy  --> abt (loopback) --> actual (loopback)
                        |
                        +-- /api/*  --> insights-api (loopback) --> actual (loopback, direct)
```

The outermost enabled layer owns the public port. The Insights API always talks to Actual directly.

## Quick start

```bash
docker build -f all-in-one/Dockerfile -t actual-insights-aio .
docker run -d --name actual -p 5006:5006 -v "$PWD/data:/data" -e TZ=America/Denver actual-insights-aio
```

1. Open `http://localhost:5006`, set your server password and create (or import) your budget.
2. Let Insights read it: set `ACTUAL_SERVER_PASSWORD` (the password you just chose) and `ACTUAL_SYNC_ID` (Actual:
   Settings, Show advanced settings, Sync ID), then restart the container. Until then Actual works normally and the
   Insights charts and mobile summary stay unavailable. The log says so.

A compose example is in `docker-compose.example.yml`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `ACTUAL_PORT` | `5006` | The one public port. |
| `ACTUAL_SERVER_PASSWORD` | unset | Needed by Insights only. Never passed to Actual, ABT or the proxy. |
| `ACTUAL_SYNC_ID` | unset | Needed by Insights only. |
| `ACTUAL_E2E_PASSWORD` | unset | Only if the budget uses end-to-end encryption. Insights only. |
| `TZ` | UTC | Used by Insights for day and month boundaries. |
| `INSIGHTS_ENABLED` | on | `false` runs without Actual Insights. |
| `ABT_ENABLED` | on | `false` runs without Actual Budget Tweaks. |
| `INSIGHTS_ACTUAL_PORT`, `INSIGHTS_ABT_PORT`, `INSIGHTS_API_PORT` | 25006, 25005, 25011 | Loopback ports. Change only on a clash. |
| `ACTUAL_TRUSTED_PROXIES` | loopback plus Actual's defaults | Passed to Actual when a layer sits in front of it. |

Any other `ACTUAL_*` variable (`ACTUAL_UPLOAD_FILE_SIZE_LIMIT_MB`, OpenID settings, and so on) goes to Actual untouched.
`INSIGHTS_ENABLED=false` and `ABT_ENABLED=false` together give plain Actual, exactly like the official image.

## Data

One mount, `/data`: Actual's own `server-files` and `user-files`, plus `/data/insights` (`mobile-tokens.json`, goals,
channel settings, and `cache/`, the Insights API's local copy of the budget so a restart does not re-download it).
Migrating from the multi-container setup: copy your old `insights-data` folder to `data/insights`.

## What runs, and what happens when it fails

`supervisor.js` starts Actual first, waits for its health check, then starts the others.

- If **Actual** exits, everything stops and the container exits non-zero, so the platform restarts it.
- If **ABT, the Insights API or the Insights proxy** exits, only that process restarts, with backoff (1s, 2s, 4s ... 30s;
  a process that stayed up a minute starts over). Actual keeps serving.
- On `SIGTERM` everything is stopped and the container exits 0 (a second or so in practice).
- Log lines are prefixed `[supervisor]`, `[actual]`, `[abt]`, `[insights-api]`, `[insights-proxy]`.

## Security notes

- Only the proxy's port is exposed. Actual, ABT and the API listen on `127.0.0.1`.
- `ACTUAL_SERVER_PASSWORD`, `ACTUAL_SYNC_ID` and `ACTUAL_E2E_PASSWORD` are visible to the Insights API process only.
- The container runs as root, like the official Actual image.
- ABT replaces the page's Content-Security-Policy with a same-origin one and relays stock-chart requests for ticker
  symbols to `query2.finance.yahoo.com`. Details and licenses are in `THIRD-PARTY.md`.
- The mobile summary endpoint sends no CORS headers and accepts device tokens only; the smoke test checks both.

## ABT and Actual Insights overlap

Both are injected into the same page and some features do the same job. This is from reading both projects' code and
READMEs; it has not been checked in a running browser, so treat the "if both are on" column as likely, not proven.

| Area | Actual Insights | ABT | With both on |
|---|---|---|---|
| Spending calendar | Reports widget | Spending Calendar view | Two calendars in different places. Works, confusing. |
| Colour theme | "Fresh" theme: redefines about 90 palette variables with `!important` | Community themes and a palette editor | Fresh most likely wins, so ABT's theme picker would appear to do nothing while Fresh is on. Use one. |
| Sidebar | Adds an "Insights" item by cloning Reports | "Live sidebar" replaces Actual's sidebar | Insights re-adds its item whenever either sidebar re-renders. Works, but both watch the same DOM. |
| Month overview | Pacing bars, projected month-end net, summaries | "Budget Insights" side panel | Two similar panels with near-identical names. |

If you only want one of them, set `ABT_ENABLED=false` or `INSIGHTS_ENABLED=false`.

## Upgrading

- **Actual:** change `ACTUAL_VERSION` (build argument) and `@actual-app/api` in `api/package.json` to the same version.
  The build fails on purpose if they differ.
- **ABT:** change `ABT_IMAGE` (tag and digest). Read the new `server.js` and `browser-shim.js` first; the image copies
  them unmodified. Check for new outbound hosts in its Content-Security-Policy.
- Then run the tests below.

## Tests

```bash
node --test all-in-one/test/*.test.js   # the process plan: ports, environment, restart backoff
all-in-one/test/smoke.sh --build         # builds, then runs the whole image against a synthetic budget
```

The smoke test needs Docker, curl, python3 and node. It never touches real data and prints the one volume it leaves behind.

## Limits

- Built and tested here for `linux/arm64` only. A multi-architecture release needs `docker buildx`.
- Idle memory is about 410 MB with all layers (about 250 MB for plain Actual). A host that bills by memory needs at least 512 MB.
- The two-step setup (create the budget, then set the password and sync id) is inherent: Actual's password is chosen in
  its own UI, and the Insights API needs it as a setting.
- Not yet run on PikaPods or any other host.
