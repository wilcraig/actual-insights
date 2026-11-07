// Colours for category groups and categories (contract: colorKey). The server
// only ever deals in the 12 palette KEYS; the hex values (light and dark) live
// in the clients (shared/fixtures/palette.json in the Chipmunk repo).
//
// Effective colour:
//   group    = its explicit colour, else PALETTE[position % 12], where position
//              is the group's index in Actual's group order among ALL
//              non-hidden groups (income groups count; a hidden group never
//              shifts anyone). A hidden group with no explicit colour is 'gray'.
//   category = its explicit colour, else its group's effective colour.
// colorIndexes() and createColorResolver() are the one definition of this.

const { clip, isValidId, notFound } = require('./common');
const { readColors, setColor } = require('../../mobile-colors-store');
const { scopedClient } = require('./hidden');
const { appendAudit } = require('./audit');

// Order matters: it is the default rotation. Same order as the contract's enum.
const PALETTE_KEYS = ['blue', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'pink', 'purple', 'indigo', 'brown', 'gray'];
const FALLBACK_KEY = 'gray';

const isColorKey = (value) => typeof value === 'string' && PALETTE_KEYS.includes(value);

// group id -> position among the non-hidden groups, in the order given.
function colorIndexes(groups) {
  const indexes = new Map();
  let next = 0;
  for (const group of groups || []) {
    if (group && !group.hidden && typeof group.id === 'string' && !indexes.has(group.id)) indexes.set(group.id, next++);
  }
  return indexes;
}

// `explicit`: { groups: {id: key}, categories: {id: key} } (as the store reads
// it). Lookups of an unknown id fall back to gray, never throw.
function createColorResolver(groups, explicit = {}) {
  const indexes = colorIndexes(groups);
  const explicitGroups = explicit.groups || {};
  const explicitCategories = explicit.categories || {};
  const groupOfCategory = new Map();
  for (const group of groups || []) for (const category of (group && group.categories) || []) groupOfCategory.set(category.id, group.id);

  const has = (map, id) => Object.prototype.hasOwnProperty.call(map, id);
  const groupExplicit = (id) => has(explicitGroups, id);
  const categoryExplicit = (id) => has(explicitCategories, id) && groupOfCategory.has(id);
  const group = (id) => {
    if (groupExplicit(id)) return explicitGroups[id];
    return indexes.has(id) ? PALETTE_KEYS[indexes.get(id) % PALETTE_KEYS.length] : FALLBACK_KEY;
  };
  const category = (id) => (categoryExplicit(id) ? explicitCategories[id] : group(groupOfCategory.get(id)));
  // A group's categories that are not hidden (the set a rollup is compared to).
  const groupCategories = (id) => {
    const g = (groups || []).find((x) => x && x.id === id);
    return ((g && g.categories) || []).filter((c) => !c.hidden).map((c) => c.id);
  };
  const hasGroup = (id) => (groups || []).some((g) => g && g.id === id);
  const hasCategory = (id) => groupOfCategory.has(id);
  // { color } when the id is a known group/category, else {} (spread into a row).
  const groupField = (id) => (hasGroup(id) ? { color: group(id) } : {});
  const categoryField = (id) => (hasCategory(id) ? { color: category(id) } : {});
  return { group, category, groupExplicit, categoryExplicit, groupOfCategory, hasGroup, hasCategory, groupCategories, groupField, categoryField };
}

async function loadColorResolver(client) {
  const [groups, explicit] = await Promise.all([client.getCategoryGroups(), readColors()]);
  return createColorResolver(groups || [], explicit);
}

// GET /colors: visible groups and categories in Actual's order.
async function buildColors(client, now = new Date()) {
  const groups = (await client.getCategoryGroups()) || [];
  const colors = createColorResolver(groups, await readColors());
  const outGroups = [];
  const outCategories = [];
  for (const group of groups) {
    if (group.hidden || !isValidId(group.id)) continue;
    outGroups.push({ id: group.id, name: clip(group.name), color: colors.group(group.id), explicit: colors.groupExplicit(group.id) });
    for (const category of group.categories || []) {
      if (category.hidden || !isValidId(category.id)) continue;
      outCategories.push({ id: category.id, name: clip(category.name), groupId: group.id, color: colors.category(category.id), explicit: colors.categoryExplicit(category.id) });
    }
  }
  return { schema: 1, generatedAt: now.toISOString(), groups: outGroups.slice(0, 100), categories: outCategories.slice(0, 1000) };
}

// PUT /colors/groups/<id> and /colors/categories/<id>. kind: 'groups' |
// 'categories'; color: a key, or null for the automatic default. Only groups
// and categories GET /colors lists (not hidden) exist as far as this goes.
async function putColor({ tokenId, kind, id, color }) {
  const client = await scopedClient();
  const groups = (await client.getCategoryGroups()) || [];
  const known =
    kind === 'groups'
      ? groups.some((g) => g.id === id && !g.hidden)
      : groups.some((g) => !g.hidden && (g.categories || []).some((c) => c.id === id && !c.hidden));
  if (!known) throw notFound();
  const before = await setColor(kind, id, color);
  await appendAudit({ tokenId, op: 'colors.set', ids: { [kind === 'groups' ? 'group' : 'category']: id }, before: { color: before }, after: { color } });
  return { schema: 1, ok: true };
}

module.exports = { putColor,  PALETTE_KEYS, isColorKey, colorIndexes, createColorResolver, loadColorResolver, buildColors };
