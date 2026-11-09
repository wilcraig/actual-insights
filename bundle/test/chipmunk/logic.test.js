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
    const f = { text: 'tea', uncategorized: true, group: null, payees: [{ id: 'p', name: 'Shop' }], categories: [{ id: 'c', name: 'Food' }] };
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
