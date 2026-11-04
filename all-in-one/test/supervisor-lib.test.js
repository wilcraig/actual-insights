'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, nextDelayMs, restartsAfterRun, LinePrefixer, isOff, readPort, API_ONLY_SECRETS } = require('../supervisor-lib');

const svc = (plan, name) => plan.services.find((s) => s.name === name);
const FULL = { ACTUAL_SERVER_PASSWORD: 'pw', ACTUAL_SYNC_ID: 'sid', ACTUAL_E2E_PASSWORD: 'e2e', TZ: 'America/Denver' };

test('defaults: four services, one public port, everything else on loopback', () => {
  const p = buildPlan({});
  assert.equal(p.insightsEnabled, true);
  assert.equal(p.abtEnabled, true);
  assert.equal(p.front, 'insights-proxy');
  assert.equal(p.publicPort, 5006);
  assert.deepEqual(p.services.map((s) => s.name), ['actual', 'abt', 'insights-api', 'insights-proxy']);
  assert.equal(svc(p, 'actual').role, 'primary');
  assert.equal(svc(p, 'actual').env.ACTUAL_HOSTNAME, '127.0.0.1');
  assert.equal(svc(p, 'actual').env.ACTUAL_PORT, '25006');
  assert.equal(svc(p, 'abt').env.PORT, '25005');
  assert.equal(svc(p, 'abt').env.ACTUAL_ORIGIN, 'http://127.0.0.1:25006');
  assert.equal(svc(p, 'abt').env.ASSETS_DIR, '/opt/abt/assets');
  assert.equal(svc(p, 'abt').env.PACKAGE_JSON_PATH, '/opt/abt/package.json');
  assert.equal(svc(p, 'abt').cwd, '/opt/abt');
  assert.equal(svc(p, 'insights-proxy').env.PORT, '5006');
  assert.equal(svc(p, 'insights-proxy').env.ABT_ORIGIN, 'http://127.0.0.1:25005', 'the proxy sits in front of ABT');
  assert.equal(svc(p, 'insights-proxy').env.INSIGHTS_API_ORIGIN, 'http://127.0.0.1:25011');
  assert.equal(svc(p, 'insights-api').env.ACTUAL_SERVER_URL, 'http://127.0.0.1:25006', 'the API talks to Actual directly, not through ABT or the proxy');
  assert.equal(svc(p, 'insights-api').env.PORT, '25011');
});

test('only the API process sees the Actual password, sync id and e2e password', () => {
  const p = buildPlan(FULL);
  for (const key of API_ONLY_SECRETS) {
    for (const name of ['actual', 'abt', 'insights-proxy']) {
      assert.equal(svc(p, name).env[key], undefined, `${name} must not get ${key}`);
    }
    assert.equal(svc(p, 'insights-api').env[key], FULL[key], `api needs ${key}`);
  }
  assert.equal(svc(p, 'insights-api').env.TZ, 'America/Denver');
});

test('the API keeps its own data and budget cache under the Insights folder, not in Actual\'s data', () => {
  const p = buildPlan({ ACTUAL_DATA_DIR: '/data/' });
  const api = svc(p, 'insights-api');
  assert.equal(api.env.INSIGHTS_DATA_DIR, '/data/insights');
  assert.equal(api.env.ACTUAL_DATA_DIR, '/data/insights/cache');
  assert.equal(api.cwd, '/data/insights/cache');
  assert.equal(svc(p, 'actual').env.ACTUAL_DATA_DIR, '/data/');
});

test('workers wait for Actual; Actual never does', () => {
  const p = buildPlan({});
  assert.equal(svc(p, 'actual').after, undefined);
  for (const name of ['abt', 'insights-api', 'insights-proxy']) {
    assert.equal(svc(p, name).after, 'actual', name);
    assert.equal(svc(p, name).role, 'worker', name);
  }
});

test('a custom public port moves only the outermost layer; internal ports stay put', () => {
  const p = buildPlan({ ACTUAL_PORT: '8080' });
  assert.equal(p.publicPort, 8080);
  assert.equal(svc(p, 'insights-proxy').env.PORT, '8080');
  assert.equal(svc(p, 'abt').env.PORT, '25005');
  assert.equal(svc(p, 'actual').env.ACTUAL_PORT, '25006');
  assert.equal(p.healthUrl, 'http://127.0.0.1:8080/health');
});

test('trusted proxies: loopback plus the defaults, unless the owner sets their own', () => {
  assert.match(svc(buildPlan({}), 'actual').env.ACTUAL_TRUSTED_PROXIES, /127\.0\.0\.1\/32/);
  assert.equal(svc(buildPlan({ ACTUAL_TRUSTED_PROXIES: '10.1.0.0/16' }), 'actual').env.ACTUAL_TRUSTED_PROXIES, '10.1.0.0/16');
});

test('ABT_ENABLED off: no ABT process, and the Insights proxy goes straight to Actual', () => {
  for (const off of ['false', 'FALSE', '0', 'no', 'off', ' Off ']) {
    const p = buildPlan({ ABT_ENABLED: off, ...FULL });
    assert.equal(p.abtEnabled, false, off);
    assert.equal(p.front, 'insights-proxy');
    assert.deepEqual(p.services.map((s) => s.name), ['actual', 'insights-api', 'insights-proxy']);
    assert.equal(svc(p, 'insights-proxy').env.ABT_ORIGIN, 'http://127.0.0.1:25006');
    assert.match(p.warnings.join(' '), /ABT_ENABLED is off/);
  }
  for (const on of [undefined, '', 'true', '1', 'yes', 'anything']) assert.equal(isOff(on), false, String(on));
});

test('INSIGHTS_ENABLED off: ABT becomes the public layer and no Insights process runs', () => {
  const p = buildPlan({ INSIGHTS_ENABLED: 'false', ...FULL });
  assert.equal(p.insightsEnabled, false);
  assert.equal(p.front, 'abt');
  assert.deepEqual(p.services.map((s) => s.name), ['actual', 'abt']);
  assert.equal(svc(p, 'abt').env.PORT, '5006');
  assert.equal(svc(p, 'abt').env.ACTUAL_ORIGIN, 'http://127.0.0.1:25006');
  assert.equal(svc(p, 'actual').env.ACTUAL_HOSTNAME, '127.0.0.1');
  for (const key of API_ONLY_SECRETS) assert.equal(svc(p, 'abt').env[key], undefined);
  assert.match(p.warnings.join(' '), /INSIGHTS_ENABLED is off/);
  assert.doesNotMatch(p.warnings.join(' '), /ACTUAL_SERVER_PASSWORD/, 'no password warning when Insights is off');
});

test('both layers off: plain Actual on the public port, exactly like the official image', () => {
  const p = buildPlan({ ACTUAL_PORT: '5006', INSIGHTS_ENABLED: 'false', ABT_ENABLED: 'false', ...FULL });
  assert.equal(p.front, 'actual');
  assert.deepEqual(p.services.map((s) => s.name), ['actual']);
  assert.equal(svc(p, 'actual').env.ACTUAL_PORT, '5006');
  assert.equal(svc(p, 'actual').env.ACTUAL_HOSTNAME, undefined);
  assert.equal(svc(p, 'actual').env.ACTUAL_TRUSTED_PROXIES, undefined);
  for (const key of API_ONLY_SECRETS) assert.equal(svc(p, 'actual').env[key], undefined);
  assert.match(p.warnings.join(' '), /both off/);
});

test('warnings say exactly what is missing and never contain a secret', () => {
  const none = buildPlan({});
  assert.equal(none.warnings.length, 2);
  assert.match(none.warnings[0], /ACTUAL_SERVER_PASSWORD/);
  assert.match(none.warnings[1], /ACTUAL_SYNC_ID/);
  assert.equal(buildPlan({ ACTUAL_SERVER_PASSWORD: 'p' }).warnings.length, 1);
  const configured = buildPlan({ ACTUAL_SERVER_PASSWORD: 'hunter2', ACTUAL_SYNC_ID: 'abc-123' });
  assert.deepEqual(configured.warnings, []);
  assert.doesNotMatch(JSON.stringify(none.warnings), /hunter2/);
});

test('bad or clashing ports are rejected with a message naming the setting', () => {
  assert.throws(() => buildPlan({ ACTUAL_PORT: 'abc' }), /ACTUAL_PORT/);
  assert.throws(() => buildPlan({ ACTUAL_PORT: '0' }), /ACTUAL_PORT/);
  assert.throws(() => buildPlan({ ACTUAL_PORT: '65536' }), /ACTUAL_PORT/);
  assert.throws(() => buildPlan({ INSIGHTS_API_PORT: '70000' }), /INSIGHTS_API_PORT/);
  assert.throws(() => buildPlan({ INSIGHTS_ABT_PORT: 'x' }), /INSIGHTS_ABT_PORT/);
  assert.throws(() => buildPlan({ ACTUAL_PORT: '25006' }), /must all differ/);
  assert.throws(() => buildPlan({ INSIGHTS_ACTUAL_PORT: '25011' }), /must all differ/);
  assert.throws(() => buildPlan({ INSIGHTS_ABT_PORT: '25011' }), /must all differ/);
  assert.throws(() => buildPlan({ ACTUAL_PORT: '25005' }), /must all differ/);
  // A port that only exists when its layer is on is not validated when the layer is off.
  assert.doesNotThrow(() => buildPlan({ ABT_ENABLED: 'false', INSIGHTS_ABT_PORT: 'junk' }));
  assert.doesNotThrow(() => buildPlan({ INSIGHTS_ENABLED: 'false', INSIGHTS_API_PORT: 'junk' }));
  assert.equal(readPort('', 7, 'X'), 7);
  assert.equal(readPort(undefined, 7, 'X'), 7);
  assert.equal(readPort(' 8080 ', 7, 'X'), 8080);
});

test('restart backoff doubles from 1s and caps at 30s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(nextDelayMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(nextDelayMs(-3), 1000);
});

test('a process that ran a minute starts its backoff over; a quick crash does not', () => {
  assert.equal(restartsAfterRun(4, 59999), 5);
  assert.equal(restartsAfterRun(4, 60000), 0);
  assert.equal(restartsAfterRun(0, 100), 1);
});

test('line prefixer joins split chunks, handles CRLF, and flushes a final partial line', () => {
  const out = [];
  const lp = new LinePrefixer('[api]', (l) => out.push(l));
  lp.push(Buffer.from('hel'));
  lp.push(Buffer.from('lo\nsecond\r\nthi'));
  assert.deepEqual(out, ['[api] hello', '[api] second']);
  lp.flush();
  assert.deepEqual(out, ['[api] hello', '[api] second', '[api] thi']);
  lp.flush();
  assert.equal(out.length, 3);
  lp.push(Buffer.from('a\n\nb\n'));
  assert.deepEqual(out.slice(3), ['[api] a', '[api] ', '[api] b']);
});
