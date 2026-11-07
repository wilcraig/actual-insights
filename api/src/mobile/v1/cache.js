// The read cache for /api/mobile/v1: results are kept for a short time per
// endpoint+parameters, a build already in flight is shared by everyone who
// asks for the same key, a failed build is never kept, and clear() (called
// after every successful write) forgets everything, including making any
// build still in flight unusable, so a read that started before a write can
// never be served after it.

const TTL_MS = 15 * 1000;
const MAX_ENTRIES = 200;

function createReadCache({ ttlMs = TTL_MS, maxEntries = MAX_ENTRIES } = {}) {
  let entries = new Map(); // key -> { payload, expiresAt }
  let building = new Map(); // key -> promise
  let generation = 0;

  function evict(now) {
    for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
    // Still too many (all fresh): drop the oldest inserted.
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
  }

  function get(key, build) {
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && hit.expiresAt > now) return Promise.resolve(hit.payload);
    if (building.has(key)) return building.get(key);

    const startedIn = generation;
    const promise = (async () => {
      try {
        const payload = await build();
        if (startedIn === generation) {
          evict(Date.now());
          entries.set(key, { payload, expiresAt: Date.now() + ttlMs });
        }
        return payload;
      } finally {
        // Only remove our own slot: clear() may already have replaced it.
        if (building.get(key) === promise) building.delete(key);
      }
    })();
    building.set(key, promise);
    return promise;
  }

  function clear() {
    generation += 1;
    entries = new Map();
    building = new Map();
  }

  return { get, clear };
}

module.exports = { createReadCache, TTL_MS };
