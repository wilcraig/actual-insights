'use strict';
// Pure helpers for the all-in-one supervisor: what to run, with which environment, and how to
// restart it. No process, network or file access here, so all of it is unit tested.

const DEFAULTS = {
  publicPort: 5006, // the one port the image exposes (what Actual itself uses by default)
  actualPort: 25006, // Actual, loopback only, when ABT or Insights is in front of it
  abtPort: 25005, // Actual Budget Tweaks, loopback only, when Insights is in front of it
  apiPort: 25011, // Actual Insights API, loopback only
  dataDir: '/data',
};

// Only the Insights API may see these. Actual and the proxy never need them.
const API_ONLY_SECRETS = ['ACTUAL_SERVER_PASSWORD', 'ACTUAL_SYNC_ID', 'ACTUAL_E2E_PASSWORD'];

// Actual's own default trusted-proxy list plus loopback, because the Insights proxy reaches Actual over 127.0.0.1.
const DEFAULT_TRUSTED_PROXIES = '127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7';

const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
const STABLE_AFTER_MS = 60000; // a process that ran this long starts its backoff over

function isOff(value) {
  return /^(0|false|no|off)$/i.test(String(value === undefined ? '' : value).trim());
}

function readPort(value, fallback, name) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const text = String(value).trim();
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1 || n > 65535) throw new Error(`${name} must be a port number from 1 to 65535, got "${text}"`);
  return n;
}

function without(env, keys) {
  const copy = { ...env };
  for (const k of keys) delete copy[k];
  return copy;
}

// What the container runs, as data. `role` is 'primary' (if it exits the container exits, so the
// platform restarts everything) or 'worker' (restarted with backoff). `after: 'actual'` means
// start once Actual answers its health check.
//
// Request path, outermost first, with each optional layer switchable:
//   browser -> insights-proxy (INSIGHTS_ENABLED) -> abt (ABT_ENABLED) -> actual
// The outermost enabled layer listens on the public port; everything behind it is on loopback.
// The Insights API talks to Actual directly, never through the layers in front.
function buildPlan(env = {}) {
  const publicPort = readPort(env.ACTUAL_PORT, DEFAULTS.publicPort, 'ACTUAL_PORT');
  const insights = !isOff(env.INSIGHTS_ENABLED);
  const abt = !isOff(env.ABT_ENABLED);
  const dataDir = (env.ACTUAL_DATA_DIR && String(env.ACTUAL_DATA_DIR).trim()) || DEFAULTS.dataDir;
  const front = insights ? 'insights-proxy' : abt ? 'abt' : 'actual';
  const warnings = [];

  const actualPort = front === 'actual' ? publicPort : readPort(env.INSIGHTS_ACTUAL_PORT, DEFAULTS.actualPort, 'INSIGHTS_ACTUAL_PORT');
  const abtPort = !abt ? null : front === 'abt' ? publicPort : readPort(env.INSIGHTS_ABT_PORT, DEFAULTS.abtPort, 'INSIGHTS_ABT_PORT');
  const apiPort = insights ? readPort(env.INSIGHTS_API_PORT, DEFAULTS.apiPort, 'INSIGHTS_API_PORT') : null;
  // Every listener must have its own port. The outermost layer IS the public port, so count it once.
  const listeners = [['ACTUAL_PORT', publicPort]];
  if (front !== 'actual') listeners.push(['INSIGHTS_ACTUAL_PORT', actualPort]);
  if (abt && front !== 'abt') listeners.push(['INSIGHTS_ABT_PORT', abtPort]);
  if (insights) listeners.push(['INSIGHTS_API_PORT', apiPort]);
  if (new Set(listeners.map(([, p]) => p)).size !== listeners.length) {
    throw new Error(`${listeners.map(([n, p]) => `${n} (${p})`).join(', ')} must all differ`);
  }

  if (!insights && !abt) warnings.push('INSIGHTS_ENABLED and ABT_ENABLED are both off: running plain Actual Budget.');
  else if (!insights) warnings.push('INSIGHTS_ENABLED is off: Actual Insights is not running (ABT only).');
  else if (!abt) warnings.push('ABT_ENABLED is off: Actual Budget Tweaks is not running (Actual Insights only).');
  if (insights && !env.ACTUAL_SERVER_PASSWORD) {
    warnings.push('ACTUAL_SERVER_PASSWORD is not set: Actual works, but the Insights charts and the mobile summary stay unavailable until you set it (the same password you use to sign in to Actual) and restart.');
  }
  if (insights && !env.ACTUAL_SYNC_ID) {
    warnings.push('ACTUAL_SYNC_ID is not set: Insights cannot find your budget. Copy it from Actual under Settings, Show advanced settings, Sync ID, set it, and restart.');
  }

  const nodeBin = 'node';
  const base = without(env, API_ONLY_SECRETS);
  const actualUrl = `http://127.0.0.1:${actualPort}`;
  const insightsDir = `${dataDir.replace(/\/+$/, '')}/insights`;
  const cacheDir = `${insightsDir}/cache`;
  const services = [];

  services.push({
    name: 'actual',
    role: 'primary',
    command: nodeBin,
    args: ['app.js'],
    cwd: '/app',
    env: front === 'actual'
      ? base // exactly the official image's behaviour
      : {
          ...base,
          ACTUAL_PORT: String(actualPort),
          ACTUAL_HOSTNAME: '127.0.0.1',
          ACTUAL_TRUSTED_PROXIES: env.ACTUAL_TRUSTED_PROXIES || DEFAULT_TRUSTED_PROXIES,
        },
  });

  if (abt) {
    services.push({
      name: 'abt',
      role: 'worker',
      after: 'actual',
      command: nodeBin,
      args: ['server.js'],
      cwd: '/opt/abt',
      env: {
        ...base,
        PORT: String(abtPort),
        ACTUAL_ORIGIN: actualUrl,
        ASSETS_DIR: '/opt/abt/assets',
        PACKAGE_JSON_PATH: '/opt/abt/package.json',
      },
    });
  }

  if (insights) {
    services.push({
      name: 'insights-api',
      role: 'worker',
      after: 'actual',
      command: nodeBin,
      args: ['/opt/insights/api/src/server.js'],
      cwd: cacheDir,
      env: {
        ...env, // the API is the one process that gets the secrets
        PORT: String(apiPort),
        ACTUAL_SERVER_URL: actualUrl,
        // @actual-app/api keeps its local copy of the budget here, so a restart does not re-download it.
        ACTUAL_DATA_DIR: cacheDir,
        INSIGHTS_DATA_DIR: insightsDir,
      },
    });
    services.push({
      name: 'insights-proxy',
      role: 'worker',
      after: 'actual',
      command: nodeBin,
      args: ['/opt/insights/proxy/src/server.js'],
      cwd: '/opt/insights/proxy',
      env: {
        ...base,
        PORT: String(publicPort),
        // The proxy's upstream is ABT when it runs, otherwise Actual directly.
        ABT_ORIGIN: abt ? `http://127.0.0.1:${abtPort}` : actualUrl,
        INSIGHTS_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        STATIC_DIR: '/opt/insights/static',
      },
    });
  }

  return {
    insightsEnabled: insights,
    abtEnabled: abt,
    front,
    publicPort,
    dataDir,
    insightsDir,
    cacheDir,
    warnings,
    healthUrl: `http://127.0.0.1:${publicPort}/health`,
    actualHealthUrl: `${actualUrl}/health`,
    services,
  };
}

// Delay before restart number `restarts` (0 for the first restart): 1s, 2s, 4s ... capped at 30s.
function nextDelayMs(restarts) {
  const n = Math.max(0, Math.floor(restarts));
  return Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(n, 16));
}

// A process that stayed up for STABLE_AFTER_MS earned a fresh backoff.
function restartsAfterRun(previousRestarts, uptimeMs) {
  return uptimeMs >= STABLE_AFTER_MS ? 0 : previousRestarts + 1;
}

// Splits a stream into whole lines and prefixes each one, holding a partial last line until it completes.
class LinePrefixer {
  constructor(prefix, write) {
    this.prefix = prefix;
    this.write = write;
    this.rest = '';
  }
  push(chunk) {
    const text = this.rest + chunk.toString('utf8');
    const lines = text.split('\n');
    this.rest = lines.pop();
    for (const line of lines) this.write(`${this.prefix} ${line.replace(/\r$/, '')}`);
  }
  flush() {
    if (this.rest !== '') this.write(`${this.prefix} ${this.rest}`);
    this.rest = '';
  }
}

module.exports = { DEFAULTS, API_ONLY_SECRETS, DEFAULT_TRUSTED_PROXIES, STABLE_AFTER_MS, isOff, readPort, buildPlan, nextDelayMs, restartsAfterRun, LinePrefixer };
