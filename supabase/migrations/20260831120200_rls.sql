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
