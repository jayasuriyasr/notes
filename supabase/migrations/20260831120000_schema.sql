-- =====================================================================
-- 20260831120000_schema.sql
-- Core schema: profiles, topics, topic_redirects
-- =====================================================================
--
-- HIERARCHY MODEL (see ARCHITECTURE.md §5)
--
--   Adjacency list (parent_id)  = the SOURCE OF TRUTH for structure.
--   Materialized path (path)    = a DERIVED cache for O(1) URL lookup.
--
-- ltree was evaluated and rejected: its labels only accept hyphens on
-- PostgreSQL 16+, and Supabase hosts both 15 and 17. Hyphens are
-- mandatory in URL slugs.
--
--
-- PERMISSION MODEL
--
-- Two things decide who may touch a page, and they are deliberately
-- kept apart:
--
--   owner_id    WHO controls it   - the member who created it
--   visibility  WHO ELSE may act  - private | public | collaborative
--
-- visibility is a single setting rather than a pair of switches
-- (draft/published plus a sharing level) because the pair produces six
-- states, two of which are nonsense to explain ("published private").
-- One three-valued setting says everything:
--
--   private        only the owner and administrators
--   public         anyone reads; the owner and administrators edit
--   collaborative  anyone reads; ANY signed-in, active member edits
--
--
-- INHERITANCE: THE MOST RESTRICTIVE ANCESTOR WINS
--
-- A private folder hides everything beneath it, whatever the children
-- say. This is not a nicety - URLs here are paths. If /research were
-- private but /research/notes were public, a visitor could open
-- /research/notes and then see a breadcrumb to /research that 404s for
-- them. "Private" has to mean the whole subtree or it means nothing.
--
-- That rule is materialised into `effective_visibility` by trigger, so
-- the RLS policies read ONE column and never walk the tree:
--
--   effective_visibility = 'private'   if the parent is effectively private
--                        = visibility  otherwise
--
-- Note what this does NOT do: a collaborative page under a merely
-- public parent stays collaborative. Only `private` propagates
-- downward, because only `private` is a statement about who may SEE
-- the subtree. Edit rights are a per-page decision.
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
-- Mirrors auth.users, because RLS policies run as anon/authenticated and
-- those roles cannot read auth.users - and because the application needs
-- somewhere to put a role and an account status that is not the JWT.
--
-- role:   'member' is the default, so a fresh signup can create and own
--         pages but has no authority over anyone else's. Promotion to
--         'admin' is impossible through the API (§rls) - it happens
--         through admin_set_role(), which checks the caller first.
--
-- status: 'suspended' is a soft ban. The account still exists and its
--         pages are untouched, but every write policy fails, so the
--         member is reduced to an ordinary reader. Reversible in one
--         click, which is what makes it usable for moderation.
-- ---------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  username      text not null
                  constraint profiles_username_key unique
                  constraint profiles_username_format
                    check (username ~ '^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])$'),
  display_name  text,
  role          text not null default 'member'
                  constraint profiles_role_check check (role in ('member', 'admin')),
  status        text not null default 'active'
                  constraint profiles_status_check check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.profiles is
  'Application user record. role and status drive every write policy in the system.';
comment on column public.profiles.status is
  'suspended = a soft ban: the account and its content survive, but every write policy fails.';

-- ---------------------------------------------------------------------
-- topics
-- ---------------------------------------------------------------------
create table public.topics (
  id            uuid primary key default gen_random_uuid(),

  -- Structure -------------------------------------------------------
  -- NO ACTION (the default) rather than CASCADE or RESTRICT, on purpose:
  --   CASCADE  => one stray DELETE silently destroys a whole subtree.
  --   RESTRICT => checked immediately, so even a deliberate
  --               "delete this whole subtree in one statement" fails.
  --   NO ACTION => checked at END OF STATEMENT: deleting a parent alone
  --               errors, deleting parent+descendants together succeeds.
  parent_id     uuid references public.topics (id),

  slug          text not null
                  constraint topics_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
                  constraint topics_slug_length check (char_length(slug) between 1 and 80),

  -- Derived, trigger-maintained. Never accepted from a client.
  path          text not null,
  depth         int  not null constraint topics_depth_check check (depth between 1 and 8),

  position      int not null default 0,

  -- Ownership -------------------------------------------------------
  -- owner_id is MUTABLE: it transfers when an administrator removes the
  -- previous owner. created_by is the historical author and never
  -- changes. They are usually the same person, which is exactly why
  -- collapsing them would be a mistake - the day they differ is the day
  -- you need both. updated_by matters more here than in a single-author
  -- CMS, because a collaborative page is routinely edited by someone
  -- who does not own it.
  owner_id      uuid not null references public.profiles (id),
  created_by    uuid references public.profiles (id) on delete set null,
  updated_by    uuid references public.profiles (id) on delete set null,

  -- Content ---------------------------------------------------------
  title         text not null constraint topics_title_length check (char_length(title) between 1 and 200),
  content       text not null default '',
  excerpt       text constraint topics_excerpt_length check (excerpt is null or char_length(excerpt) <= 320),

  -- Access ----------------------------------------------------------
  visibility    text not null default 'private'
                  constraint topics_visibility_check
                    check (visibility in ('private', 'public', 'collaborative')),

  -- DERIVED from the ancestor chain. This is the column every RLS
  -- policy reads, which is what keeps the policies free of recursion.
  effective_visibility text not null default 'private'
                  constraint topics_effective_visibility_check
                    check (effective_visibility in ('private', 'public', 'collaborative')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz,

  search_vector tsvector generated always as (
      setweight(to_tsvector('english', coalesce(title,   '')), 'A') ||
      setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') ||
      setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) stored,

  -- Because path = parent.path || '/' || slug, a unique path makes
  -- duplicate sibling slugs structurally impossible. A plain
  -- unique(parent_id, slug) would NOT: NULL parent_id values compare as
  -- distinct, so two root topics could both be 'notes'.
  constraint topics_path_key unique (path),

  constraint topics_no_self_parent check (parent_id is null or parent_id <> id),

  -- Root slugs must not shadow application routes. Nested slugs are
  -- unrestricted, since they can never appear as a first segment.
  constraint topics_reserved_root_slug check (
    parent_id is not null
    or slug not in ('admin','login','logout','register','signup','signin',
                    'dashboard','account','settings','api','assets','static',
                    'search','sitemap','robots','404','_app','favicon','u','user')
  )
);

comment on column public.topics.owner_id is
  'Who controls this page. Transfers to the acting administrator when the previous owner is deleted.';
comment on column public.topics.effective_visibility is
  'DERIVED. private if any ancestor is private, else visibility. The only access column RLS reads.';

-- ---------------------------------------------------------------------
-- topic_redirects
-- ---------------------------------------------------------------------
-- Every time a page's path changes (rename, re-slug or move), the OLD
-- path is recorded here for the page and for every descendant, so
-- external links and search results never break.
--
-- Rows are written exclusively by a SECURITY DEFINER trigger; there are
-- no write policies on this table at all.
-- ---------------------------------------------------------------------
create table public.topic_redirects (
  old_path    text primary key,
  topic_id    uuid not null references public.topics (id) on delete cascade,
  created_at  timestamptz not null default now()
);

comment on table public.topic_redirects is
  'old URL path -> page. Populated automatically whenever topics.path changes.';

-- ---------------------------------------------------------------------
-- public_profiles
-- ---------------------------------------------------------------------
-- Pages now show who wrote them, so every reader needs to resolve an
-- owner_id to a username. They must NOT get the rest of the row.
--
-- A view is the right tool: PostgreSQL runs it with the privileges of
-- its owner unless `security_invoker` is set, so it reads through
-- profiles' RLS while exposing only three harmless columns. The
-- alternative - a policy letting everyone SELECT profiles - would leak
-- every member's email address and account status to the world.
-- ---------------------------------------------------------------------
create view public.public_profiles as
  select id, username, display_name from public.profiles;

comment on view public.public_profiles is
  'Read-only, world-readable projection of profiles: id, username, display_name. No email, role or status.';
