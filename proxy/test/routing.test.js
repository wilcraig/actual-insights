const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');

// Starts a stub origin that records every request path AND headers it
// receives, and answers with `label` after a small delay (so concurrent
// requests actually overlap in flight, the condition that reproduces
// header/connection-reuse bugs — a stub that answers instantly never does).
function startStub(label, { delayMs = 0 } = {}) {
  const received = [];
  const receivedHeaders = [];
  const server = http.createServer((req, res) => {
    received.push(req.url);
    receivedHeaders.push(req.headers);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ origin: label, url: req.url }));
    }, delayMs);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, received, receivedHeaders, url: `http://127.0.0.1:${server.address().port}` })
    )
  );
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

describe('request routing', () => {
  let abt;
  let api;
  let proxy;
  let proxyPort;

  beforeAll(async () => {
    abt = await startStub('abt');
    api = await startStub('api');
    const app = createApp({ abtOrigin: abt.url, apiOrigin: api.url });
    proxy = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => proxy.once('listening', resolve));
    proxyPort = proxy.address().port;
  });

  afterAll(() => {
    proxy.close();
    abt.server.close();
    api.server.close();
  });

  beforeEach(() => {
    abt.received.length = 0;
    api.received.length = 0;
  });

  test('/api/* is proxied to the insights-api origin with the path preserved', async () => {
    const res = await get(proxyPort, '/api/budget-pacing?month=2026-10');

    expect(JSON.parse(res.body)).toEqual({ origin: 'api', url: '/api/budget-pacing?month=2026-10' });
    expect(api.received).toEqual(['/api/budget-pacing?month=2026-10']);
    expect(abt.received).toEqual([]);
  });

  test('other paths are proxied to the abt origin', async () => {
    const res = await get(proxyPort, '/accounts/123');

    expect(JSON.parse(res.body)).toEqual({ origin: 'abt', url: '/accounts/123' });
    expect(abt.received).toEqual(['/accounts/123']);
    expect(api.received).toEqual([]);
  });

  test('a path that merely starts with the letters api is not treated as /api/', async () => {
    const res = await get(proxyPort, '/apiary/list');

    expect(JSON.parse(res.body)).toEqual({ origin: 'abt', url: '/apiary/list' });
    expect(abt.received).toEqual(['/apiary/list']);
    expect(api.received).toEqual([]);
  });

  test('unmatched bundle-prefix paths return 404 and reach neither origin', async () => {
    const res = await get(proxyPort, '/insights/missing.js');

    expect(res.status).toBe(404);
    expect(abt.received).toEqual([]);
    expect(api.received).toEqual([]);
  });

  test('hop-by-hop headers are not forwarded upstream', async () => {
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/accounts/123', headers: { connection: 'keep-alive' } },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.end();
    });

    // Node sets its own `connection` header once (`close`, from `agent: false`)
    // — the assertion is that the *client's* value ("keep-alive") never
    // reaches upstream verbatim, not that the header is absent entirely.
    expect(abt.receivedHeaders[0].connection).not.toBe('keep-alive');
  });

  test('many concurrent requests to the same origin each get their own matching response, not a mismatched one', async () => {
    // Reproduces the real bug: forwarding hop-by-hop headers (or reusing a
    // single keep-alive socket incorrectly) under concurrent load corrupts
    // response framing, so a request for path N can come back with path M's
    // body. A fast, non-delayed stub never overlaps requests in flight, so
    // this needs the delayed stub set up below instead of the shared one.
    const delayedAbt = await startStub('abt-delayed', { delayMs: 20 });
    const app = createApp({ abtOrigin: delayedAbt.url, apiOrigin: api.url });
    const concurrentProxy = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => concurrentProxy.once('listening', resolve));
    const port = concurrentProxy.address().port;

    try {
      const paths = Array.from({ length: 20 }, (_, i) => `/item/${i}`);
      const results = await Promise.all(paths.map((p) => get(port, p)));
      results.forEach((res, i) => {
        expect(JSON.parse(res.body)).toEqual({ origin: 'abt-delayed', url: paths[i] });
      });
    } finally {
      concurrentProxy.close();
      delayedAbt.server.close();
    }
  });
});

describe('cache-busted bundle tags', () => {
  let abt;
  let api;
  let staticDir;

  beforeEach(async () => {
    abt = await startStub('abt');
    api = await startStub('api');
    staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insights-proxy-static-'));
  });

  afterEach(() => {
    abt.server.close();
    api.server.close();
    fs.rmSync(staticDir, { recursive: true, force: true });
  });

  function htmlStub(label) {
    // Overrides the shared JSON stub above with one that returns real HTML,
    // since only an HTML response goes through the inject-tags rewrite path.
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>hi</p></body></html>');
    });
    return new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
    );
  }

  test('the injected script/link tags carry a cache-busting query derived from the file\'s mtime', async () => {
    fs.writeFileSync(path.join(staticDir, 'bundle.js'), 'console.log(1)');
    fs.writeFileSync(path.join(staticDir, 'bundle.css'), 'body{}');
    const htmlOrigin = await htmlStub('abt-html');
    const app = createApp({ abtOrigin: htmlOrigin.url, apiOrigin: api.url, staticDir });
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => proxy.once('listening', resolve));

    try {
      const res = await get(proxy.address().port, '/reports');
      const jsMtime = Math.floor(fs.statSync(path.join(staticDir, 'bundle.js')).mtimeMs);
      const cssMtime = Math.floor(fs.statSync(path.join(staticDir, 'bundle.css')).mtimeMs);
      expect(res.body).toContain(`<script src="/insights/bundle.js?v=${jsMtime}"></script>`);
      expect(res.body).toContain(`<link rel="stylesheet" href="/insights/bundle.css?v=${cssMtime}">`);
    } finally {
      proxy.close();
      htmlOrigin.server.close();
    }
  });

  test('the cache-busting query changes after bundle.js is rebuilt (newer mtime)', async () => {
    const jsPath = path.join(staticDir, 'bundle.js');
    fs.writeFileSync(jsPath, 'console.log(1)');
    fs.utimesSync(jsPath, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const htmlOrigin = await htmlStub('abt-html');
    const app = createApp({ abtOrigin: htmlOrigin.url, apiOrigin: api.url, staticDir });
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => proxy.once('listening', resolve));

    try {
      const first = await get(proxy.address().port, '/reports');
      const firstMatch = first.body.match(/bundle\.js\?v=(\d+)/);
      expect(firstMatch).not.toBeNull();

      // Simulate a rebuild: same file, newer mtime.
      fs.utimesSync(jsPath, new Date(2030, 0, 1), new Date(2030, 0, 1));

      const second = await get(proxy.address().port, '/reports');
      const secondMatch = second.body.match(/bundle\.js\?v=(\d+)/);
      expect(secondMatch).not.toBeNull();
      expect(secondMatch[1]).not.toBe(firstMatch[1]);
    } finally {
      proxy.close();
      htmlOrigin.server.close();
    }
  });

  test('falls back to no cache-busting query when the static file does not exist yet', async () => {
    // staticDir is empty -- no bundle.js/bundle.css written.
    const htmlOrigin = await htmlStub('abt-html');
    const app = createApp({ abtOrigin: htmlOrigin.url, apiOrigin: api.url, staticDir });
    const proxy = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => proxy.once('listening', resolve));

    try {
      const res = await get(proxy.address().port, '/reports');
      expect(res.body).toContain('<script src="/insights/bundle.js"></script>');
      expect(res.body).toContain('<link rel="stylesheet" href="/insights/bundle.css">');
    } finally {
      proxy.close();
      htmlOrigin.server.close();
    }
  });
});

describe('service worker kill switch', () => {
  let abt;
  let api;
  let proxy;
  let proxyPort;

  beforeAll(async () => {
    abt = await startStub('abt');
    api = await startStub('api');
    const app = createApp({ abtOrigin: abt.url, apiOrigin: api.url });
    proxy = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => proxy.once('listening', resolve));
    proxyPort = proxy.address().port;
  });

  afterAll(() => {
    proxy.close();
    abt.server.close();
    api.server.close();
  });

  beforeEach(() => {
    abt.received.length = 0;
  });

  test('GET /sw.js is answered directly, never proxied to abt (which would serve Actual\'s real precaching worker)', async () => {
    const res = await get(proxyPort, '/sw.js');

    expect(res.status).toBe(200);
    expect(abt.received).toEqual([]);
  });

  test('the replacement service worker skips waiting, clears every cache, and unregisters itself', async () => {
    const res = await get(proxyPort, '/sw.js');

    expect(res.body).toContain('self.skipWaiting()');
    expect(res.body).toContain('caches.keys()');
    expect(res.body).toContain('caches.delete(');
    expect(res.body).toContain('self.registration.unregister()');
  });

  test('is served as non-cacheable JavaScript', async () => {
    const res = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxyPort, path: '/sw.js' }, (response) => {
          let body = '';
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () => resolve({ headers: response.headers, body }));
        })
        .on('error', reject);
    });

    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('the mobile summary endpoint through the proxy', () => {
  let abt;
  let api;
  let proxy;
  let proxyPort;

  beforeAll(async () => {
    abt = await startStub('abt');
    api = await startStub('api');
    proxy = createApp({ abtOrigin: abt.url, apiOrigin: api.url }).listen(0, '127.0.0.1');
    await new Promise((resolve) => proxy.once('listening', resolve));
    proxyPort = proxy.address().port;
  });

  afterAll(() => {
    proxy.close();
    abt.server.close();
    api.server.close();
  });

  const request = (headers) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: proxyPort, path: '/api/mobile/summary', headers }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        })
        .on('error', reject);
    });

  test('goes to insights-api, never to abt, with the Authorization header intact', async () => {
    const res = await request({ authorization: 'Bearer example-device-token' });

    expect(JSON.parse(res.body)).toEqual({ origin: 'api', url: '/api/mobile/summary' });
    expect(api.receivedHeaders.at(-1).authorization).toBe('Bearer example-device-token');
    expect(abt.received).toEqual([]);
  });

  test('the proxy adds no CORS headers of its own', async () => {
    const res = await request({ authorization: 'Bearer example-device-token', origin: 'https://other.example.com' });

    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });
});
