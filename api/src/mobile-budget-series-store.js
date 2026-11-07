const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

// Budget series (a category's amount repeated over months), kept in
// <data dir>/mobile-budget-series.json as `{ "series": [...] }`, written
// through a temp file and a rename. A missing, unreadable or corrupt file
// means no series; a malformed entry is dropped, never trusted. All changes
// happen inside the server-wide write lock (mobile/v1/write.js exclusive), so
// read-modify-write here cannot race itself.

const FILE_NAME = 'mobile-budget-series.json';
const MAX_SERIES = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const MODES = ['months', 'until', 'indefinite'];

const dataDir = () => process.env.INSIGHTS_DATA_DIR || process.env.ACTUALMINT_DATA_DIR || '/data';

const newSeriesId = () => `ser-${crypto.randomBytes(9).toString('hex')}`;

const isMonth = (v) => typeof v === 'string' && MONTH_PATTERN.test(v);

// A stored entry in exactly the shape we write, or null.
function cleanSeries(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { id, categoryId, categoryName, amount, startMonth, mode, months, untilMonth, appliedThrough } = raw;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  if (typeof categoryId !== 'string' || !ID_PATTERN.test(categoryId)) return null;
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1000000000000) return null;
  if (!isMonth(startMonth) || !MODES.includes(mode)) return null;
  if (mode === 'months' && !(Number.isInteger(months) && months >= 1 && months <= 120)) return null;
  if (mode === 'until' && !isMonth(untilMonth)) return null;
  if (appliedThrough != null && !isMonth(appliedThrough)) return null;
  return {
    id,
    categoryId,
    categoryName: typeof categoryName === 'string' ? categoryName.slice(0, 200) : '',
    amount,
    startMonth,
    mode,
    months: mode === 'months' ? months : null,
    untilMonth: mode === 'until' ? untilMonth : null,
    appliedThrough: appliedThrough == null ? null : appliedThrough,
  };
}

async function readSeries(dir = dataDir()) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, FILE_NAME), 'utf8'));
    const list = parsed && Array.isArray(parsed.series) ? parsed.series : [];
    const out = [];
    const ids = new Set();
    for (const raw of list) {
      const s = cleanSeries(raw);
      if (s && !ids.has(s.id)) {
        ids.add(s.id);
        out.push(s);
      }
      if (out.length >= MAX_SERIES) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function writeSeries(list, dir = dataDir()) {
  const clean = list.map(cleanSeries).filter(Boolean).slice(0, MAX_SERIES);
  const finalPath = path.join(dir, FILE_NAME);
  const tmpPath = `${finalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify({ series: clean }), { mode: 0o600 });
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  return clean;
}

module.exports = { readSeries, writeSeries, cleanSeries, newSeriesId, MAX_SERIES, FILE_NAME };
