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
