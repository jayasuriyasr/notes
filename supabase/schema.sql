-- =====================================================================
--  Markdown Documentation Platform — COMPLETE SCHEMA (single paste)
--
--  This file is the four migrations in migrations/ concatenated in
--  order, for pasting into the Supabase SQL editor in one shot:
--
--     Supabase dashboard → SQL Editor → New query → paste → Run
--
--  If you use the Supabase CLI instead, ignore this file and run
--  `supabase db push`, which applies migrations/ individually and
--  records them so later migrations stack correctly.
--
--  Order matters. Tables must exist before triggers reference them,
--  functions before the policies that call them, and everything before
--  the indexes. Do not reorder.
--
--  Afterwards:
--     1.  supabase/seed.sql            — optional sample documentation
--     2.  Authentication → Users       — add your account
--     3.  update public.profiles set role = 'admin'
--           where email = 'you@example.com';
--
--  Safe to run on a fresh project. NOT idempotent — running it twice
--  errors on the CREATE TABLE. To start over:
--     drop table if exists public.topic_redirects, public.topics,
--                          public.profiles cascade;
-- =====================================================================



-- ###################################################################
-- ## 20260831120000_schema.sql
-- ###################################################################

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


-- ###################################################################
-- ## 20260831120100_functions.sql
-- ###################################################################

-- =====================================================================
-- 20260831120100_functions.sql
-- Slugs, path materialisation, cycle guards, redirects, RPCs
-- =====================================================================

-- ---------------------------------------------------------------------
-- slugify(text) -> text
-- ---------------------------------------------------------------------
-- Server-side normalisation so a slug is correct even if it never went
-- through the React form (seed scripts, SQL editor, a future importer).
-- The client runs an identical algorithm for instant preview; the DB is
-- what actually enforces it via the topics_slug_format CHECK.
-- STABLE, not IMMUTABLE: unaccent() depends on a dictionary file.
-- ---------------------------------------------------------------------
create or replace function public.slugify(p_text text)
returns text
language sql
stable
strict
set search_path = ''
as $$
  select nullif(
    trim(both '-' from
      regexp_replace(
        regexp_replace(lower(extensions.unaccent(p_text)), '[^a-z0-9]+', '-', 'g'),
        '-{2,}', '-', 'g')),
    '');
$$;

-- ---------------------------------------------------------------------
-- is_admin() -> boolean
-- ---------------------------------------------------------------------
-- The single authority every admin policy defers to.
--
-- SECURITY DEFINER is not a convenience here, it is load-bearing: a
-- policy on public.topics that reads public.profiles would otherwise be
-- subject to profiles' own RLS, and if profiles' policy ever referenced
-- topics you would get infinite recursion (error 42P17). Running as the
-- owner side-steps RLS on the lookup entirely.
--
-- `set search_path = ''` prevents a caller from shadowing `profiles`
-- with a temp table and impersonating an admin - the classic
-- SECURITY DEFINER privilege-escalation hole.
--
-- STABLE lets PostgreSQL evaluate it once per statement rather than
-- once per row.
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------
-- handle_new_user(): auth.users -> profiles
-- ---------------------------------------------------------------------
-- Runs as owner so it can insert into a table that has no INSERT policy.
-- Note it never reads a role from the signup payload: a new account is
-- always 'viewer'. This is the reason self-signup cannot mint an admin.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- profiles_guard_role(): block privilege escalation
-- ---------------------------------------------------------------------
-- Defence in depth. Today profiles has no UPDATE policy so this can
-- never fire from the API. If someone later adds one for display_name,
-- this trigger is what stops `PATCH /profiles?id=eq.me {role:'admin'}`.
--
-- auth.uid() is NULL for service-role requests and for raw SQL, so the
-- project owner can still promote admins; it is non-NULL only for a
-- request carrying a real end-user JWT, which is exactly what we block.
-- ---------------------------------------------------------------------
create or replace function public.profiles_guard_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role and (select auth.uid()) is not null then
    raise exception 'Role changes must be performed by the project owner, not through the API'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.profiles_guard_role();

-- =====================================================================
-- PATH MATERIALISATION
-- =====================================================================
-- Three triggers cooperate:
--
--   BEFORE INSERT/UPDATE  topics_before_write()  - derive slug, path,
--                         depth, audit columns; reject cycles.
--   AFTER  INSERT/UPDATE   topics_after_write()   - record a redirect and
--                         rewrite descendants when path changed; clear a
--                         stale redirect when a path is re-claimed.
--
-- The cascade sets a transaction-local flag. Without it the BEFORE
-- trigger on each descendant would recompute its path from its parent
-- row, and inside a single UPDATE statement a grandchild still sees its
-- parent's PRE-statement snapshot - so a 3-level move would corrupt
-- level 3. The flag tells the BEFORE trigger "the path in NEW is already
-- authoritative, don't touch it".
-- =====================================================================

create or replace function public.topics_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent      public.topics%rowtype;
  v_base_slug   text;
  v_candidate   text;
  v_prefix      text;
  v_n           int := 1;
  v_autoslug    boolean := false;
  v_max_depth   int;
begin
  -- The cascade below writes path/depth itself; leave them alone.
  if coalesce(current_setting('app.topics_cascade', true), '') = 'on' then
    new.updated_at := now();
    return new;
  end if;

  -- ---- slug --------------------------------------------------------
  if new.slug is null or btrim(new.slug) = '' then
    v_autoslug := true;
    new.slug := public.slugify(new.title);
    if new.slug is null then
      raise exception 'Title % does not contain any characters usable in a URL slug', new.title
        using errcode = '22023';
    end if;
  else
    new.slug := public.slugify(new.slug);
    if new.slug is null then
      raise exception 'Slug is empty after normalisation' using errcode = '22023';
    end if;
  end if;

  -- ---- parent + prefix ---------------------------------------------
  if new.parent_id is null then
    v_prefix   := '';
    new.depth  := 1;
  else
    select * into v_parent from public.topics where id = new.parent_id;
    if not found then
      raise exception 'Parent topic % does not exist', new.parent_id using errcode = '23503';
    end if;
    v_prefix  := v_parent.path || '/';
    new.depth := v_parent.depth + 1;
  end if;

  -- ---- cycle + depth guards (moves only) ---------------------------
  if tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id and new.parent_id is not null then
    if new.parent_id = old.id
       or exists (select 1 from public.topics t
                  where t.id = new.parent_id
                    and (t.path = old.path or t.path like old.path || '/%')) then
      raise exception 'Cannot move "%" beneath itself or one of its own descendants', old.title
        using errcode = '23514';
    end if;

    select max(depth) into v_max_depth
      from public.topics where path like old.path || '/%';

    if coalesce(v_max_depth, old.depth) + (new.depth - old.depth) > 8 then
      raise exception 'Move would nest descendants deeper than the 8-level limit'
        using errcode = '23514';
    end if;
  end if;

  -- ---- path, with dedupe for auto-generated slugs only --------------
  v_base_slug := new.slug;
  v_candidate := v_prefix || v_base_slug;

  if v_autoslug then
    -- "Rate Limiter" twice under the same parent silently becomes
    -- rate-limiter and rate-limiter-2. An explicitly typed duplicate
    -- slug instead hits the unique index and surfaces as an error,
    -- because silently renaming what an author deliberately typed is
    -- worse than telling them.
    while exists (
      select 1 from public.topics t
      where t.path = v_candidate and (tg_op = 'INSERT' or t.id <> new.id)
    ) loop
      v_n := v_n + 1;
      new.slug    := v_base_slug || '-' || v_n;
      v_candidate := v_prefix || new.slug;
    end loop;
  end if;

  new.path := v_candidate;

  -- ---- audit + publish bookkeeping ---------------------------------
  new.updated_at := now();
  new.updated_by := coalesce((select auth.uid()), new.updated_by);

  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by;   -- not client-writable
    new.created_at := old.created_at;
  end if;

  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;

  return new;
end;
$$;

create trigger topics_before_write
  before insert or update on public.topics
  for each row execute function public.topics_before_write();


create or replace function public.topics_after_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A brand-new topic claims its path outright: if that path used to
  -- redirect somewhere else, the redirect is now stale and must go, or
  -- deleting this topic later would silently resurrect the old target.
  if tg_op = 'INSERT' then
    delete from public.topic_redirects where old_path = new.path;
    return null;
  end if;

  if new.path is not distinct from old.path then
    return null;
  end if;

  -- 1. Remember where this node used to live. Fires for descendants too
  --    (they are updated by the statement below), so a subtree move
  --    produces a complete redirect set for free.
  insert into public.topic_redirects (old_path, topic_id)
  values (old.path, new.id)
  on conflict (old_path) do update set topic_id = excluded.topic_id,
                                       created_at = now();

  -- 2. A live path must never be shadowed by a stale redirect.
  delete from public.topic_redirects where old_path = new.path;

  -- 3. Rewrite descendants, unless we ARE the cascade.
  if coalesce(current_setting('app.topics_cascade', true), '') <> 'on' then
    perform set_config('app.topics_cascade', 'on', true);

    update public.topics d
       set path  = new.path || substring(d.path from char_length(old.path) + 1),
           depth = d.depth + (new.depth - old.depth)
     where d.path like old.path || '/%';

    perform set_config('app.topics_cascade', 'off', true);
  end if;

  return null;
end;
$$;

create trigger topics_after_write
  after insert or update on public.topics
  for each row execute function public.topics_after_write();

-- =====================================================================
-- READ RPCs  (SECURITY INVOKER: RLS still applies, so anonymous callers
-- transparently see published rows only)
-- =====================================================================

-- ---------------------------------------------------------------------
-- get_page(path) -> json
-- ---------------------------------------------------------------------
-- One round trip returns everything a documentation page needs:
-- the topic, its ancestors (breadcrumbs) and its direct children.
--
-- Breadcrumbs need no recursive CTE. Because path is a materialised
-- string, every ancestor path is a prefix of it, so we generate the
-- prefixes and hit the unique index once per level. For
-- system-design/rate-limiter/token-bucket that is 3 index probes.
-- ---------------------------------------------------------------------
create or replace function public.get_page(p_path text)
returns json
language sql
stable
set search_path = public
as $$
  with target as (
    select * from public.topics where path = p_path
  ),
  segments as (
    select string_to_array(p_path, '/') as parts
  ),
  ancestor_paths as (
    select array_to_string((select parts from segments)[1:i], '/') as p
    from generate_series(1, coalesce(array_length((select parts from segments), 1), 0)) as i
  )
  select json_build_object(
    'topic', (
      select to_json(t) from (
        select id, parent_id, slug, title, path, depth, position,
               content, excerpt, status, created_at, updated_at, published_at
        from target
      ) t
    ),
    'breadcrumbs', coalesce((
      select json_agg(json_build_object('title', b.title, 'path', b.path, 'slug', b.slug)
                      order by b.depth)
      from public.topics b
      where b.path in (select p from ancestor_paths)
    ), '[]'::json),
    'children', coalesce((
      select json_agg(json_build_object('id', c.id, 'title', c.title, 'path', c.path,
                                        'slug', c.slug, 'excerpt', c.excerpt)
                      order by c.position, c.title)
      from public.topics c
      where c.parent_id = (select id from target)
    ), '[]'::json)
  );
$$;

-- ---------------------------------------------------------------------
-- search_topics(query, limit)
-- ---------------------------------------------------------------------
-- websearch_to_tsquery understands quoted phrases, OR and -exclusions,
-- i.e. what people actually type. Highlighting uses non-HTML sentinels
-- deliberately: ts_headline does not escape the source document, so
-- emitting <mark> would hand raw page content straight into the DOM.
-- The client splits on the sentinels and builds real <mark> elements,
-- so no HTML is ever interpolated.
-- ---------------------------------------------------------------------
create or replace function public.search_topics(p_query text, p_limit int default 20)
returns table (id uuid, title text, path text, headline text, rank real)
language sql
stable
set search_path = public
as $$
  select t.id,
         t.title,
         t.path,
         ts_headline('english',
                     coalesce(nullif(t.excerpt, ''), left(t.content, 4000)),
                     q,
                     'StartSel=<<,StopSel=>>,MaxFragments=1,MaxWords=32,MinWords=12,FragmentDelimiter= … '),
         ts_rank(t.search_vector, q)
  from public.topics t,
       websearch_to_tsquery('english', p_query) q
  where t.search_vector @@ q
  order by ts_rank(t.search_vector, q) desc, t.depth asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- =====================================================================
-- WRITE RPCs  (SECURITY INVOKER: the topics RLS policies are still the
-- thing that says yes or no. These exist for atomicity and validation,
-- NOT as a security boundary - a non-admin calling them gets zero rows
-- affected, exactly as if they had called the REST endpoint directly.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- reorder_siblings(parent_id, ordered ids)
-- ---------------------------------------------------------------------
-- Rewrites an entire sibling list in one statement. Cheap (a sibling
-- list is a handful of rows) and completely free of the temporary
-- uniqueness violations that plague incremental swap-based reordering.
-- ---------------------------------------------------------------------
create or replace function public.reorder_siblings(p_parent_id uuid, p_ordered_ids uuid[])
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.topics t
     set position = o.ord - 1
    from unnest(p_ordered_ids) with ordinality as o(id, ord)
   where t.id = o.id
     and t.parent_id is not distinct from p_parent_id;
end;
$$;

-- ---------------------------------------------------------------------
-- move_topic(id, new_parent_id, position)
-- ---------------------------------------------------------------------
-- A plain UPDATE would work - the triggers do all the real labour - but
-- routing moves through one function keeps the "where does it land in
-- the sibling order" logic in a single place.
-- ---------------------------------------------------------------------
create or replace function public.move_topic(p_id uuid, p_new_parent_id uuid, p_position int default null)
returns public.topics
language plpgsql
set search_path = public
as $$
declare
  v_row public.topics;
  v_pos int;
begin
  if p_position is null then
    select coalesce(max(position) + 1, 0) into v_pos
      from public.topics where parent_id is not distinct from p_new_parent_id;
  else
    v_pos := p_position;
  end if;

  update public.topics
     set parent_id = p_new_parent_id,
         position  = v_pos
   where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'Topic % not found or not writable', p_id using errcode = '42501';
  end if;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- delete_topic(id, cascade)
-- ---------------------------------------------------------------------
-- cascade = false: deletes a leaf. If the topic has children the FK
--   raises 23503 at end of statement and NOTHING is lost.
-- cascade = true: deletes the node and its whole subtree in ONE
--   statement, so the NO ACTION check at statement end sees a consistent
--   graph and permits it. The count is returned so the UI can say
--   "deleted 7 pages" rather than leaving the author guessing.
-- ---------------------------------------------------------------------
create or replace function public.delete_topic(p_id uuid, p_cascade boolean default false)
returns int
language plpgsql
set search_path = public
as $$
declare
  v_path    text;
  v_deleted int;
begin
  select path into v_path from public.topics where id = p_id;
  if v_path is null then
    raise exception 'Topic % not found', p_id using errcode = 'P0002';
  end if;

  if p_cascade then
    delete from public.topics where path = v_path or path like v_path || '/%';
  else
    delete from public.topics where id = p_id;
  end if;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------
-- descendant_count(id) - what the confirmation dialog shows
-- ---------------------------------------------------------------------
create or replace function public.descendant_count(p_id uuid)
returns int
language sql
stable
set search_path = public
as $$
  select count(*)::int
  from public.topics d
  where d.path like (select path from public.topics where id = p_id) || '/%';
$$;


-- ###################################################################
-- ## 20260831120200_rls.sql
-- ###################################################################

-- =====================================================================
-- 20260831120200_rls.sql
-- Grants, Row Level Security, policies
-- =====================================================================
--
-- THE SECURITY MODEL IN ONE PARAGRAPH
--
-- The browser holds only the Supabase anon key. That key does not grant
-- anything; it merely identifies the request as coming from the `anon`
-- Postgres role (or `authenticated`, once a JWT is attached). Every read
-- and write then passes through the policies below, evaluated inside
-- PostgreSQL. There is no code path in which the React app decides
-- whether something is allowed. Deleting every `if (isAdmin)` line from
-- the frontend would change what the UI *shows* and nothing whatsoever
-- about what the database *permits*.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Table privileges: the coarse gate, before RLS gets a say
-- ---------------------------------------------------------------------
-- Supabase's default privileges hand `anon` full DML on new public
-- tables and rely on RLS alone. We tighten that: anon is granted SELECT
-- and nothing else, so an anonymous INSERT fails at the privilege layer
-- before a policy is ever consulted. Two independent locks, not one.
revoke all on public.topics          from anon, authenticated;
revoke all on public.profiles        from anon, authenticated;
revoke all on public.topic_redirects from anon, authenticated;

grant select                         on public.topics          to anon, authenticated;
grant insert, update, delete         on public.topics          to authenticated;
grant select                         on public.profiles        to authenticated;
grant select                         on public.topic_redirects to anon, authenticated;
-- Note: NOBODY is granted write on topic_redirects. Its rows are created
-- exclusively by the SECURITY DEFINER trigger, which runs as the table
-- owner and therefore bypasses both grants and policies.

alter table public.topics          enable row level security;
alter table public.profiles        enable row level security;
alter table public.topic_redirects enable row level security;

-- =====================================================================
-- topics
-- =====================================================================

-- Multiple PERMISSIVE policies for the same command are OR'ed together,
-- which is exactly the shape we want: "published, OR you're an admin".
-- Splitting them in two (rather than one policy with an OR) means the
-- anonymous path never calls is_admin() at all.

create policy "topics: anyone reads published"
  on public.topics for select
  to anon, authenticated
  using (status = 'published');

create policy "topics: admins read everything"
  on public.topics for select
  to authenticated
  using ((select public.is_admin()));

create policy "topics: admins insert"
  on public.topics for insert
  to authenticated
  with check ((select public.is_admin()));

-- USING decides which rows you may target; WITH CHECK decides what the
-- row may look like afterwards. Both are required: without WITH CHECK an
-- admin-only UPDATE would still be fine here, but the pair is the
-- correct habit and protects against a future policy that narrows USING.
create policy "topics: admins update"
  on public.topics for update
  to authenticated
  using       ((select public.is_admin()))
  with check  ((select public.is_admin()));

create policy "topics: admins delete"
  on public.topics for delete
  to authenticated
  using ((select public.is_admin()));

-- =====================================================================
-- profiles
-- =====================================================================
-- Deliberately read-only through the API. There is no INSERT policy
-- (rows come from the signup trigger), no UPDATE policy and no DELETE
-- policy. A user therefore cannot write `role` because a user cannot
-- write this table at all. profiles_guard_role() is the second lock.

create policy "profiles: read own"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy "profiles: admins read all"
  on public.profiles for select
  to authenticated
  using ((select public.is_admin()));

-- =====================================================================
-- topic_redirects
-- =====================================================================
-- Public by design: a redirect only ever reveals that a URL moved, and
-- resolving one still goes through the topics policies to fetch content.
-- A redirect pointing at a draft topic therefore resolves to a 404 for
-- anonymous visitors, not to hidden content.

create policy "redirects: world readable"
  on public.topic_redirects for select
  to anon, authenticated
  using (true);

-- =====================================================================
-- Function execution
-- =====================================================================
revoke all on function public.get_page(text)                     from public;
revoke all on function public.search_topics(text, int)           from public;
revoke all on function public.reorder_siblings(uuid, uuid[])     from public;
revoke all on function public.move_topic(uuid, uuid, int)        from public;
revoke all on function public.delete_topic(uuid, boolean)        from public;
revoke all on function public.descendant_count(uuid)             from public;
revoke all on function public.slugify(text)                      from public;

grant execute on function public.get_page(text)                  to anon, authenticated;
grant execute on function public.search_topics(text, int)        to anon, authenticated;
grant execute on function public.slugify(text)                   to anon, authenticated;

-- Write RPCs are reachable only by signed-in users, and even then every
-- statement inside them is still filtered by the topics policies above.
-- A 'viewer' who calls delete_topic() deletes zero rows.
grant execute on function public.reorder_siblings(uuid, uuid[])  to authenticated;
grant execute on function public.move_topic(uuid, uuid, int)     to authenticated;
grant execute on function public.delete_topic(uuid, boolean)     to authenticated;
grant execute on function public.descendant_count(uuid)          to authenticated;


-- ###################################################################
-- ## 20260831120300_indexes.sql
-- ###################################################################

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

