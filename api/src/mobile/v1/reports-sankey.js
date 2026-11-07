const { Unsupported } = require('./reports-query');

// The spending Sankey for the native clients, from the same month cash-flow
// data the web widget draws (cash-flow-data.js loadMonthCashFlow) and the same
// node/link rules as SpendingSankey.svelte:
//
//   column 0  income sources (and "From savings" when spending beat income)
//   column 1  "Income" (or "Spending" when there was no income at all)
//   column 2  one node per spending group, plus "Saved"
//   column 3  the categories of each group
//
// The contract caps a graph at 80 nodes and 300 links. When a month has more,
// the smallest categories of each group fold into one "Other" node per group,
// smallest first (ties by id), until it fits; income sources fold the same way
// into "Other income".

const MAX_NODES = 80;
const MAX_LINKS = 300;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// A node id the schema accepts, unique within the graph, derived from the
// source id: characters outside the pattern become '_', and an id that is too
// long (or empty) falls back to a counter.
function makeIdAllocator() {
  const used = new Set();
  let counter = 0;
  return (prefix, raw) => {
    let id = `${prefix}_${String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '_')}`;
    if (!ID_PATTERN.test(id) || used.has(id)) {
      do {
        counter += 1;
        id = `${prefix}_${counter}`;
      } while (used.has(id));
    }
    used.add(id);
    return id;
  };
}

const byAmountThenId = (a, b) => a.amountCents - b.amountCents || String(a.id).localeCompare(String(b.id));

// folded: Set of category ids (per group) / income ids already merged into "Other".
function buildGraph(flow, foldedCategories, foldedIncome) {
  const alloc = makeIdAllocator();
  const nodes = [];
  const links = [];
  const link = (source, target, value) => {
    const v = Math.round(value);
    if (v > 0) links.push({ source, target, value: v });
  };

  const shortfallCents = Math.max(flow.spendingCents - flow.incomeCents, 0);
  const savedCents = Math.max(flow.incomeCents - flow.spendingCents, 0);

  const incomeId = alloc('n', 'income');
  const sources = [];
  let otherIncome = 0;
  for (const source of flow.income) {
    if (foldedIncome.has(source.id)) otherIncome += source.amountCents;
    else sources.push(source);
  }
  for (const source of sources) {
    const id = alloc('src', source.id);
    nodes.push({ id, label: source.label, column: 0 });
    link(id, incomeId, source.amountCents);
  }
  if (otherIncome > 0) {
    const id = alloc('src', 'other');
    nodes.push({ id, label: 'Other income', column: 0 });
    link(id, incomeId, otherIncome);
  }
  if (shortfallCents > 0) {
    const id = alloc('src', 'shortfall');
    nodes.push({ id, label: 'From savings', column: 0 });
    link(id, incomeId, shortfallCents);
  }

  nodes.push({ id: incomeId, label: flow.incomeCents > 0 ? 'Income' : 'Spending', column: 1 });

  if (savedCents > 0) {
    const id = alloc('n', 'saved');
    nodes.push({ id, label: 'Saved', column: 2 });
    link(incomeId, id, savedCents);
  }

  for (const group of flow.groups) {
    const groupId = alloc('grp', group.id);
    nodes.push({ id: groupId, label: group.label, column: 2 });
    link(incomeId, groupId, group.amountCents);
    let other = 0;
    for (const category of group.categories) {
      if (foldedCategories.has(category.id)) {
        other += category.amountCents;
        continue;
      }
      const id = alloc('cat', category.id);
      nodes.push({ id, label: category.label, column: 3 });
      link(groupId, id, category.amountCents);
    }
    if (other > 0) {
      const id = alloc('oth', group.id);
      nodes.push({ id, label: 'Other', column: 3 });
      link(groupId, id, other);
    }
  }
  return { nodes, links };
}

// null when there is neither income nor spending (the web shows "No income or
// spending this month yet"; the card is then an empty graph).
function buildSankey(flow) {
  if (flow.incomeCents === 0 && flow.spendingCents === 0) return { nodes: [], links: [] };

  const foldedCategories = new Set();
  const foldedIncome = new Set();
  let graph = buildGraph(flow, foldedCategories, foldedIncome);

  if (graph.nodes.length > MAX_NODES || graph.links.length > MAX_LINKS) {
    // Smallest first, across every group, then the smallest income sources.
    const categories = flow.groups.flatMap((g) => g.categories).sort(byAmountThenId);
    const sources = [...flow.income].sort(byAmountThenId);
    const order = [...categories.map((c) => ['c', c.id]), ...sources.map((s) => ['i', s.id])];
    for (const [kind, id] of order) {
      if (graph.nodes.length <= MAX_NODES && graph.links.length <= MAX_LINKS) break;
      (kind === 'c' ? foldedCategories : foldedIncome).add(id);
      graph = buildGraph(flow, foldedCategories, foldedIncome);
    }
  }
  if (graph.nodes.length > MAX_NODES || graph.links.length > MAX_LINKS) throw new Unsupported('too many nodes');
  return graph;
}

module.exports = { buildSankey, MAX_NODES, MAX_LINKS };
