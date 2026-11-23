import * as L from '../../src/chipmunk/logic';

const memory = (init = {}) => {
  const m = { ...init };
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
};
const throwing = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };

describe('money and colours', () => {
  test('tones and format', () => {
    expect(L.balanceTone(5)).toBe('positive');
    expect(L.balanceTone(-5)).toBe('negative');
    expect(L.balanceTone(0)).toBe('neutral');
    expect(L.balanceTone(null)).toBe('neutral');
    expect(L.formatMoney(123456, { locale: 'en-US' })).toBe('$1,234.56');
    expect(L.formatMoney(null)).toBe('–');
  });
  test('palette matches the phone keys and falls back by position', () => {
    expect(L.PALETTE_KEYS).toEqual(['blue', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'pink', 'purple', 'indigo', 'brown', 'gray']);
    expect(L.colorFor('green')).toBe('#16a34a');
    expect(L.colorFor('green', 0, true)).toBe('#4ade80');
    expect(L.colorFor(null, 13)).toBe('#0d9488');
  });
});

describe('account layout', () => {
  const resp = {
    accounts: [
      { id: 'a1', name: 'Chk', balance: 100, onBudget: true, groupId: 'g1' },
      { id: 'a2', name: 'Sav', balance: -30, onBudget: true, groupId: 'g1' },
      { id: 'a3', name: 'Cash', balance: 5, onBudget: true, groupId: null },
      { id: 'a4', name: 'Ret', balance: 900, onBudget: false, groupId: 'g1' },
    ],
    groups: [{ id: 'g1', name: 'Cash group', balance: 970 }],
  };
  test('sections, group rows in place, per-section subtotal', () => {
    const s = L.layoutAccounts(resp);
    expect(s.map((x) => x.label)).toEqual(['On budget', 'Off budget']);
    expect(s[0].rows.map((r) => r.type)).toEqual(['group', 'account']);
    expect(s[0].rows[0].subtotal).toBe(70);
    expect(s[1].rows[0].subtotal).toBe(900);
  });
  test('unknown balance makes the subtotal unknown; empty response is empty', () => {
    const r = { accounts: [{ id: 'a', name: 'x', balance: null, onBudget: true, groupId: 'g' }], groups: [{ id: 'g', name: 'G' }] };
    expect(L.layoutAccounts(r)[0].rows[0].subtotal).toBeNull();
    expect(L.layoutAccounts(null)).toEqual([]);
  });
  test('groups are collapsed by default and the open set is remembered', () => {
    const st = memory();
    expect(L.loadExpanded(st).size).toBe(0);
    L.saveExpanded(st, new Set(['g1']));
    expect([...L.loadExpanded(st)]).toEqual(['g1']);
    expect(L.loadExpanded(memory({ 'insights:chipmunk:expandedGroups': 'nope' })).size).toBe(0);
    expect(L.loadExpanded(throwing).size).toBe(0);
    expect(() => L.saveExpanded(throwing, new Set())).not.toThrow();
  });
});

describe('transaction filter', () => {
  test('query string rules mirror the server', () => {
    const f = L.emptyFilter();
    expect(L.toQuery(f)).toBe('');
    expect(L.toQuery({ ...f, text: ' coffee ', payees: [{ id: 'p1' }, { id: 'p2' }] }, { account: 'a1', limit: 50, cursor: 'c_x', showHidden: true }))
      .toBe('account=a1&payees=p1%2Cp2&q=coffee&limit=50&cursor=c_x&showHidden=1');
    expect(L.toQuery({ ...f, uncategorized: true, categories: [{ id: 'c1' }], group: { id: 'g' } })).toBe('uncategorized=1');
    expect(L.toQuery({ ...f, group: { id: 'g' } })).toBe('group=g');
    expect(L.toQuery({ ...f, categories: [{ id: 'c1' }, { id: 'c2' }] })).toBe('categories=c1%2Cc2');
  });
  test('month filter: query, labelled chip, removable, kept by suggestions', () => {
    const f = { ...L.emptyFilter(), month: '2026-11', categories: [{ id: 'c1', name: 'Food' }] };
    expect(L.toQuery(f)).toBe('categories=c1&month=2026-11');
    expect(L.monthLabel('2026-11')).toBe('Nov 2026');
    const cs = L.chips(f);
    expect(cs.map((c) => [c.kind, c.label])).toEqual([['month', 'Nov 2026'], ['category', 'Food']]);
    expect(L.removeChip(f, cs[0]).month).toBeNull();
    expect(L.applySuggestion(f, { kind: 'merchant', id: 'p', name: 'Shop' }).month).toBe('2026-11');
  });
  test('suggestions: choose replaces, add extends, category clears uncategorized', () => {
    let f = { ...L.emptyFilter(), text: 'x', uncategorized: true };
    f = L.applySuggestion(f, { kind: 'category', id: 'c1', name: 'Food' });
    expect(f).toMatchObject({ text: '', uncategorized: false, categories: [{ id: 'c1', name: 'Food' }] });
    f = L.applySuggestion(f, { kind: 'category', id: 'c2', name: 'Fuel' }, { add: true });
    f = L.applySuggestion(f, { kind: 'category', id: 'c2', name: 'Fuel' }, { add: true });
    expect(f.categories.map((c) => c.id)).toEqual(['c1', 'c2']);
    f = L.applySuggestion(f, { kind: 'merchant', id: 'p1', name: 'Shop' });
    expect(f.payees).toEqual([{ id: 'p1', name: 'Shop' }]);
    expect(f.categories).toHaveLength(2);
  });
  test('add is capped at 20', () => {
    let f = L.emptyFilter();
    for (let i = 0; i < 25; i++) f = L.applySuggestion(f, { kind: 'merchant', id: `p${i}`, name: `P${i}` }, { add: true });
    expect(f.payees).toHaveLength(20);
  });
  test('chips and removal', () => {
    const f = { text: 'tea', uncategorized: true, group: null, month: null, payees: [{ id: 'p', name: 'Shop' }], categories: [{ id: 'c', name: 'Food' }] };
    const cs = L.chips(f);
    expect(cs.map((c) => c.kind)).toEqual(['text', 'uncategorized', 'category', 'payee']);
    let g = f;
    for (const c of cs) g = L.removeChip(g, c);
    expect(g).toEqual(L.emptyFilter());
  });
  test('suggestionRows flattens', () => {
    expect(L.suggestionRows({ merchants: [{ id: 'p', name: 'A' }], categories: [{ id: 'c', name: 'B', groupName: 'G' }] }).map((r) => r.kind)).toEqual(['merchant', 'category']);
    expect(L.suggestionRows(null)).toEqual([]);
  });
});

describe('reports', () => {
  const list = { reports: [{ id: 'a' }, { id: 'b' }], defaultId: 'a' };
  test('effectiveReport: picked, saved, default, stale', () => {
    expect(L.effectiveReport(list, 'b', 'a')).toBe('b');
    expect(L.effectiveReport(list, null, 'b')).toBe('b');
    expect(L.effectiveReport(list, 'zz', 'yy')).toBe('a');
    expect(L.effectiveReport(null, null, null)).toBeNull();
  });
  test('report choice storage', () => {
    const st = memory();
    L.saveReportChoice(st, 'b');
    expect(L.loadReportChoice(st)).toBe('b');
    L.saveReportChoice(st, null);
    expect(L.loadReportChoice(st)).toBeNull();
    expect(L.loadReportChoice(throwing)).toBeNull();
  });
  test('month arrows respect earliest and current month', () => {
    expect(L.shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(L.shiftMonth('2026-12', 1)).toBe('2027-01');
    const nav = { month: '2026-11', earliest: '2026-10' };
    expect(L.canShift(nav, -1, '2026-11')).toBe(true);
    expect(L.canShift({ ...nav, month: '2026-10' }, -1, '2026-11')).toBe(false);
    expect(L.canShift(nav, 1, '2026-11')).toBe(false);
    expect(L.canShift(null, 1, '2026-11')).toBe(false);
  });
});

describe('series helpers', () => {
  test('amount parsing', () => {
    expect(L.parseAmountToCents('$1,234.5')).toBe(123450);
    expect(L.parseAmountToCents('450')).toBe(45000);
    expect(L.parseAmountToCents('abc')).toBeNull();
    expect(L.parseAmountToCents('1.234')).toBeNull();
    expect(L.parseAmountToCents('-3')).toBeNull();
  });
  test('request body per mode; update omits categoryId', () => {
    expect(L.seriesBody({ categoryId: 'c', amountCents: 100, startMonth: '2026-11', mode: 'months', months: 3, untilMonth: 'x', dryRun: true }))
      .toEqual({ amount: 100, startMonth: '2026-11', mode: 'months', categoryId: 'c', months: 3, dryRun: true });
    expect(L.seriesBody({ categoryId: 'c', amountCents: 100, startMonth: '2026-11', mode: 'until', months: 3, untilMonth: '2027-02' }, { isUpdate: true }))
      .toEqual({ amount: 100, startMonth: '2026-11', mode: 'until', untilMonth: '2027-02' });
    expect(L.seriesBody({ categoryId: 'c', amountCents: 1, startMonth: '2026-11', mode: 'indefinite', months: 3, untilMonth: 'x' }))
      .toEqual({ amount: 1, startMonth: '2026-11', mode: 'indefinite', categoryId: 'c' });
  });
  test('summary text', () => {
    expect(L.seriesSummary({ mode: 'indefinite' })).toBe('Repeats every month');
    expect(L.seriesSummary({ mode: 'until', endMonth: '2027-06' })).toBe('Repeats until Jun 2027');
  });
});

describe('resizable columns', () => {
  const store = memory();
  test('defaults, clamping, round trip, junk and blocked storage', () => {
    expect(L.loadColumns(store)).toEqual(L.DEFAULT_COLUMNS);
    expect(L.clampColumn('date', 5)).toBe(70);
    expect(L.clampColumn('date', 9999)).toBe(220);
    expect(L.clampColumn('date', 'x')).toBe(70);
    L.saveColumns(store, { date: 140, category: 300, amount: 90 });
    expect(L.loadColumns(store)).toEqual({ date: 140, category: 300, amount: 90 });
    store.setItem('insights:chipmunk:txColumns', JSON.stringify({ date: 1, category: 'wide', amount: 99999 }));
    expect(L.loadColumns(store)).toEqual({ date: 70, category: L.DEFAULT_COLUMNS.category, amount: 220 });
    store.setItem('insights:chipmunk:txColumns', '{nope');
    expect(L.loadColumns(store)).toEqual(L.DEFAULT_COLUMNS);
    const blocked = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
    expect(L.loadColumns(blocked)).toEqual(L.DEFAULT_COLUMNS);
    expect(() => L.saveColumns(blocked, {})).not.toThrow();
  });
});

describe('average spend and rollover reset math', () => {
  const m = (...spent) => spent.map((x, i) => ({ month: `2026-0${i + 1}`, budgeted: 0, spent: x }));
  test('nothing to average', () => {
    expect(L.averageSpend([], 3)).toBeNull();
    expect(L.averageSpend(null, 3)).toBeNull();
    expect(L.averageSpend(m(-100), 0)).toBeNull();
  });
  test('1, 2, 3 and 6 months: the newest N, fewer when the budget is younger', () => {
    expect(L.averageSpend(m(-1000), 3)).toEqual({ cents: 1000, months: 1, requested: 3 });
    expect(L.averageSpend(m(-1000, -2000), 3)).toEqual({ cents: 1500, months: 2, requested: 3 });
    expect(L.averageSpend(m(-9999, -1000, -2000, -3000), 3)).toEqual({ cents: 2000, months: 3, requested: 3 }); // the oldest is left out
    expect(L.averageSpend(m(-1, -2, -3, -4, -5, -6), 6)).toEqual({ cents: 4, months: 6, requested: 6 }); // 3.5 rounds half up
    expect(L.averageSpend(m(-100, -100, -100, -100, -100, -600), 3).cents).toBe(267); // (100+100+600)/3 = 266.67
  });
  test('half-up rounding and abs of spent (refunds count as spend of that size, like the phone)', () => {
    expect(L.averageSpend(m(-1, -2), 3).cents).toBe(2); // 1.5 -> 2
    expect(L.averageSpend(m(-1, -1, -2), 3).cents).toBe(1); // 1.33 -> 1
    expect(L.averageSpend(m(-1, -2, -2), 3).cents).toBe(2); // 1.67 -> 2
    expect(L.averageSpend(m(-1000, 500), 3).cents).toBe(750);
    expect(L.averageSpend(m(0, 0), 3).cents).toBe(0);
    expect(L.averageSpend([{ month: '2026-01' }, { month: '2026-02', spent: -300 }], 3).cents).toBe(150);
  });
  test('labels', () => {
    expect(L.spendAverageLabel({ cents: 1, months: 3, requested: 3 }, '$0.01')).toBe('Avg of last 3 months: $0.01');
    expect(L.spendAverageLabel({ cents: 1, months: 2, requested: 3 }, '$0.01')).toBe('Avg of 2 months: $0.01');
    expect(L.spendAverageLabel({ cents: 1, months: 1, requested: 6 }, '$0.01')).toBe('Avg of 1 month: $0.01');
    expect(L.NO_HISTORY).toBe('Not enough history yet');
  });
  test('the toggle is remembered per browser; anything else is 3', () => {
    const st = memory();
    expect(L.loadSpendMonths(st)).toBe(3);
    L.saveSpendMonths(st, 6);
    expect(L.loadSpendMonths(st)).toBe(6);
    L.saveSpendMonths(st, 4);
    expect(L.loadSpendMonths(st)).toBe(3);
    st.setItem('insights:chipmunk:avgMonths', 'x');
    expect(L.loadSpendMonths(st)).toBe(3);
    expect(L.loadSpendMonths(throwing)).toBe(3);
    expect(() => L.saveSpendMonths(throwing, 6)).not.toThrow();
    expect([L.normalizeSpendMonths(3), L.normalizeSpendMonths('6'), L.normalizeSpendMonths(12), L.normalizeSpendMonths(undefined)]).toEqual([3, 6, 3, 3]);
  });
  test('what a rollover carries in: balance - budgeted - spent, only when positive', () => {
    expect(L.rolloverCarriedIn({ balance: 75000, budgeted: 45000, spent: -20000 })).toBe(50000);
    expect(L.rolloverCarriedIn({ balance: 25000, budgeted: 45000, spent: -20000 })).toBeNull(); // zero
    expect(L.rolloverCarriedIn({ balance: 1000, budgeted: 45000, spent: -20000 })).toBeNull(); // deficit
    expect(L.rolloverCarriedIn({ balance: 1, budgeted: 0 })).toBeNull();
    expect(L.rolloverCarriedIn(null)).toBeNull();
  });
  test('the reset is offered only for a rollover, in the current month, when writing is allowed', () => {
    const ok = { carryover: true, month: '2026-11', currentMonth: '2026-11', canWrite: true };
    expect(L.offersRolloverReset(ok)).toBe(true);
    expect(L.offersRolloverReset({ ...ok, carryover: false })).toBe(false);
    expect(L.offersRolloverReset({ ...ok, carryover: undefined })).toBe(false);
    expect(L.offersRolloverReset({ ...ok, month: '2026-10' })).toBe(false);
    expect(L.offersRolloverReset({ ...ok, canWrite: false })).toBe(false);
    expect(L.offersRolloverReset({ ...ok, month: 'bad', currentMonth: 'bad' })).toBe(false);
  });
  test('confirmation text; the carried-in sentence is omitted when it cannot be worked out', () => {
    expect(L.rolloverConfirmMessage(5000, '$50.00')).toBe('Start this rollover from $0? The $50.00 carried in from last month will stop carrying over. Earlier months are not changed.');
    expect(L.rolloverConfirmMessage(null, null)).toBe('Start this rollover from $0? Earlier months are not changed.');
    expect(L.rolloverConfirmMessage(5000, null)).toBe('Start this rollover from $0? Earlier months are not changed.');
    expect(L.ROLLOVER_BANNER).toBe('Rollover reset');
  });
});
