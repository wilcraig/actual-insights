# Third-party software in the all-in-one image

| Component | Version | License | Source |
|---|---|---|---|
| Actual Budget (server and web app) | `ACTUAL_VERSION` build argument, 26.10.0 by default | MIT | https://github.com/actualbudget/actual, taken from the official `ghcr.io/actualbudget/actual` image |
| Actual Budget Tweaks (ABT sidecar) | 0.1.100 | MIT, Copyright (c) 2025-2026 Alexis Vielma | https://github.com/aelxxs/actual-budget-tweaks, files copied unmodified from `ghcr.io/aelxxs/abt-sidecar` pinned by digest |
| Actual Insights (this repository) | this commit | MIT | this repository |

ABT's license text is installed in the image at `/opt/abt/LICENSE`. The ABT files in the image are exactly the ones in the
pinned `abt-sidecar` image: `server.js`, `browser-shim.js`, `package.json` and the `assets/` folder. Nothing is patched.

What ABT does at runtime, for anyone reviewing the image: it is a reverse proxy in front of Actual that injects its UI
scripts into the HTML, replaces the page's Content-Security-Policy with a stricter same-origin one, serves its own
assets, and relays stock-chart requests from the page to `query2.finance.yahoo.com` (the relay only accepts same-origin
requests for ticker symbols). Turn it off with `ABT_ENABLED=false`.
