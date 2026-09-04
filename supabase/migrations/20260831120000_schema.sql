-- =====================================================================
-- 20260831120000_schema.sql
-- Core schema: profiles, topics, topic_redirects
-- =====================================================================
--
-- HIERARCHY MODEL (see ARCHITECTURE.md §5 for the full rationale)
--
--   Adjacency list (parent_id)  = the SOURCE OF TRUTH for structure.
--   Materialized path (path)    = a DERIVED cache for O(1) URL lookup.
--
-- parent_id gives us referential integrity, cheap re-parenting and a
-- natural "children of X" query. It is terrible at "find the row whose
-- full URL is a/b/c" (recursive CTE, one index probe per level).
--
-- path gives us exactly that lookup for the price of one unique btree
-- probe, plus prefix-scannable subtree queries. It is terrible at moves
-- (every descendant must be rewritten).
--
-- Keeping both, with path maintained exclusively by triggers, gives us
-- the fast side of each. path is never writable by a client.
--
-- ltree was evaluated and REJECTED: ltree labels only accept hyphens on
-- PostgreSQL 16+ (PG 15 and below allow [A-Za-z0-9_] only), and Supabase
-- projects exist on both. Hyphens are mandatory in URL slugs, so ltree
-- would force a lossy slug<->label mapping for no gain at our depth
-- (<= 8 levels), where GiST ancestor operators beat a btree prefix scan
-- by nothing measurable.
-- =====================================================================

-- Supabase provisions this schema on every project and keeps it on the
-- default search_path; the line is here so the file also applies cleanly
-- to a bare PostgreSQL (local `supabase start`, CI, a self-hosted box).
create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;   -- gen_random_uuid()
create extension if not exists unaccent with schema extensions;   -- slugify()

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------
-- Mirrors auth.users because RLS policies cannot read auth.users
-- directly from the anon/authenticated roles, and because we need a
-- place to store the application role.
--
-- role: 'viewer' is the default so a brand-new signup is powerless.
-- Promotion to 'admin' is deliberately NOT possible through the API
-- (there is no UPDATE policy on this table, plus a guard trigger).
-- The Supabase project owner promotes admins from the SQL editor.
-- ---------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text,
  display_name  text,
  role          text not null default 'viewer'
                  constraint profiles_role_check check (role in ('viewer', 'admin')),
  created_at    timestamptz not null default now()
);

comment on table public.profiles is
  'Application-level user record. role drives every admin RLS policy.';

-- ---------------------------------------------------------------------
-- topics
-- ---------------------------------------------------------------------
create table public.topics (
  id            uuid primary key default gen_random_uuid(),

  -- Structure -------------------------------------------------------
  -- NO ACTION (the default) rather than CASCADE or RESTRICT, on purpose:
  --   * CASCADE  => one stray DELETE silently destroys a whole subtree.
  --   * RESTRICT => checked immediately, so even a deliberate
  --                 "delete this whole subtree in one statement" fails.
  --   * NO ACTION => checked at END OF STATEMENT. Deleting a parent on
  --                 its own errors out (good), but deleting the parent
  --                 and all of its descendants in a single statement
  --                 succeeds (also good). That is exactly the semantic
  --                 requested in §13: subtrees die only when you say so.
  parent_id     uuid references public.topics (id),

  slug          text not null
                  constraint topics_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
                  constraint topics_slug_length check (char_length(slug) between 1 and 80),

  -- Derived, trigger-maintained. Never accept these from a client.
  path          text not null,
  depth         int  not null constraint topics_depth_check check (depth between 1 and 8),

  -- Sibling ordering. Plain int, no unique constraint: reordering a list
  -- with a unique(parent_id, position) constraint requires a temporary
  -- negative-offset dance. reorder_siblings() rewrites the whole sibling
  -- list in one statement instead.
  position      int not null default 0,

  -- Content ---------------------------------------------------------
  title         text not null constraint topics_title_length check (char_length(title) between 1 and 200),
  content       text not null default '',
  excerpt       text constraint topics_excerpt_length check (excerpt is null or char_length(excerpt) <= 320),

  status        text not null default 'draft'
                  constraint topics_status_check check (status in ('draft', 'published')),

  -- Audit -----------------------------------------------------------
  created_by    uuid references public.profiles (id) on delete set null,
  updated_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz,

  -- Full-text search. GENERATED ALWAYS keeps it perfectly in sync with
  -- zero application code. to_tsvector(regconfig, text) is IMMUTABLE
  -- when the config is a literal, which is what generated columns need.
  search_vector tsvector generated always as (
      setweight(to_tsvector('english', coalesce(title,   '')), 'A') ||
      setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored,

  -- One constraint to rule them all. Because path = parent.path || '/' || slug,
  -- a unique path makes duplicate sibling slugs structurally impossible.
  -- A plain unique(parent_id, slug) would NOT do this: NULL parent_id
  -- values compare as distinct, so two root topics could both be 'database'.
  constraint topics_path_key unique (path),

  -- A topic cannot be its own parent. (Deeper cycles are caught by the
  -- trigger in the next migration; a CHECK cannot see other rows.)
  constraint topics_no_self_parent check (parent_id is null or parent_id <> id),

  -- Root slugs must not collide with application routes. Nested slugs
  -- are unrestricted because they can never appear as a first segment.
  constraint topics_reserved_root_slug check (
    parent_id is not null
    or slug not in ('admin','login','logout','api','assets','static',
                    'search','sitemap','robots','404','_app','favicon')
  )
);

comment on table public.topics is
  'Documentation nodes. Unlimited nesting via parent_id; path is a trigger-maintained cache of the full URL.';
comment on column public.topics.path is
  'DERIVED. Full URL path without leading slash, e.g. system-design/rate-limiter. Maintained by trigger only.';
comment on column public.topics.depth is
  'DERIVED. 1 for roots. Denormalised so depth guards and breadcrumb ordering need no string splitting.';

-- ---------------------------------------------------------------------
-- topic_redirects
-- ---------------------------------------------------------------------
-- Every time a topic's path changes (rename, re-slug or move) the OLD
-- path is recorded here, for the node and for every descendant. The SPA
-- consults this table before rendering a 404, so external links and
-- search-engine results never break.
--
-- Rows are written by a SECURITY DEFINER trigger, never by the API:
-- there are no INSERT/UPDATE/DELETE policies on this table at all.
-- ---------------------------------------------------------------------
create table public.topic_redirects (
  old_path    text primary key,
  topic_id    uuid not null references public.topics (id) on delete cascade,
  created_at  timestamptz not null default now()
);

comment on table public.topic_redirects is
  'old URL path -> topic. Populated automatically whenever topics.path changes.';
