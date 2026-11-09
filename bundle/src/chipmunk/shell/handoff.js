// One-shot hand-off from the command palette to the Transactions screen
// ("Transactions in <account>", a payee/category, free text). The screen takes
// it once when it mounts, so nothing lingers.
let pending = null;
export const setTxHandoff = (value) => { pending = value; };
export function takeTxHandoff() {
  const v = pending;
  pending = null;
  return v;
}

// Same idea for the report dropdown: the palette picks a report, the Reports
// screen takes the pick when it (re)mounts.
let pendingReport = null;
export const setReportHandoff = (id) => { pendingReport = id; };
export function takeReportHandoff() {
  const v = pendingReport;
  pendingReport = null;
  return v;
}
