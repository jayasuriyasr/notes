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
