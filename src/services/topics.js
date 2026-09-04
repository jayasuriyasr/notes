import { supabase } from '../lib/supabase';
import { unwrap, AppError, ERROR_KIND } from '../lib/errors';
import { normalizePath } from '../utils/slug';

/**
 * ============================================================
 *  DATA ACCESS LAYER
 * ============================================================
 * Every database call in the application goes through this file. Nothing
 * else imports `supabase` for reads or writes.
 *
 * Why that matters beyond tidiness: it makes the column lists auditable
 * in one place. The public navigation query below selects seven narrow
 * columns and never `content`, which is what keeps a 500-page site's
 * sidebar payload at tens of kilobytes instead of megabytes. Scatter
 * `select('*')` across twenty components and that guarantee is gone.
 *
 * SECURITY: none of these functions check permissions, and that is
 * deliberate. Authorization lives in RLS policies (see
 * supabase/migrations/*_rls.sql). A non-admin who calls updateTopic()
 * from the browser console gets zero rows affected. The functions below
 * are a convenience layer, never a gate.
 */

/** Columns needed to draw navigation. Note the absence of `content`. */
const NAV_COLUMNS = 'id,parent_id,title,slug,path,depth,position';

/** Columns for the admin tree — adds the bits the dashboard displays. */
const ADMIN_COLUMNS = `${NAV_COLUMNS},status,updated_at,created_at,published_at`;

/* ============================================================
 * PUBLIC READS
 * ============================================================ */

/**
 * The whole published tree, flat.
 *
 * Operation : Get complete navigation tree
 * Query     : select ... from topics where status='published' order by path
 * Returns   : [{ id, parent_id, title, slug, path, depth, position }]
 *
 * RLS supplies the `status='published'` filter for anonymous callers, but
 * we state it explicitly anyway: an admin is signed in and WOULD see
 * drafts here, and drafts must not appear in the public sidebar.
 */
export async function getNavigationTree() {
  return unwrap(
    await supabase
      .from('topics')
      .select(NAV_COLUMNS)
      .eq('status', 'published')
      .order('path', { ascending: true }),
  );
}

/**
 * Everything one documentation page needs, in ONE round trip.
 *
 * Operation : Get a public page
 * Input     : "system-design/rate-limiter"
 * Query     : select public.get_page($1)
 * Returns   : { topic, breadcrumbs[], children[] } | { topic: null }
 *
 * The alternative — three separate requests for the page, its ancestors
 * and its children — costs three round trips to the same region for data
 * the database can assemble in a single plan. Breadcrumbs in particular
 * are free here: they are prefix lookups against the unique index on
 * `path`, not a recursive walk.
 */
export async function getTopicByPath(path) {
  const clean = normalizePath(path);
  if (!clean) throw new AppError(ERROR_KIND.NOT_FOUND, 'No page requested.');

  const data = unwrap(await supabase.rpc('get_page', { p_path: clean }));
  if (!data?.topic) return null;

  return {
    topic: data.topic,
    breadcrumbs: data.breadcrumbs ?? [],
    children: data.children ?? [],
  };
}

/**
 * Operation : Get children
 * Input     : parent topic id
 * Query     : select ... from topics where parent_id = $1 order by position
 *
 * Usually unnecessary — get_page already returns children, and the
 * sidebar has the whole tree. Kept for the "index page" case where a
 * section lists its sub-pages as cards.
 */
export async function getTopicChildren(parentId) {
  return unwrap(
    await supabase
      .from('topics')
      .select(`${NAV_COLUMNS},excerpt`)
      .eq('parent_id', parentId)
      .eq('status', 'published')
      .order('position', { ascending: true }),
  );
}

/**
 * Operation : Get breadcrumbs
 * Input     : "system-design/rate-limiter/token-bucket"
 * Query     : select ... from topics where path in ('system-design',
 *                    'system-design/rate-limiter', <the full path>)
 *
 * Standalone version for callers that have a path but no page payload.
 * Builds the ancestor list client-side and fetches them in one `in()`,
 * which is n index probes and no recursion.
 */
export async function getTopicBreadcrumbs(path) {
  const parts = normalizePath(path).split('/').filter(Boolean);
  if (!parts.length) return [];
  const paths = parts.map((_, i) => parts.slice(0, i + 1).join('/'));

  const rows = unwrap(
    await supabase.from('topics').select('id,title,slug,path,depth').in('path', paths),
  );
  return rows.sort((a, b) => a.depth - b.depth);
}

/**
 * Operation : Resolve a moved/renamed URL
 * Input     : a path that returned no topic
 * Query     : topic_redirects -> topics.path
 *
 * Called ONLY on a miss, so the happy path never pays for it. Redirects
 * store a topic id rather than a target path, so a page that moves three
 * times still resolves in one hop — there are no redirect chains to walk.
 */
export async function resolveRedirect(path) {
  const clean = normalizePath(path);
  const rows = unwrap(
    await supabase
      .from('topic_redirects')
      .select('topic_id, topics!inner(path,status)')
      .eq('old_path', clean)
      .limit(1),
  );
  const target = rows?.[0]?.topics;
  // A redirect to a draft (or to a page an anonymous visitor may not see)
  // is filtered out by RLS on the joined table and lands here as null,
  // which correctly produces a 404 rather than leaking the target.
  return target?.path ?? null;
}

/**
 * Operation : Search
 * Input     : "token bucket"
 * Query     : select * from public.search_topics($1, $2)
 */
export async function searchTopics(query, limit = 12) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  return unwrap(await supabase.rpc('search_topics', { p_query: q, p_limit: limit }));
}

/** Every published path — used by the sitemap generator at build time. */
export async function getAllPublishedPaths() {
  return unwrap(
    await supabase
      .from('topics')
      .select('path,updated_at')
      .eq('status', 'published')
      .order('path', { ascending: true }),
  );
}

/* ============================================================
 * ADMIN READS
 * ============================================================ */

/** The full tree including drafts. Returns [] for non-admins (RLS). */
export async function getAdminTree() {
  return unwrap(
    await supabase.from('topics').select(ADMIN_COLUMNS).order('path', { ascending: true }),
  );
}

export async function getTopicById(id) {
  const rows = unwrap(
    await supabase
      .from('topics')
      .select(`${ADMIN_COLUMNS},content,excerpt`)
      .eq('id', id)
      .limit(1),
  );
  if (!rows?.length) throw new AppError(ERROR_KIND.NOT_FOUND, 'That page does not exist.');
  return rows[0];
}

export async function descendantCount(id) {
  return unwrap(await supabase.rpc('descendant_count', { p_id: id })) ?? 0;
}

/* ============================================================
 * ADMIN WRITES
 * ============================================================
 * Note what is NOT sent in any payload below: `path`, `depth`,
 * `created_by`, `created_at`. Those are computed by database triggers.
 * Even if a caller forged them into the request body, the BEFORE trigger
 * overwrites them — the client cannot place a page at an arbitrary URL
 * or forge authorship.
 */

const writable = ({ title, slug, content, excerpt, status, parent_id, position }) => ({
  ...(title !== undefined && { title }),
  ...(slug !== undefined && { slug: slug || null }),
  ...(content !== undefined && { content }),
  ...(excerpt !== undefined && { excerpt: excerpt || null }),
  ...(status !== undefined && { status }),
  ...(parent_id !== undefined && { parent_id: parent_id || null }),
  ...(position !== undefined && { position }),
});

/**
 * Operation : Create topic
 * Query     : insert into topics (...) values (...) returning *
 * Note      : omitting `slug` makes the trigger derive it from the title
 *             and de-duplicate it against siblings automatically.
 */
export async function createTopic(input) {
  const rows = unwrap(
    await supabase
      .from('topics')
      .insert(writable(input))
      .select(`${ADMIN_COLUMNS},content,excerpt`),
  );
  if (!rows?.length) {
    throw new AppError(ERROR_KIND.FORBIDDEN, 'The page was not created. Administrator access is required.');
  }
  return rows[0];
}

/**
 * Operation : Update topic (title, slug, Markdown, summary, status)
 * Query     : update topics set ... where id = $1 returning *
 *
 * An empty result means RLS matched no row — i.e. the caller is not an
 * admin. PostgREST reports that as success with zero rows, not as an
 * error, so we convert it into one rather than showing a silent no-op.
 */
export async function updateTopic(id, input) {
  const rows = unwrap(
    await supabase
      .from('topics')
      .update(writable(input))
      .eq('id', id)
      .select(`${ADMIN_COLUMNS},content,excerpt`),
  );
  if (!rows?.length) {
    throw new AppError(
      ERROR_KIND.FORBIDDEN,
      'Nothing was saved. Either the page no longer exists or you do not have permission to edit it.',
    );
  }
  return rows[0];
}

/** Operation : Publish / unpublish */
export async function publishTopic(id, published) {
  return updateTopic(id, { status: published ? 'published' : 'draft' });
}

/**
 * Operation : Move topic (re-parent)
 * Query     : select public.move_topic($1, $2, $3)
 *
 * The RPC exists for the sibling-position bookkeeping. The path rewrite
 * of every descendant, the cycle check and the redirect records are all
 * handled by triggers, so this is genuinely one statement.
 */
export async function moveTopic(id, newParentId, position = null) {
  return unwrap(
    await supabase.rpc('move_topic', {
      p_id: id,
      p_new_parent_id: newParentId || null,
      p_position: position,
    }),
  );
}

/** Operation : Reorder siblings — one statement for the whole list. */
export async function reorderSiblings(parentId, orderedIds) {
  return unwrap(
    await supabase.rpc('reorder_siblings', {
      p_parent_id: parentId || null,
      p_ordered_ids: orderedIds,
    }),
  );
}

/**
 * Operation : Delete topic
 * Query     : select public.delete_topic($1, $2)
 *
 * cascade=false on a page that has children raises a foreign-key error
 * and deletes nothing — that is the guard against wiping a subtree by
 * accident. The UI asks for explicit confirmation, showing the
 * descendant count, before passing cascade=true.
 */
export async function deleteTopic(id, cascade = false) {
  return unwrap(await supabase.rpc('delete_topic', { p_id: id, p_cascade: cascade }));
}
