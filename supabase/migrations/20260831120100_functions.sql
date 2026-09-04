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
