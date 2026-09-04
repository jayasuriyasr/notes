-- =====================================================================
-- 20260831120300_indexes.sql
-- Six indexes, each earning its place
-- =====================================================================
--
-- Already implied by constraints (not repeated here):
--   topics_pkey            (id)
--   topics_path_key        (path)      UNIQUE - the workhorse. Serves the
--                                      public page lookup (path = $1) AND
--                                      every breadcrumb probe
--                                      (path IN (...)), and enforces
--                                      sibling-slug uniqueness.
--   profiles_pkey          (id)
--   profiles_username_key  (username)
--   topic_redirects_pkey   (old_path)  - the 404 fallback lookup
-- =====================================================================

-- 1. Subtree scans: path LIKE 'system-design/%'
-- ---------------------------------------------------------------------
-- topics_path_key CANNOT serve this. Supabase databases are created with
-- a non-C collation (en_US.UTF-8), and a btree built in a non-C
-- collation is unusable for prefix LIKE. text_pattern_ops builds the
-- same btree with C-style byte comparison, which is what LIKE 'x%' needs.
--
-- Optimises: the move cascade, subtree delete, descendant_count.
-- Infrequent, but they touch the most rows of anything in the system.
create index topics_path_prefix_idx
  on public.topics (path text_pattern_ops);

-- 2. Children, and the parent foreign key
-- ---------------------------------------------------------------------
-- Optimises: "children of X" ordered by sibling position, the admin
-- tree, reorder_siblings, and the recursive visibility cascade, which
-- walks the tree by parent_id one level at a time.
--
-- Also matters for writes: PostgreSQL does NOT auto-index the
-- referencing side of a foreign key, so without this every topic DELETE
-- sequentially scans topics to prove no child references it.
create index topics_parent_position_idx
  on public.topics (parent_id, position);

-- 3. Ownership
-- ---------------------------------------------------------------------
-- New in the multi-user model, and it earns its place twice over:
--
--   read   Every dashboard load runs `where owner_id = $1`. This is now
--          one of the two hottest queries in the application.
--   write  topics.owner_id is NOT NULL with no ON DELETE action, so
--          removing an account has to find every page that references
--          it. admin_delete_user reassigns them in one statement; that
--          statement is a seq scan without this index.
create index topics_owner_idx
  on public.topics (owner_id);

-- 4. Full-text search
-- ---------------------------------------------------------------------
-- GIN, not GiST: roughly 3x faster to query, slower to write. Correct
-- for a table that is read constantly and written a few times a day.
create index topics_search_idx
  on public.topics using gin (search_vector);

-- 5. Redirect cleanup on page delete
-- ---------------------------------------------------------------------
-- topic_redirects.topic_id is ON DELETE CASCADE; same story as #2 - the
-- referencing column needs its own index or every page delete scans the
-- redirect table.
create index topic_redirects_topic_id_idx
  on public.topic_redirects (topic_id);

-- 6. The administrator's user list
-- ---------------------------------------------------------------------
-- admin_list_users() groups topics by owner_id to produce page counts.
-- Index #3 already serves that grouping, so there is no sixth index -
-- the numbering stops at five. Left in place as a note so the next
-- person does not add one.

-- =====================================================================
-- DELIBERATELY NOT CREATED
-- =====================================================================
--
--  (effective_visibility)  Three values, and roughly 90% of rows share
--                          one of them. The planner will not choose it;
--                          it would be pure write overhead.
--
--  (created_by), (updated_by)
--                          Both are ON DELETE SET NULL, so they are
--                          scanned only when an account is deleted - a
--                          rare, deliberate action where one extra scan
--                          of a few thousand rows costs under a
--                          millisecond. owner_id is indexed because it
--                          is read on every dashboard load; these are
--                          not.
--
--  (created_at), (updated_at)
--                          The dashboards fetch a member's whole tree
--                          and sort in the browser.
--
--  (slug)                  Never queried alone. Lookups go by full path
--                          or by (parent_id, ...).
--
--  partial (path) WHERE effective_visibility <> 'private'
--                          Would make the public navigation query an
--                          index-only scan. Worth adding when the
--                          shared tree passes roughly 10,000 pages;
--                          below that, seq scan + sort beats the index
--                          maintenance.
--
-- Every index is a permanent tax on every write and on backup size.
-- Five is what this query set justifies.
-- =====================================================================
