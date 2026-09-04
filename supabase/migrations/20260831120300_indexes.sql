-- =====================================================================
-- 20260831120300_indexes.sql
-- Exactly five indexes, each earning its place
-- =====================================================================
--
-- Already implied by constraints (not repeated here):
--   topics_pkey                (id)     - PK
--   topics_path_key            (path)   - UNIQUE. This is the workhorse:
--                                         it serves the public page
--                                         lookup (path = $1) AND every
--                                         breadcrumb probe (path IN (...)).
--   profiles_pkey              (id)
--   topic_redirects_pkey       (old_path) - serves the 404 fallback lookup
-- =====================================================================

-- 1. Subtree scans: path LIKE 'system-design/%'
-- ---------------------------------------------------------------------
-- topics_path_key CANNOT serve this. Supabase databases are created with
-- a non-C collation (en_US.UTF-8), and a btree built in a non-C collation
-- is unusable for prefix LIKE. text_pattern_ops builds the same btree
-- with C-style byte comparison, which is exactly what LIKE 'x%' needs.
--
-- Optimises: move cascade, subtree delete, descendant_count.
-- These are admin-only and infrequent, but they are the operations that
-- touch the most rows, and without this index every one of them is a
-- sequential scan of the whole table.
create index topics_path_prefix_idx
  on public.topics (path text_pattern_ops);

-- 2. Children, and the FK itself
-- ---------------------------------------------------------------------
-- Optimises: "children of X" ordered by sibling position, the admin tree
-- expansion, and reorder_siblings.
--
-- Also important for writes: PostgreSQL does NOT auto-index the
-- referencing side of a foreign key. Without this, every DELETE of a
-- topic triggers a seq scan of topics to prove no child references it.
create index topics_parent_position_idx
  on public.topics (parent_id, position);

-- 3. Full-text search
-- ---------------------------------------------------------------------
-- GIN, not GiST: GIN is roughly 3x faster to query and this table is
-- read-dominated. The write cost (GIN's slower inserts) is irrelevant
-- when writes are "an admin saved a page".
create index topics_search_idx
  on public.topics using gin (search_vector);

-- 4. Redirect cleanup on topic delete
-- ---------------------------------------------------------------------
-- topic_redirects.topic_id is ON DELETE CASCADE; same story as #2 - the
-- referencing column needs its own index or every topic delete scans the
-- redirect table.
create index topic_redirects_topic_id_idx
  on public.topic_redirects (topic_id);

-- =====================================================================
-- DELIBERATELY NOT CREATED
-- =====================================================================
--
--  (status)              - two values, ~90% 'published'. A btree on a
--                          column with that selectivity is never chosen
--                          by the planner; it is pure write overhead.
--
--  (created_at) / (updated_at)
--                        - the admin dashboard fetches the entire tree
--                          (a few thousand rows at most) and sorts in
--                          the browser. Sorting 3k rows in memory costs
--                          under a millisecond.
--
--  (slug)                - never queried alone. Lookups are always by
--                          full path or by (parent_id, ...).
--
--  (created_by)          - only scanned when a profile is deleted, which
--                          is a manual, once-in-a-blue-moon operation.
--
--  partial (path) WHERE status='published'
--                        - would make the navigation-tree query an
--                          index-only scan. Worth adding when the
--                          published tree passes roughly 10,000 rows;
--                          below that a seq scan + sort is faster than
--                          the index maintenance is worth.
--
-- The principle: an index is a permanent tax on every write and on
-- backup size. Five is the number this application's query set justifies.
-- =====================================================================
