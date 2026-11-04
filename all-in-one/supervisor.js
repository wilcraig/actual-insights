#!/usr/bin/env node
'use strict';
// Runs Actual Budget, the Actual Insights API and the Insights proxy inside one container.
// What to run comes from supervisor-lib.js (tested). This file only starts, restarts and stops processes.
//
//  - Actual is the primary: if it exits, everything stops and the container exits non-zero so the platform restarts it.
//  - The API and the proxy are workers: they restart on exit with backoff and never take Actual down.
//  - SIGTERM/SIGINT: stop restarting, ask everything to stop, force-kill after 10 s, exit 0.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { buildPlan, nextDelayMs, restartsAfterRun, LinePrefixer } = require('./supervisor-lib');

const STOP_GRACE_MS = 10000;
const ACTUAL_WAIT_MS = 120000;

const log = (line) => process.stdout.write(`${line}\n`);
const note = (msg) => log(`[supervisor] ${msg}`);

let plan;
try {
  plan = buildPlan(process.env);
} catch (err) {
  note(`configuration error: ${err.message}`);
  process.exit(2);
}

const running = new Map(); // name -> { child, startedAt }
const restarts = new Map(); // name -> consecutive quick restarts
let stopping = false;
let exitCode = 0;

function start(svc) {
  const child = spawn(svc.command, svc.args, { cwd: svc.cwd, env: svc.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = new LinePrefixer(`[${svc.name}]`, log);
  const err = new LinePrefixer(`[${svc.name}]`, log);
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));
  const entry = { child, startedAt: Date.now() };
  running.set(svc.name, entry);
  child.on('error', (e) => note(`${svc.name}: could not start: ${e.message}`));
  child.on('exit', (code, signal) => {
    out.flush();
    err.flush();
    running.delete(svc.name);
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (stopping) {
      note(`${svc.name} stopped (${how})`);
      maybeFinish();
      return;
    }
    if (svc.role === 'primary') {
      note(`${svc.name} exited unexpectedly (${how}); shutting down so the platform can restart the container`);
      shutdown(code === 0 || code === null ? 1 : code);
      return;
    }
    const n = restartsAfterRun(restarts.get(svc.name) || 0, Date.now() - entry.startedAt);
    restarts.set(svc.name, n);
    const delay = nextDelayMs(n - 1 < 0 ? 0 : n - 1);
    note(`${svc.name} exited (${how}); restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => { if (!stopping) start(svc); }, delay).unref?.();
  });
}

function maybeFinish() {
  if (stopping && running.size === 0) process.exit(exitCode);
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  note('stopping');
  for (const { child } of running.values()) child.kill('SIGTERM');
  const force = setTimeout(() => {
    for (const [name, { child }] of running) {
      note(`${name} did not stop in ${STOP_GRACE_MS / 1000}s; killing it`);
      child.kill('SIGKILL');
    }
  }, STOP_GRACE_MS);
  force.unref();
  maybeFinish();
}

async function waitForActual(url) {
  const deadline = Date.now() + ACTUAL_WAIT_MS;
  while (!stopping && Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      const body = await res.json();
      if (body && body.status === 'UP') return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  for (const w of plan.warnings) note(`warning: ${w}`);
  const parts = ['Actual', plan.abtEnabled && 'Actual Budget Tweaks', plan.insightsEnabled && 'Actual Insights'].filter(Boolean).join(' + ');
  note(`starting ${parts}; public port ${plan.publicPort} served by ${plan.front}`);

  if (plan.insightsEnabled) fs.mkdirSync(plan.cacheDir, { recursive: true });

  for (const svc of plan.services.filter((s) => !s.after)) start(svc);

  const workers = plan.services.filter((s) => s.after);
  if (workers.length) {
    const up = await waitForActual(plan.actualHealthUrl);
    if (stopping) return;
    note(up ? 'Actual is up; starting the Insights services' : `Actual did not report UP within ${ACTUAL_WAIT_MS / 1000}s; starting the Insights services anyway`);
    for (const svc of workers) start(svc);
  }
}

main().catch((e) => {
  note(`fatal: ${e.message}`);
  shutdown(1);
});
