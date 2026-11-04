'use strict';
// Container health: the public port answers and Actual reports UP through it (which also proves the proxy is passing traffic).
const port = Number(process.env.ACTUAL_PORT) || 5006;
fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(8000) })
  .then((r) => r.json())
  .then((b) => {
    if (!b || b.status !== 'UP') throw new Error(`status ${b && b.status}`);
  })
  .catch((e) => {
    console.log(`health check failed: ${e.message}`);
    process.exit(1);
  });
