/**
 * Tree helpers.
 *
 * The navigation tree is fetched ONCE as a flat array and assembled here.
 * This is the single most important performance decision in the app:
 *
 *   - Building the sidebar server-side would need a recursive CTE per page.
 *   - Fetching children lazily per expand would be N round trips.
 *   - One flat SELECT of a few thousand narrow rows is ~50KB, cached by
 *     React Query, and turns every subsequent navigation into exactly one
 *     request (the page content) with zero extra queries for the sidebar,
 *     the breadcrumb trail or the previous/next links.
 */

/** Flat rows -> nested tree, children sorted by (position, title). */
export function buildTree(rows = []) {
  const byId = new Map();
  const roots = [];

  for (const row of rows) byId.set(row.id, { ...row, children: [] });

  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : null;
    // A node whose parent is not in the set (e.g. a published child of an
    // unpublished parent) is promoted to a root rather than dropped, so
    // content is never silently invisible.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sort = (nodes) => {
    nodes.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);

  return roots;
}

/** Depth-first pre-order flatten - the reading order of the whole site. */
export function flattenTree(nodes, out = []) {
  for (const node of nodes) {
    out.push(node);
    flattenTree(node.children, out);
  }
  return out;
}

/**
 * Previous / next page in reading order.
 * Computed from the already-cached tree, so it costs zero requests.
 */
export function getPrevNext(tree, path) {
  const flat = flattenTree(tree);
  const i = flat.findIndex((n) => n.path === path);
  if (i === -1) return { prev: null, next: null };
  return { prev: flat[i - 1] ?? null, next: flat[i + 1] ?? null };
}

/** Every ancestor path of `a/b/c` -> ['a', 'a/b', 'a/b/c']. */
export function ancestorPaths(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Find a node anywhere in the tree by path. */
export function findByPath(nodes, path) {
  for (const node of nodes) {
    if (node.path === path) return node;
    const hit = findByPath(node.children, path);
    if (hit) return hit;
  }
  return null;
}

/**
 * All descendant ids of a node, plus the node itself.
 * Used by the admin move dialog to grey out invalid destinations - the
 * database rejects a cycle anyway, but a disabled option beats an error.
 */
export function subtreeIds(node, out = new Set()) {
  out.add(node.id);
  for (const child of node.children || []) subtreeIds(child, out);
  return out;
}
