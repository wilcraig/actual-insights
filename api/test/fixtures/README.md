# Native v1 contract fixtures

`native-v1.schema.json` and `native-v1.examples.json` are copies of the
contract owned by the Chipmunk repo (`shared/contracts/` in `~/Code/chipmunk`),
copied on 2026-11-06 and refreshed on 2026-11-07 (pacing drill, /spending) and again
on 2026-11-07 (navigation, transaction detail, report list, chart types). The schema is the contract: every response of
`/api/mobile/v1` is validated against it in `routes/mobile-v1.test.js`. Do not
edit these files here; change them in the Chipmunk repo and copy them over.
