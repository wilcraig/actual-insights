// How the Chipmunk report dropdown maps onto Actual's own Reports routes:
// a dashboard page is /reports/<id>, a saved report is /reports/custom/<id>
// (routes confirmed against Actual 26.10's client).

export const isReportsPath = (pathname) => pathname === '/reports' || (typeof pathname === 'string' && pathname.startsWith('/reports/'));

export const reportPath = (entry) =>
  entry && entry.kind === 'custom' ? `/reports/custom/${encodeURIComponent(entry.id)}` : entry ? `/reports/${encodeURIComponent(entry.id)}` : '/reports';

/** The list entry Actual's current path is showing, or null. */
export function reportFromPath(list, pathname) {
  if (!list || !Array.isArray(list.reports) || typeof pathname !== 'string') return null;
  const custom = pathname.match(/^\/reports\/custom\/([^/]+)\/?$/);
  const dash = pathname.match(/^\/reports\/([^/]+)\/?$/);
  let id = null;
  let kind = null;
  if (custom) {
    id = custom[1];
    kind = 'custom';
  } else if (dash && dash[1] !== 'custom') {
    id = dash[1];
    kind = 'dashboard';
  }
  if (!id) return null;
  try {
    id = decodeURIComponent(id);
  } catch {
    return null;
  }
  return list.reports.find((r) => r.id === id && (r.kind === kind || (kind === 'dashboard' && r.kind !== 'custom'))) ?? null;
}
