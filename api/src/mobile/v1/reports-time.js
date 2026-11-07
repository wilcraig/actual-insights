// Date helpers for the Reports cards. Everything is local-calendar date
// strings ('YYYY-MM-DD' / 'YYYY-MM'); nothing here ever throws on a bad input,
// it falls back to a default window instead.

const pad = (n) => String(n).padStart(2, '0');

const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

function parseDay(value) {
  if (typeof value !== 'string') return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = /^(\d{4})-(\d{2})$/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return null;
}

// A start value of 'YYYY-MM' means the first of that month; an end value of
// 'YYYY-MM' means its last day.
function parseBound(value, isEnd) {
  const d = parseDay(value);
  if (!d) return null;
  if (isEnd && /^\d{4}-\d{2}$/.test(value)) return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return d;
}

function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

// The default when nothing usable is given: the last `months` months through
// the end of the current one.
function lastMonths(now, months) {
  const start = addMonths(now, -(months - 1));
  return { start: fmt(start), end: fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
}

// Resolves an Actual widget timeFrame ({start, end, mode}) to a concrete
// inclusive range. Modes: static (or none), sliding-window, yearToDate,
// lastYear, full. Anything unknown or malformed uses the static start/end if
// they parse, else `fallbackMonths` back from now. `earliest` is an async
// function giving the first transaction date for the 'full' mode.
async function resolveTimeFrame(timeFrame, now, { earliest, fallbackMonths = 12 } = {}) {
  const tf = timeFrame && typeof timeFrame === 'object' ? timeFrame : {};
  const today = startOfDay(now);
  const start = parseBound(tf.start, false);
  const end = parseBound(tf.end, true);
  const mode = typeof tf.mode === 'string' ? tf.mode : 'static';

  if (mode === 'sliding-window' && start && end) {
    const span = Math.max(0, monthsBetween(start, end));
    return lastMonths(now, span + 1);
  }
  if (mode === 'yearToDate') return { start: `${now.getFullYear()}-01-01`, end: fmt(today) };
  if (mode === 'lastYear') return { start: `${now.getFullYear() - 1}-01-01`, end: `${now.getFullYear() - 1}-12-31` };
  if (mode === 'full') {
    let first = null;
    try {
      first = earliest ? parseDay(await earliest()) : null;
    } catch {
      first = null;
    }
    return { start: first ? fmt(first) : lastMonths(now, fallbackMonths).start, end: fmt(today) };
  }
  if (start && end && start <= end) return { start: fmt(start), end: fmt(end) };
  return lastMonths(now, fallbackMonths);
}

// Actual's saved custom reports keep either a static start/end
// (date_static = 1) or a named date_range.
async function resolveReportRange(report, now, opts = {}) {
  const today = startOfDay(now);
  const y = now.getFullYear();
  if (report.date_static) {
    const start = parseBound(report.start, false);
    const end = parseBound(report.end, true);
    if (start && end && start <= end) return { start: fmt(start), end: fmt(end) };
  }
  const name = String(report.date_range || '').toLowerCase();
  const monthEnd = (offset) => fmt(new Date(y, now.getMonth() + offset + 1, 0));
  switch (name) {
    case 'this week': {
      const dow = (today.getDay() + 6) % 7;
      return { start: fmt(addDays(today, -dow)), end: fmt(addDays(today, 6 - dow)) };
    }
    case 'last week': {
      const dow = (today.getDay() + 6) % 7;
      return { start: fmt(addDays(today, -dow - 7)), end: fmt(addDays(today, -dow - 1)) };
    }
    case 'this month':
      return { start: fmt(addMonths(now, 0)), end: monthEnd(0) };
    case 'last month':
      return { start: fmt(addMonths(now, -1)), end: monthEnd(-1) };
    case 'last 3 months':
      return { start: fmt(addMonths(now, -3)), end: monthEnd(-1) };
    case 'last 6 months':
      return { start: fmt(addMonths(now, -6)), end: monthEnd(-1) };
    case 'last 12 months':
      return { start: fmt(addMonths(now, -12)), end: monthEnd(-1) };
    case 'year to date':
      return { start: `${y}-01-01`, end: fmt(today) };
    case 'last year':
      return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    case 'all time':
      return resolveTimeFrame({ mode: 'full' }, now, opts);
    default: {
      const start = parseBound(report.start, false);
      const end = parseBound(report.end, true);
      if (start && end && start <= end) return { start: fmt(start), end: fmt(end) };
      return lastMonths(now, opts.fallbackMonths || 12);
    }
  }
}

function bucketKey(dateStr, interval) {
  switch (interval) {
    case 'Yearly':
      return dateStr.slice(0, 4);
    case 'Daily':
      return dateStr;
    case 'Weekly': {
      const d = parseDay(dateStr);
      return fmt(addDays(d, -((d.getDay() + 6) % 7)));
    }
    default:
      return dateStr.slice(0, 7);
  }
}

// Every bucket key from start through end, oldest first, keeping only the
// last `max` so a huge range can never produce a huge payload.
function enumerateBuckets(start, end, interval, max) {
  const s = parseDay(start);
  const e = parseDay(end);
  if (!s || !e || s > e) return [];
  const keys = [];
  const seen = new Set();
  let cursor = s;
  let guard = 0;
  while (cursor <= e && guard++ < 20000) {
    const key = bucketKey(fmt(cursor), interval);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
    cursor = interval === 'Yearly' ? new Date(cursor.getFullYear() + 1, 0, 1) : interval === 'Monthly' || !interval ? addMonths(cursor, 1) : addDays(cursor, interval === 'Weekly' ? 7 : 1);
  }
  if (keys[keys.length - 1] !== bucketKey(fmt(e), interval)) keys.push(bucketKey(fmt(e), interval));
  return keys.slice(-max);
}

function monthsInRange(start, end) {
  const s = parseDay(start);
  const e = parseDay(end);
  if (!s || !e) return 1;
  return Math.max(1, monthsBetween(s, e) + 1);
}

module.exports = {
  fmt,
  monthKey,
  startOfDay,
  addDays,
  addMonths,
  parseDay,
  resolveTimeFrame,
  resolveReportRange,
  bucketKey,
  enumerateBuckets,
  monthsInRange,
  lastMonths,
};
