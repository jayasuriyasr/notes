-- =====================================================================
--  Markdown Documentation Platform — COMPLETE SCHEMA (single paste)
--
--  This file is the five migrations in migrations/ concatenated in
--  order, for pasting into the Supabase SQL editor in one shot:
--
--     Supabase dashboard → SQL Editor → New query → paste → Run
--
--  If you use the Supabase CLI instead, ignore this file and run
--  `supabase db push`, which applies migrations/ individually and
--  records them so later migrations stack correctly.
--
--  Order matters. Tables and the public_profiles view must exist before
--  the functions that query them, functions before the policies that
--  call them, and everything before the indexes. Do not reorder.
--
--  Afterwards:
--     1.  Register an account in the app  (/register)
--     2.  Promote it, once, by hand:
--           update public.profiles set role = 'admin'
--             where email = 'you@example.com';
--     3.  supabase/seed.sql   — optional sample pages, owned by that account
--
--  Safe to run on a fresh project. NOT idempotent — running it twice
--  errors on the first CREATE TABLE. To start over, or to replace an
--  earlier single-author version of this schema:
--
--     drop table if exists public.topic_redirects, public.topics,
--                          public.profiles cascade;
--     drop view  if exists public.public_profiles;
-- =====================================================================



-- ###################################################################
-- ## 20260831120000_schema.sql
-- ###################################################################

-- ###################################################################
-- ## 20260831120000_schema.sql
-- ###################################################################

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


-- ###################################################################
-- ## 20260831120100_functions.sql
-- ###################################################################

-- =====================================================================
-- 20260831120100_functions.sql
-- Identity helpers, path + visibility materialisation, RPCs
-- =====================================================================

-- ---------------------------------------------------------------------
-- slugify(text) -> text
-- ---------------------------------------------------------------------
create or replace function public.slugify(p_text text)
returns text
language sql stable strict
set search_path = ''
as $$
  select nullif(
    trim(both '-' from
      regexp_replace(
        regexp_replace(lower(extensions.unaccent(p_text)), '[^a-z0-9]+', '-', 'g'),
        '-{2,}', '-', 'g')),
    '');
$$;

-- =====================================================================
-- IDENTITY HELPERS
-- =====================================================================
-- Every one of these is SECURITY DEFINER with a pinned search_path, and
-- both properties are load-bearing:
--
--   SECURITY DEFINER  A policy on `topics` that reads `profiles` would
--                     otherwise be subject to profiles' own RLS. Running
--                     as the owner side-steps that, and side-steps the
--                     infinite recursion (error 42P17) you get the
--                     moment two tables' policies reference each other.
--
--   search_path = ''  Without it a caller can create a temp table named
--                     `profiles` and impersonate an administrator. This
--                     is THE SECURITY DEFINER escalation hole.
--
--   STABLE            Lets PostgreSQL evaluate once per statement rather
--                     than once per row.
-- =====================================================================

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.status = 'active'          -- a suspended admin is not an admin
  );
$$;

-- Signed in, has a profile, and not suspended.
-- Every write policy starts here, which is what makes suspension a real
-- ban rather than a label: a suspended member is reduced to an
-- anonymous reader without losing a single page.
create or replace function public.is_active()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------
-- can_edit(topic_id) -> boolean
-- ---------------------------------------------------------------------
-- The single answer to "may the current caller change this page?".
-- Used by the INSERT policy (to test the intended parent) and exposed to
-- the UI so a button is never shown that the database would refuse.
--
-- Deliberately NOT used for delete: editing a collaborative page is an
-- invitation; destroying it is not. Deletion stays with the owner and
-- administrators.
-- ---------------------------------------------------------------------
create or replace function public.can_edit(p_topic_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case
    when p_topic_id is null then public.is_active()      -- creating at the root
    when not public.is_active() then false
    when public.is_admin() then true
    else exists (
      select 1 from public.topics t
      where t.id = p_topic_id
        and (t.owner_id = (select auth.uid())
             or t.effective_visibility = 'collaborative')
    )
  end;
$$;

-- ---------------------------------------------------------------------
-- handle_new_user(): auth.users -> profiles
-- ---------------------------------------------------------------------
-- Runs as owner so it can insert into a table with no INSERT policy.
--
-- It never reads a role or a status from the signup payload. A new
-- account is always ('member','active'), which is why open registration
-- cannot mint an administrator no matter what the client posts.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_base text;
  v_name text;
  v_n    int := 1;
begin
  -- Username from the email local part, then de-duplicated. The CHECK
  -- wants 3-30 characters, so a very short local part is padded rather
  -- than rejected - failing a signup over "j@example.com" would be absurd.
  v_base := coalesce(public.slugify(split_part(new.email, '@', 1)), 'member');
  v_base := replace(v_base, '-', '_');
  while char_length(v_base) < 3 loop v_base := v_base || '0'; end loop;
  v_base := left(v_base, 24);

  v_name := v_base;
  while exists (select 1 from public.profiles p where p.username = v_name) loop
    v_n := v_n + 1;
    v_name := v_base || v_n::text;
  end loop;

  insert into public.profiles (id, email, username, display_name)
  values (
    new.id,
    new.email,
    v_name,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'display_name',
                         new.raw_user_meta_data ->> 'full_name', '')), '')
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
-- profiles_guard(): the anti-escalation trigger
-- ---------------------------------------------------------------------
-- profiles has no UPDATE policy for members other than editing their own
-- display name, so this should never fire from the API. It exists
-- because the day somebody adds a convenience policy for display_name is
-- the day `PATCH /profiles?id=eq.me {"role":"admin"}` becomes
-- interesting.
--
-- auth.uid() is NULL for service-role requests and for raw SQL, so the
-- project owner can still fix things by hand; it is non-NULL only for a
-- request carrying a real end-user JWT, which is exactly what we block.
-- The admin_* functions below are SECURITY DEFINER and set a flag to
-- pass through legitimately.
-- ---------------------------------------------------------------------
create or replace function public.profiles_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(current_setting('app.admin_action', true), '') = 'on' then
    new.updated_at := now();
    return new;
  end if;

  if (select auth.uid()) is not null then
    if new.role is distinct from old.role then
      raise exception 'Roles are changed through admin_set_role(), not by writing to profiles'
        using errcode = '42501';
    end if;
    if new.status is distinct from old.status then
      raise exception 'Account status is changed through admin_set_status()'
        using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.email is distinct from old.email then
      raise exception 'Identity columns are not editable' using errcode = '42501';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- =====================================================================
-- PATH AND VISIBILITY MATERIALISATION
-- =====================================================================
-- Two triggers, and one transaction-local flag that is easy to miss and
-- essential:
--
--   BEFORE INSERT/UPDATE  topics_before_write()
--   AFTER  INSERT/UPDATE  topics_after_write()
--
-- The AFTER trigger rewrites descendants in a single statement, which
-- re-fires the BEFORE trigger on each of them. Inside one statement a
-- grandchild still reads its parent's PRE-statement snapshot, so
-- recomputing from the parent there would silently corrupt level 3 and
-- below. `app.topics_cascade` tells the BEFORE trigger that the values
-- in NEW are already authoritative.
-- =====================================================================

create or replace function public.topics_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_parent    public.topics%rowtype;
  v_base_slug text;
  v_candidate text;
  v_prefix    text;
  v_n         int := 1;
  v_autoslug  boolean := false;
  v_max_depth int;
  v_uid       uuid := (select auth.uid());
  v_admin     boolean;
begin
  -- The cascading statement below computes path/depth/effective
  -- visibility itself; leave every column exactly as it set them.
  if coalesce(current_setting('app.topics_cascade', true), '') = 'on' then
    return new;
  end if;

  v_admin := public.is_admin();

  -- ---- ownership ---------------------------------------------------
  if tg_op = 'INSERT' then
    -- Whatever the client posted for owner_id is discarded. Forging
    -- authorship is not a thing you can do by editing a request body.
    if v_uid is not null then new.owner_id := v_uid; end if;
    new.created_by := new.owner_id;
    new.created_at := now();
  else
    new.created_at := old.created_at;

    -- created_by is historical and a client may not forge it - but it is
    -- also the target of an ON DELETE SET NULL from profiles. Blanket
    -- "always restore the old value" undoes that referential action, and
    -- the delete then fails on the very constraint the action exists to
    -- satisfy. So: reject a change to a DIFFERENT author, and let NULL
    -- through, which is the only value PostgreSQL itself ever writes here.
    if new.created_by is not null and new.created_by is distinct from old.created_by then
      new.created_by := old.created_by;
    end if;

    -- A COLLABORATIVE EDITOR IS A GUEST, NOT A CO-OWNER.
    -- The RLS policy lets any active member update a collaborative page,
    -- and on its own that would also let them seize ownership, flip the
    -- page to private, rename its URL or move it into their own section
    -- - a hostile takeover dressed up as an edit. WITH CHECK cannot stop
    -- it, because a policy cannot see the OLD row. This can.
    --
    -- It REFUSES rather than silently reverting. A guest who somehow
    -- submits a rename should be told no, not shown "saved" over a
    -- change that did not happen. Comparing against OLD rather than
    -- blanket-rejecting the columns means an ordinary save that echoes
    -- back unchanged values still goes through.
    if not v_admin and old.owner_id is distinct from v_uid then
      if new.owner_id   is distinct from old.owner_id
      or new.visibility is distinct from old.visibility
      or new.slug       is distinct from old.slug
      or new.parent_id  is distinct from old.parent_id then
        raise exception
          'You can edit the text of a shared page, but only its owner can rename it, move it, or change who may see it'
          using errcode = '42501';
      end if;
      new.position := old.position;
    elsif not v_admin then
      new.owner_id := old.owner_id;        -- owners do not transfer pages
    end if;
  end if;

  -- ---- slug --------------------------------------------------------
  if new.slug is null or btrim(new.slug) = '' then
    v_autoslug := true;
    new.slug := public.slugify(new.title);
    if new.slug is null then
      raise exception 'The title "%" contains no characters usable in a URL', new.title
        using errcode = '22023';
    end if;
  else
    new.slug := public.slugify(new.slug);
    if new.slug is null then
      raise exception 'Slug is empty after normalisation' using errcode = '22023';
    end if;
  end if;

  -- ---- parent, path prefix, inherited visibility --------------------
  if new.parent_id is null then
    v_prefix                 := '';
    new.depth                := 1;
    new.effective_visibility := new.visibility;
  else
    select * into v_parent from public.topics where id = new.parent_id;
    if not found then
      raise exception 'Parent page % does not exist', new.parent_id using errcode = '23503';
    end if;
    v_prefix  := v_parent.path || '/';
    new.depth := v_parent.depth + 1;

    -- THE INHERITANCE RULE. Only `private` propagates: it is the only
    -- setting that says anything about who may SEE the subtree.
    new.effective_visibility := case
      when v_parent.effective_visibility = 'private' then 'private'
      else new.visibility
    end;
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
      raise exception 'That move would nest pages deeper than the 8-level limit'
        using errcode = '23514';
    end if;
  end if;

  -- ---- path, de-duplicating auto-generated slugs only ---------------
  v_base_slug := new.slug;
  v_candidate := v_prefix || v_base_slug;

  if v_autoslug then
    -- Two pages titled "Notes" under the same parent become notes and
    -- notes-2. A slug the author TYPED gets a conflict error instead,
    -- because silently renaming a deliberate choice is worse than
    -- refusing it.
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

  -- ---- audit -------------------------------------------------------
  new.updated_at := now();
  if v_uid is not null then new.updated_by := v_uid; end if;

  if new.effective_visibility <> 'private' and new.published_at is null then
    new.published_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists topics_before_write on public.topics;
create trigger topics_before_write
  before insert or update on public.topics
  for each row execute function public.topics_before_write();


create or replace function public.topics_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- A new page claims its path outright; a redirect still pointing there
  -- is stale and must go, or deleting this page later would silently
  -- resurrect the old target.
  if tg_op = 'INSERT' then
    delete from public.topic_redirects where old_path = new.path;
    return null;
  end if;

  if coalesce(current_setting('app.topics_cascade', true), '') = 'on' then
    -- We ARE the cascade. Record the descendant's old URL, then stop:
    -- re-entering the rewrite below would recurse forever.
    if new.path is distinct from old.path then
      insert into public.topic_redirects (old_path, topic_id) values (old.path, new.id)
      on conflict (old_path) do update set topic_id = excluded.topic_id, created_at = now();
      delete from public.topic_redirects where old_path = new.path;
    end if;
    return null;
  end if;

  -- ---- the URL moved ------------------------------------------------
  if new.path is distinct from old.path then
    insert into public.topic_redirects (old_path, topic_id) values (old.path, new.id)
    on conflict (old_path) do update set topic_id = excluded.topic_id, created_at = now();
    delete from public.topic_redirects where old_path = new.path;

    perform set_config('app.topics_cascade', 'on', true);
    update public.topics d
       set path  = new.path || substring(d.path from char_length(old.path) + 1),
           depth = d.depth + (new.depth - old.depth)
     where d.path like old.path || '/%';
    perform set_config('app.topics_cascade', 'off', true);
  end if;

  -- ---- the effective visibility moved -------------------------------
  -- Walks DOWN one level at a time rather than testing every ancestor of
  -- every descendant: each row's answer depends only on its parent's,
  -- and by the time the recursion reaches a row its parent is already
  -- correct. That turns an O(depth) test per descendant into one
  -- indexed pass over the subtree.
  if new.effective_visibility is distinct from old.effective_visibility then
    perform set_config('app.topics_cascade', 'on', true);

    with recursive sub as (
      select c.id,
             case when new.effective_visibility = 'private'
                  then 'private' else c.visibility end as eff
      from public.topics c
      where c.parent_id = new.id

      union all

      select c.id,
             case when s.eff = 'private' then 'private' else c.visibility end
      from public.topics c
      join sub s on c.parent_id = s.id
    )
    update public.topics t
       set effective_visibility = sub.eff,
           published_at = case
             when sub.eff <> 'private' and t.published_at is null then now()
             else t.published_at end
      from sub
     where t.id = sub.id
       and t.effective_visibility is distinct from sub.eff;

    perform set_config('app.topics_cascade', 'off', true);
  end if;

  return null;
end;
$$;

drop trigger if exists topics_after_write on public.topics;
create trigger topics_after_write
  after insert or update on public.topics
  for each row execute function public.topics_after_write();

-- =====================================================================
-- READ RPCs   (SECURITY INVOKER: RLS still applies, so an anonymous
-- caller transparently sees non-private pages only)
-- =====================================================================

-- ---------------------------------------------------------------------
-- get_page(path) -> json
-- ---------------------------------------------------------------------
-- One round trip returns the page, its ancestors and its children, plus
-- the two booleans the UI needs to decide which controls to render.
--
-- Breadcrumbs need no recursive CTE: because path is a materialised
-- string, every ancestor path is a prefix of it, so we generate the
-- prefixes and hit the unique index once per level.
-- ---------------------------------------------------------------------
create or replace function public.get_page(p_path text)
returns json
language sql stable
set search_path = public
as $$
  with target as (
    select * from public.topics where path = p_path
  ),
  segments as (select string_to_array(p_path, '/') as parts),
  ancestor_paths as (
    select array_to_string((select parts from segments)[1:i], '/') as p
    from generate_series(1, coalesce(array_length((select parts from segments), 1), 0)) as i
  )
  select json_build_object(
    'topic', (
      select to_json(t) from (
        select tg.id, tg.parent_id, tg.slug, tg.title, tg.path, tg.depth, tg.position,
               tg.content, tg.excerpt, tg.visibility, tg.effective_visibility,
               tg.owner_id, tg.created_at, tg.updated_at, tg.published_at,
               op.username as owner_username, op.display_name as owner_name,
               up.username as editor_username
        from target tg
        left join public.public_profiles op on op.id = tg.owner_id
        left join public.public_profiles up on up.id = tg.updated_by
      ) t
    ),
    'can_edit', (select public.can_edit((select id from target))),
    'is_owner', (select exists (select 1 from target where owner_id = (select auth.uid()))),
    'breadcrumbs', coalesce((
      select json_agg(json_build_object('title', b.title, 'path', b.path, 'slug', b.slug)
                      order by b.depth)
      from public.topics b
      where b.path in (select p from ancestor_paths)
    ), '[]'::json),
    'children', coalesce((
      select json_agg(json_build_object('id', c.id, 'title', c.title, 'path', c.path,
                                        'slug', c.slug, 'excerpt', c.excerpt,
                                        'visibility', c.effective_visibility)
                      order by c.position, c.title)
      from public.topics c
      where c.parent_id = (select id from target)
    ), '[]'::json)
  );
$$;

-- ---------------------------------------------------------------------
-- search_topics(query, limit)
-- ---------------------------------------------------------------------
-- websearch_to_tsquery understands quoted phrases, OR and -exclusions -
-- what people actually type - and never raises a syntax error.
--
-- Highlighting uses non-HTML sentinels on purpose: ts_headline does NOT
-- escape the document it highlights, so emitting <mark> would pipe raw
-- page content straight into the DOM. The client splits on the
-- sentinels and builds real <mark> elements instead.
-- ---------------------------------------------------------------------
create or replace function public.search_topics(p_query text, p_limit int default 20)
returns table (id uuid, title text, path text, headline text, rank real, visibility text)
language sql stable
set search_path = public
as $$
  select t.id, t.title, t.path,
         ts_headline('english',
                     coalesce(nullif(t.excerpt, ''), left(t.content, 4000)),
                     q,
                     'StartSel=<<,StopSel=>>,MaxFragments=1,MaxWords=32,MinWords=12,FragmentDelimiter= … '),
         ts_rank(t.search_vector, q),
         t.effective_visibility
  from public.topics t,
       websearch_to_tsquery('english', p_query) q
  where t.search_vector @@ q
  order by ts_rank(t.search_vector, q) desc, t.depth asc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- =====================================================================
-- WRITE RPCs
-- (SECURITY INVOKER: the topics policies still decide. These exist for
-- atomicity and validation, never as a way around permissions - a member
-- who calls delete_topic on someone else's page deletes zero rows.)
-- =====================================================================

create or replace function public.reorder_siblings(p_parent_id uuid, p_ordered_ids uuid[])
returns void
language plpgsql set search_path = public
as $$
begin
  update public.topics t
     set position = o.ord - 1
    from unnest(p_ordered_ids) with ordinality as o(id, ord)
   where t.id = o.id
     and t.parent_id is not distinct from p_parent_id;
end;
$$;

create or replace function public.move_topic(p_id uuid, p_new_parent_id uuid, p_position int default null)
returns public.topics
language plpgsql set search_path = public
as $$
declare
  v_row public.topics;
  v_pos int;
begin
  if p_new_parent_id is not null and not public.can_edit(p_new_parent_id) then
    raise exception 'You do not have permission to add pages to that section'
      using errcode = '42501';
  end if;

  if p_position is null then
    select coalesce(max(position) + 1, 0) into v_pos
      from public.topics where parent_id is not distinct from p_new_parent_id;
  else
    v_pos := p_position;
  end if;

  update public.topics
     set parent_id = p_new_parent_id, position = v_pos
   where id = p_id
  returning * into v_row;

  if not found then
    raise exception 'That page does not exist, or you do not own it' using errcode = '42501';
  end if;

  return v_row;
end;
$$;

-- cascade = false deletes a leaf; the FK stops it if children exist.
-- cascade = true deletes the node and its subtree in ONE statement, so
-- the NO ACTION check at end of statement sees a consistent graph.
create or replace function public.delete_topic(p_id uuid, p_cascade boolean default false)
returns int
language plpgsql set search_path = public
as $$
declare
  v_path    text;
  v_deleted int;
begin
  select path into v_path from public.topics where id = p_id;
  if v_path is null then
    raise exception 'That page does not exist' using errcode = 'P0002';
  end if;

  if p_cascade then
    delete from public.topics where path = v_path or path like v_path || '/%';
  else
    delete from public.topics where id = p_id;
  end if;

  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    raise exception 'Nothing was deleted - you must own a page to delete it'
      using errcode = '42501';
  end if;
  return v_deleted;
end;
$$;

create or replace function public.descendant_count(p_id uuid)
returns int
language sql stable set search_path = public
as $$
  select count(*)::int
  from public.topics d
  where d.path like (select path from public.topics where id = p_id) || '/%';
$$;


-- ###################################################################
-- ## 20260831120150_admin.sql
-- ###################################################################

-- =====================================================================
-- 20260831120150_admin.sql
-- Administrator capabilities
-- =====================================================================
--
-- Every function here is SECURITY DEFINER, because each one has to do
-- something an `authenticated` caller genuinely cannot: write a column
-- that no policy exposes, or delete a row from auth.users.
--
-- That makes the FIRST LINE OF EACH BODY the actual access control. A
-- SECURITY DEFINER function without an internal authorisation check is
-- a privilege-escalation endpoint with a friendly name, so the pattern
-- is identical in all four:
--
--     if not public.is_admin() then raise ... 42501; end if;
--
-- and is_admin() itself requires status='active', so a suspended
-- administrator cannot use any of them.
--
-- Two invariants are enforced on top of that, because losing either one
-- leaves the installation unadministrable:
--
--   1. You cannot demote, suspend or delete YOURSELF.
--   2. You cannot remove the LAST remaining administrator.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Shared guard
-- ---------------------------------------------------------------------
create or replace function public.assert_admin_target(p_user_id uuid, p_action text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_role   text;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  if p_user_id = v_caller then
    raise exception 'You cannot % your own account', p_action using errcode = '42501';
  end if;

  select role into v_role from public.profiles where id = p_user_id;
  if v_role is null then
    raise exception 'That account no longer exists' using errcode = 'P0002';
  end if;

  -- Would this action leave the site with no active administrator?
  --
  -- Phrased as "does another active administrator exist", not "are there
  -- more than one" — those differ when the target is a SUSPENDED
  -- administrator. Counting active admins and comparing to 1 refuses to
  -- demote a suspended admin while one active admin remains, which is a
  -- false refusal: the suspended account is not administering anything.
  --
  -- Given the self-check above, the caller is an active administrator and
  -- is never the target, so this can only fire if the self-check is ever
  -- relaxed. It stays as the invariant's own statement of itself.
  if v_role = 'admin' and not exists (
       select 1 from public.profiles
       where role = 'admin' and status = 'active' and id <> p_user_id
     ) then
    raise exception 'This is the last active administrator - promote someone else first'
      using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- admin_set_role(user, 'member' | 'admin')
-- ---------------------------------------------------------------------
create or replace function public.admin_set_role(p_user_id uuid, p_role text)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare v_row public.profiles;
begin
  if p_role not in ('member', 'admin') then
    raise exception 'Unknown role "%"', p_role using errcode = '22023';
  end if;
  perform public.assert_admin_target(p_user_id, 'change the role of');

  perform set_config('app.admin_action', 'on', true);
  update public.profiles set role = p_role where id = p_user_id returning * into v_row;
  perform set_config('app.admin_action', 'off', true);

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- admin_set_status(user, 'active' | 'suspended')
-- ---------------------------------------------------------------------
-- Suspension is the reversible answer and should be the usual one. The
-- account and all of its pages survive untouched; is_active() simply
-- stops returning true, so every write policy declines and the member
-- becomes an ordinary reader. Reactivating restores everything.
-- ---------------------------------------------------------------------
create or replace function public.admin_set_status(p_user_id uuid, p_status text)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare v_row public.profiles;
begin
  if p_status not in ('active', 'suspended') then
    raise exception 'Unknown status "%"', p_status using errcode = '22023';
  end if;

  if p_status = 'suspended' then
    perform public.assert_admin_target(p_user_id, 'suspend');
  else
    -- Reactivating is never destructive, so it needs no last-admin guard.
    if not public.is_admin() then
      raise exception 'Administrator access is required' using errcode = '42501';
    end if;
  end if;

  perform set_config('app.admin_action', 'on', true);
  update public.profiles set status = p_status where id = p_user_id returning * into v_row;
  perform set_config('app.admin_action', 'off', true);

  if v_row.id is null then
    raise exception 'That account no longer exists' using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- admin_delete_user(user) -> json
-- ---------------------------------------------------------------------
-- Deletes the account and TRANSFERS its pages to the acting
-- administrator.
--
-- The alternative - cascading the delete through topics - was rejected:
-- removing a person should not silently destroy documentation other
-- people are reading. A departing author's pages are the organisation's,
-- not theirs. The administrator can delete them afterwards, deliberately,
-- with the usual subtree confirmation.
--
-- Order matters. Pages must be reassigned BEFORE the profile row goes,
-- or topics.owner_id (NOT NULL, no ON DELETE action) blocks the delete.
-- Deleting auth.users cascades to profiles.
-- ---------------------------------------------------------------------
create or replace function public.admin_delete_user(p_user_id uuid)
returns json
language plpgsql security definer set search_path = ''
as $$
declare
  v_caller uuid := (select auth.uid());
  v_email  text;
  v_user   text;
  v_moved  int;
begin
  perform public.assert_admin_target(p_user_id, 'delete');

  select email, username into v_email, v_user from public.profiles where id = p_user_id;

  -- Reassign under the cascade flag so the topics trigger leaves paths,
  -- slugs and updated_at alone: transferring ownership is not an edit,
  -- and it should not bump the timestamp on every page they ever wrote.
  perform set_config('app.topics_cascade', 'on', true);

  update public.topics set owner_id = v_caller where owner_id = p_user_id;
  get diagnostics v_moved = row_count;

  -- created_by and updated_by are ON DELETE SET NULL, so PostgreSQL would
  -- clear them for us. Doing it here, inside the cascade flag, keeps the
  -- topics trigger out of the way entirely - otherwise the referential
  -- UPDATE would restamp updated_by and updated_at on every page the
  -- departing member ever touched, which is not an edit and should not
  -- look like one in the page history.
  update public.topics set created_by = null where created_by = p_user_id;
  update public.topics set updated_by = null where updated_by = p_user_id;

  perform set_config('app.topics_cascade', 'off', true);

  delete from auth.users where id = p_user_id;   -- profiles cascades

  return json_build_object(
    'email', v_email, 'username', v_user, 'pages_transferred', v_moved
  );
end;
$$;

-- ---------------------------------------------------------------------
-- admin_list_users() -> the user table
-- ---------------------------------------------------------------------
-- A function rather than a policy on profiles, because the dashboard
-- needs email and status - exactly the columns that must not be
-- world-readable. The admin check lives inside, and the page counts come
-- from one grouped scan rather than N follow-up queries.
-- ---------------------------------------------------------------------
create or replace function public.admin_list_users()
returns table (
  id uuid, email text, username text, display_name text,
  role text, status text, created_at timestamptz,
  page_count int, public_page_count int
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  return query
    select p.id, p.email, p.username, p.display_name, p.role, p.status, p.created_at,
           coalesce(t.total, 0)::int,
           coalesce(t.shared, 0)::int
    from public.profiles p
    left join (
      select owner_id,
             count(*) as total,
             count(*) filter (where effective_visibility <> 'private') as shared
      from public.topics group by owner_id
    ) t on t.owner_id = p.id
    order by (p.role = 'admin') desc, p.created_at asc;
end;
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
-- The browser holds only the Supabase anon key. That key grants nothing;
-- it identifies the request as the `anon` Postgres role, or
-- `authenticated` once a JWT is attached. Every read and write then
-- passes through the policies below, evaluated inside PostgreSQL. There
-- is no code path in which React decides whether something is allowed.
-- Deleting every permission check from the frontend would change what
-- the UI shows and nothing whatsoever about what the database permits.
--
--
-- FOUR ACTORS
--
--   anonymous     reads anything not effectively private
--   member        the above, plus: creates pages, owns them, edits any
--                 collaborative page, edits and deletes their own
--   suspended     exactly an anonymous reader, while keeping every page
--                 they ever wrote
--   administrator everything, on every row, plus the admin_* functions
--
--
-- WHY effective_visibility AND NOT visibility
--
-- Policies read the materialised column, never the raw one. A page's own
-- setting is only half the answer - a public page inside a private
-- folder is private. Materialising the ancestor rule into one column at
-- write time means every policy stays a single indexed comparison
-- instead of a tree walk on every row of every read.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Table privileges: the coarse gate, before RLS gets a say
-- ---------------------------------------------------------------------
-- Supabase's defaults hand `anon` full DML on new public tables and rely
-- on RLS alone. We tighten that: anon gets SELECT and nothing else, so
-- an anonymous INSERT fails at the privilege layer before a policy is
-- ever consulted. Two independent locks, not one.
revoke all on public.topics          from anon, authenticated;
revoke all on public.profiles        from anon, authenticated;
revoke all on public.topic_redirects from anon, authenticated;
revoke all on public.public_profiles from anon, authenticated;

grant select                   on public.topics          to anon, authenticated;
grant insert, update, delete   on public.topics          to authenticated;
grant select                   on public.topic_redirects to anon, authenticated;
grant select                   on public.public_profiles to anon, authenticated;
grant select, update           on public.profiles        to authenticated;
-- Nobody may write topic_redirects. Its rows come only from the
-- SECURITY DEFINER trigger, which runs as the table owner and so
-- bypasses both grants and policies.

alter table public.topics          enable row level security;
alter table public.profiles        enable row level security;
alter table public.topic_redirects enable row level security;

-- =====================================================================
-- topics — SELECT
-- =====================================================================
-- Three permissive policies, OR'ed together. Split rather than combined
-- into one expression so the anonymous path is a bare column comparison
-- and never calls a function or touches profiles - which is the shape of
-- 99% of the traffic.

create policy "topics: anyone reads what is not private"
  on public.topics for select
  to anon, authenticated
  using (effective_visibility <> 'private');

create policy "topics: owners read their own"
  on public.topics for select
  to authenticated
  using (owner_id = (select auth.uid()));

create policy "topics: admins read everything"
  on public.topics for select
  to authenticated
  using ((select public.is_admin()));

-- =====================================================================
-- topics — INSERT
-- =====================================================================
-- can_edit(parent_id) is the whole rule:
--   parent NULL  -> creating at the shared root; any active member may.
--   otherwise    -> you must own the parent, or the parent must be
--                   collaborative. You cannot drop a page into someone
--                   else's private section.
--
-- owner_id = auth.uid() looks redundant because the BEFORE trigger
-- overwrites owner_id anyway. It is here because a policy that depends
-- on a trigger for its correctness is one refactor away from being
-- wrong, and because WITH CHECK is the layer a reviewer reads.

create policy "topics: members create what they will own"
  on public.topics for insert
  to authenticated
  with check (
    (select public.is_active())
    and owner_id = (select auth.uid())
    and (select public.can_edit(parent_id))
  );

create policy "topics: admins create anywhere"
  on public.topics for insert
  to authenticated
  with check ((select public.is_admin()));

-- =====================================================================
-- topics — UPDATE
-- =====================================================================
-- USING decides which rows you may target; WITH CHECK decides what the
-- row may look like afterwards. Both are needed on every policy here.
--
-- The collaborative policy is the interesting one, and on its own it
-- would be a hole: "any active member may update this row" also permits
-- setting owner_id to yourself, flipping visibility to private, or
-- moving the page into your own section - a takeover wearing an edit's
-- clothing. WITH CHECK cannot express "and don't change those columns",
-- because it cannot see the OLD row.
--
-- topics_before_write() closes it: when the caller is neither the owner
-- nor an administrator, owner_id, visibility, slug, parent_id and
-- position are all reset to their previous values before the row is
-- written. Title, content and summary are what a collaborator can
-- actually change.

create policy "topics: owners update their own"
  on public.topics for update
  to authenticated
  using      (owner_id = (select auth.uid()) and (select public.is_active()))
  with check (owner_id = (select auth.uid()));

create policy "topics: members update collaborative pages"
  on public.topics for update
  to authenticated
  using      (effective_visibility = 'collaborative' and (select public.is_active()))
  with check (effective_visibility = 'collaborative');

create policy "topics: admins update everything"
  on public.topics for update
  to authenticated
  using      ((select public.is_admin()))
  with check ((select public.is_admin()));

-- =====================================================================
-- topics — DELETE
-- =====================================================================
-- Note what is absent: there is no collaborative delete policy.
-- "Anyone can edit" is an invitation to contribute, not permission to
-- destroy. Deletion stays with the owner and administrators.
--
-- A consequence worth knowing: an owner deleting a subtree that contains
-- a page someone else created inside their collaborative folder will
-- find the delete blocked by the foreign key, because the other
-- person's row is invisible to the DELETE and survives it. That is the
-- correct outcome - it fails loudly instead of quietly destroying a
-- contributor's work.

create policy "topics: owners delete their own"
  on public.topics for delete
  to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_active()));

create policy "topics: admins delete anything"
  on public.topics for delete
  to authenticated
  using ((select public.is_admin()));

-- =====================================================================
-- profiles
-- =====================================================================
-- Readable only by its owner and by administrators; the world gets the
-- public_profiles view instead, which carries no email, role or status.
--
-- UPDATE is granted so a member can set their own display name. It is
-- NOT a hole: profiles_guard() rejects any change to role, status, id or
-- email from a request carrying an end-user JWT, so the only field this
-- policy actually opens is display_name.

create policy "profiles: read your own"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy "profiles: admins read all"
  on public.profiles for select
  to authenticated
  using ((select public.is_admin()));

create policy "profiles: edit your own display name"
  on public.profiles for update
  to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT policy: rows come from the signup trigger.
-- No DELETE policy: accounts are removed through admin_delete_user().

-- =====================================================================
-- topic_redirects
-- =====================================================================
-- A redirect is only visible if its TARGET is visible to you. The EXISTS
-- is evaluated with the topics policies applied, so a redirect pointing
-- at a private page simply is not there - rather than resolving to a
-- 404 and confirming that the page exists.

create policy "redirects: visible when the target is"
  on public.topic_redirects for select
  to anon, authenticated
  using (exists (select 1 from public.topics t where t.id = topic_id));

-- =====================================================================
-- Function execution
-- =====================================================================
revoke all on function public.slugify(text)                      from public;
revoke all on function public.is_admin()                         from public;
revoke all on function public.is_active()                        from public;
revoke all on function public.can_edit(uuid)                     from public;
revoke all on function public.get_page(text)                     from public;
revoke all on function public.search_topics(text, int)           from public;
revoke all on function public.reorder_siblings(uuid, uuid[])     from public;
revoke all on function public.move_topic(uuid, uuid, int)        from public;
revoke all on function public.delete_topic(uuid, boolean)        from public;
revoke all on function public.descendant_count(uuid)             from public;
revoke all on function public.assert_admin_target(uuid, text)    from public;
revoke all on function public.admin_set_role(uuid, text)         from public;
revoke all on function public.admin_set_status(uuid, text)       from public;
revoke all on function public.admin_delete_user(uuid)            from public;
revoke all on function public.admin_list_users()                 from public;

grant execute on function public.slugify(text)                   to anon, authenticated;
grant execute on function public.get_page(text)                  to anon, authenticated;
grant execute on function public.search_topics(text, int)        to anon, authenticated;
grant execute on function public.is_admin()                      to anon, authenticated;
grant execute on function public.is_active()                     to anon, authenticated;
grant execute on function public.can_edit(uuid)                  to anon, authenticated;

grant execute on function public.reorder_siblings(uuid, uuid[])  to authenticated;
grant execute on function public.move_topic(uuid, uuid, int)     to authenticated;
grant execute on function public.delete_topic(uuid, boolean)     to authenticated;
grant execute on function public.descendant_count(uuid)          to authenticated;

-- The admin_* functions are SECURITY DEFINER, so this grant is NOT the
-- access control - it only says who may attempt the call. Authorisation
-- is the is_admin() check on the first line of each body. Granting to
-- `authenticated` and checking inside is deliberate: it produces a clean
-- "Administrator access is required" instead of a raw permission error.
grant execute on function public.admin_set_role(uuid, text)      to authenticated;
grant execute on function public.admin_set_status(uuid, text)    to authenticated;
grant execute on function public.admin_delete_user(uuid)         to authenticated;
grant execute on function public.admin_list_users()              to authenticated;


-- ###################################################################
-- ## 20260831120300_indexes.sql
-- ###################################################################

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

