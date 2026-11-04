'use strict';
// Creates a small SYNTHETIC budget on an Actual server and prints its sync id. Run inside the all-in-one
// container (the Actual API is already installed there):
//   docker exec -e SEED_PASSWORD=... -e NODE_PATH=/opt/insights/api/node_modules aio node /tmp/seed.js
// All names and amounts are invented.
const api = require('@actual-app/api');
const fs = require('node:fs');

const SERVER = process.env.SEED_SERVER || 'http://127.0.0.1:25006';
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) { console.error('SEED_PASSWORD is required'); process.exit(2); }

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const daysAgo = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const daysAhead = (n) => daysAgo(-n);

(async () => {
  const dir = fs.mkdtempSync('/tmp/seed-');
  await api.init({ dataDir: dir, serverURL: SERVER, password: PASSWORD });
  await api.runImport('Demo Budget', async () => {
    const checking = await api.createAccount({ name: 'Everyday Checking', offbudget: false }, 250000);
    const savings = await api.createAccount({ name: 'Rainy Day Savings', offbudget: false }, 1050000);

    // A new budget already has an Income group; add a Paycheck category to it.
    const groups = await api.getCategoryGroups();
    const income = (groups.find((g) => g.is_income) || {}).id;
    if (!income) throw new Error('no income category group found in the new budget');
    const paycheckCat = await api.createCategory({ name: 'Paycheck', group_id: income, is_income: true });
    const usual = await api.createCategoryGroup({ name: 'Usual Expenses' });
    const groceries = await api.createCategory({ name: 'Groceries', group_id: usual });
    const dining = await api.createCategory({ name: 'Dining Out', group_id: usual });
    const fuel = await api.createCategory({ name: 'Fuel', group_id: usual });
    const bills = await api.createCategoryGroup({ name: 'Bills' });
    const rent = await api.createCategory({ name: 'Rent', group_id: bills });
    const utilities = await api.createCategory({ name: 'Utilities', group_id: bills });
    const phone = await api.createCategory({ name: 'Phone', group_id: bills });

    const tx = [];
    const add = (daysBack, payee, cents, category) => tx.push({ account: checking, date: ymd(daysAgo(daysBack)), payee_name: payee, amount: cents, category, cleared: true });
    for (let k = 0; k < 6; k++) add(3 + k * 14, 'Example Employer', 215000, paycheckCat);
    for (let k = 0; k < 11; k++) add(1 + k * 7, 'Example Grocer', -(9500 + (k % 4) * 1800), groceries);
    for (let k = 0; k < 9; k++) add(2 + k * 9, 'Example Diner', -(2800 + (k % 3) * 900), dining);
    for (let k = 0; k < 6; k++) add(5 + k * 12, 'Example Fuel', -(4200 + (k % 2) * 700), fuel);
    for (let k = 0; k < 3; k++) { add(4 + k * 30, 'Example Landlord', -150000, rent); add(9 + k * 30, 'Example Utilities', -8400, utilities); add(14 + k * 30, 'Example Mobile', -5500, phone); }
    await api.addTransactions(checking, tx.map(({ account, ...rest }) => rest), { runTransfers: false });

    for (let m = 0; m < 3; m++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - m);
      const month = ym(d);
      for (const [cat, cents] of [[groceries, 45000], [dining, 20000], [fuel, 18000], [rent, 150000], [utilities, 9000], [phone, 5500]]) await api.setBudgetAmount(month, cat, cents);
    }

    // Upcoming scheduled items inside the next 7 days (best effort: the schedule shape can differ between Actual versions).
    try {
      await api.createSchedule({ name: 'Example Utilities', account: checking, amount: -8400, amountOp: 'is', date: { start: ymd(daysAhead(2)), frequency: 'monthly', interval: 1, patterns: [], skipWeekend: false, weekendSolveMode: 'after', endMode: 'never' }, posts_transaction: false });
      await api.createSchedule({ name: 'Example Employer', account: checking, amount: 215000, amountOp: 'is', date: { start: ymd(daysAhead(4)), frequency: 'weekly', interval: 2, patterns: [], skipWeekend: false, weekendSolveMode: 'after', endMode: 'never' }, posts_transaction: false });
    } catch (e) { console.error('schedule seed skipped:', e && e.message ? e.message : e); }
    return { checking, savings };
  });
  await api.sync();
  const budgets = await api.getBudgets();
  const remote = (budgets || []).find((b) => b.groupId);
  console.log(JSON.stringify({ budgets: budgets && budgets.map((b) => ({ id: b.id, groupId: b.groupId, name: b.name, state: b.state })) }));
  if (!remote) { console.error('no budget with a sync group id after sync'); process.exit(3); }
  console.log(`SYNC_ID=${remote.groupId}`);
  await api.shutdown();
  process.exit(0);
})().catch((e) => { console.error('seed failed:', e && e.message ? e.message : e); process.exit(1); });
