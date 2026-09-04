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
