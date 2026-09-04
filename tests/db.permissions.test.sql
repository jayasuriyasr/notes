\pset pager off
\set ON_ERROR_STOP off

-- =====================================================================
-- db.permissions.test.sql
--
-- The multi-user permission model, exercised against a real PostgreSQL
-- through the anon / authenticated roles, so RLS is genuinely in play.
--
-- Run order:
--   1. tests/local-harness.sql          (fake auth schema + the 3 roles)
--   2. supabase/migrations/*.sql
--   3. THIS FILE up to the "seed" marker  (creates the accounts)
--   4. supabase/seed.sql                  (needs an account to own pages)
--   5. the rest of this file
--
-- Sections:
--   1-2  registration, username de-duplication, the bootstrap promotion
--   A    read matrix: anon / member / admin
--   B    private inheritance - the most-restrictive-ancestor rule
--   C    creation rights: root, someone else's folder, a shared folder
--   D    collaborative editing, and a hostile takeover attempt
--   E    owner rights
--   F    suspension: a soft ban that keeps the member's content
--   G    admin guards: no self-demotion, no removing the last admin
--   H    deleting an account transfers its pages
--   I    escalation attempts through the profiles table
--   J    public_profiles exposes usernames and nothing else
--   K    can_edit() agrees with what the database actually permits
--
-- This file MUTATES the tree and the accounts. Reset before re-running.
-- =====================================================================

-- The four accounts this file works with. Defined once, here, because
-- every section below refers to them.
\set A '\'11111111-1111-1111-1111-111111111111\''
\set L '\'22222222-2222-2222-2222-222222222222\''
\set B '\'33333333-3333-3333-3333-333333333333\''
\set C '\'44444444-4444-4444-4444-444444444444\''

-- The same ids again, unquoted, for the :'NAME' form used from section A on.
\set ADM 11111111-1111-1111-1111-111111111111
\set ALI 22222222-2222-2222-2222-222222222222
\set BOB 33333333-3333-3333-3333-333333333333
\set CAR 44444444-4444-4444-4444-444444444444

\echo '=== 1. Registration: trigger creates profiles, always member/active ==='
insert into auth.users (id, email, raw_user_meta_data) values
  (:A, 'admin@example.com', '{"display_name":"Ada"}'),
  (:L, 'alice@example.com', '{}'),
  (:B, 'bob@example.com',   '{}'),
  (:C, 'carol@example.com', '{}');
-- same local part on a different domain, to exercise username de-duplication
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'alice@other.example');
-- a 1-character local part, which is shorter than the username CHECK allows
insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'j@example.com');
select email, username, display_name, role, status from public.profiles order by created_at;

\echo ''
\echo '=== 2. Promote one account by hand (the documented bootstrap) ==='
update public.profiles set role = 'admin' where id = :A;
select username, role from public.profiles where id = :A;

\echo '════ A. READ MATRIX ═══════════════════════════════════════════'
begin; set local role anon;
  select 'anon        ' as actor, count(*) as visible,
         count(*) filter (where effective_visibility='private') as private_visible
  from public.topics;
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  select 'alice(member)' , count(*), count(*) filter (where effective_visibility='private') from public.topics;
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select 'admin       ' , count(*), count(*) filter (where effective_visibility='private') from public.topics;
commit;

\echo ''
\echo '-- anon requesting the private page by URL:'
begin; set local role anon;
  select coalesce((get_page('system-design/caching/redis')::jsonb->'topic')::text,'NULL') as anon_gets_redis;
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select coalesce(get_page('system-design/caching/redis')::jsonb->'topic'->>'title','NULL') as admin_gets_redis;
commit;

\echo ''
\echo '════ B. PRIVATE INHERITANCE (most restrictive ancestor wins) ══'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  update public.topics set visibility='private' where path='system-design/caching';
commit;
select path, visibility, effective_visibility from public.topics
where path like 'system-design/caching%' order by path;
\echo '-- what anon can now see under that branch:'
begin; set local role anon;
  select coalesce(string_agg(path,', ' order by path),'(nothing)') as anon_sees
  from public.topics where path like 'system-design/caching%';
commit;

\echo ''
\echo '-- revert: the subtree returns, but Redis stays private on its own merit'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  update public.topics set visibility='public' where path='system-design/caching';
commit;
select path, visibility, effective_visibility from public.topics
where path like 'system-design/caching%' order by path;

\echo ''
\echo '════ C. CREATION RIGHTS ═══════════════════════════════════════'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- alice creates at the shared root:'
  insert into public.topics (title) values ('Alice Notes')
    returning path, visibility, effective_visibility,
              (select username from public.profiles where id=owner_id) as owner;
commit;

begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- alice tries to add a page inside the admin''s PUBLIC folder (must fail):'
  insert into public.topics (parent_id, title)
    values ((select id from public.topics where path='database'), 'Sneaky');
rollback;

begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- alice adds a page inside a COLLABORATIVE folder (must succeed):'
  insert into public.topics (parent_id, title)
    values ((select id from public.topics where path='system-design/caching/cache-eviction'),
            'LRU In Practice')
    returning path, effective_visibility,
              (select username from public.profiles where id=owner_id) as owner;
commit;

\echo ''
\echo '════ D. COLLABORATIVE EDIT — AND THE TAKEOVER ATTEMPT ═════════'
begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  \echo '-- bob edits title + content of a collaborative page (allowed):'
  update public.topics
     set title = 'Cache Eviction (edited by bob)', content = 'rewritten'
   where path = 'system-design/caching/cache-eviction'
  returning title, (select username from public.profiles where id=updated_by) as last_editor;
commit;

begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  \echo '-- bob attempts a hostile takeover in one UPDATE:'
  update public.topics
     set owner_id   = :'BOB',
         visibility = 'private',
         slug       = 'bobs-page',
         parent_id  = null
   where path = 'system-design/caching/cache-eviction';
commit;
select 'after bob''s attempt:' as result, path, visibility,
       (select username from public.profiles where id=owner_id) as still_owned_by
from public.topics where title like 'Cache Eviction%';

begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  \echo '-- bob tries to DELETE the collaborative page (no delete policy):'
  select public.delete_topic((select id from public.topics where title like 'Cache Eviction%'), true);
rollback;

\echo ''
\echo '════ E. OWNER RIGHTS ══════════════════════════════════════════'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- alice edits her own page:'
  update public.topics set content='mine' where path='alice-notes' returning path, char_length(content);
  \echo '-- alice tries to edit the admin''s public page:'
  update public.topics set title='hijacked' where path='database';
  \echo '   ^ rows affected above; and the title is still:'
commit;
select title from public.topics where path='database';

\echo '-- bob edits text only (must still work):'
begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  update public.topics set title='Cache Eviction', content='ok' where path='system-design/caching/cache-eviction'
  returning title;
commit;
\echo '-- bob resends an UNCHANGED visibility alongside a text edit (must work):'
begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  update public.topics set content='ok2', visibility='collaborative', slug='cache-eviction'
   where path='system-design/caching/cache-eviction' returning title;
commit;
\echo '-- bob tries to rename it (must be refused, with a readable message):'
begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  update public.topics set slug='bobs-page' where path='system-design/caching/cache-eviction';
rollback;
\echo '-- bob tries to make it private:'
begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  update public.topics set visibility='private' where path='system-design/caching/cache-eviction';
rollback;
\echo '-- bob tries to seize ownership:'
begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  update public.topics set owner_id=:'BOB' where path='system-design/caching/cache-eviction';
rollback;

\echo '════ F. SUSPENSION ════════════════════════════════════════════'
begin; set local role authenticated; set local request.jwt.claim.sub = :'CAR';
  insert into public.topics (title, visibility) values ('Carol Draft','public') returning path;
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select status from public.admin_set_status(:'CAR', 'suspended');
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'CAR';
  select 'suspended carol: is_active=' || public.is_active()::text
      || '  can still read ' || (select count(*) from public.topics)::text || ' pages' as state;
  \echo '-- ...but cannot create:'
  insert into public.topics (title) values ('Should Fail');
  \echo '-- ...and cannot edit her own page:'
  update public.topics set title='changed' where path='carol-draft';
rollback;
select 'carol''s page survived suspension: ' || title as check from public.topics where path='carol-draft';
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select 'reactivated -> ' || status from public.admin_set_status(:'CAR','active');
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'CAR';
  update public.topics set title='Carol Draft (back)' where path='carol-draft' returning title;
commit;

\echo ''
\echo '════ G. ADMIN GUARDS ══════════════════════════════════════════'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  \echo '-- admin demotes THEMSELF:'
  select public.admin_set_role(:'ADM','member');
rollback;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  \echo '-- admin deletes THEMSELF:'
  select public.admin_delete_user(:'ADM');
rollback;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- a member promotes themself:'
  select public.admin_set_role(:'ALI','admin');
rollback;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- a member lists users:'
  select count(*) from public.admin_list_users();
rollback;

\echo ''
\echo '-- promote alice properly, then let alice demote the original admin:'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select username, role from public.admin_set_role(:'ALI','admin');
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  select username, role from public.admin_set_role(:'ADM','member');
commit;
\echo '-- now alice is the LAST admin; bob is a member. alice tries to demote herself:'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  select public.admin_set_role(:'ALI','member');
rollback;
\echo '-- restore the original admin:'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  select username, role from public.admin_set_role(:'ADM','admin');
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select username, role from public.admin_set_role(:'ALI','member');
commit;

\echo ''
\echo '════ H. DELETING A USER TRANSFERS THEIR PAGES ═════════════════'
begin; set local role authenticated; set local request.jwt.claim.sub = :'BOB';
  insert into public.topics (title, visibility) values ('Bob Guide','public');
  insert into public.topics (title, visibility) values ('Bob Notes','private');
commit;
select 'bob owns: ' || count(*)::text as before from public.topics
 where owner_id = :'BOB'::uuid;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select public.admin_delete_user(:'BOB') as result;
commit;
select 'bob''s profile rows remaining: ' || count(*)::text from public.profiles where id = :'BOB'::uuid;
select 'his pages now owned by: ' || (select username from public.profiles p where p.id=t.owner_id)
       || '  (' || count(*)::text || ' pages, still readable)'
from public.topics t where t.title like 'Bob %' group by t.owner_id;

\echo ''
\echo '════ I. ESCALATION VIA THE PROFILES TABLE ═════════════════════'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- alice sets her own role:'
  update public.profiles set role='admin' where id = :'ALI';
  \echo '-- alice un-suspends herself preemptively / changes status:'
  update public.profiles set status='active' where id = :'ALI';
  \echo '-- alice changes her email:'
  update public.profiles set email='admin@example.com' where id = :'ALI';
  \echo '-- alice sets her display name (the one thing she MAY do):'
  update public.profiles set display_name='Alice A.' where id = :'ALI' returning username, display_name, role;
commit;

\echo ''
\echo '-- alice reading other people''s profiles:'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  select 'profiles rows alice can see: ' || count(*)::text from public.profiles;
commit;

\echo ''
\echo '════ J. public_profiles LEAKS NOTHING ═════════════════════════'
begin; set local role anon;
  select 'anon reads usernames: ' || string_agg(username, ', ' order by username) from public.public_profiles;
  \echo '-- anon reading the real profiles table:'
  select count(*) as anon_profile_rows from public.profiles;
commit;
select 'public_profiles columns: ' || string_agg(column_name, ', ' order by ordinal_position)
from information_schema.columns where table_name='public_profiles';

\echo '════ H (retry). DELETING A USER TRANSFERS THEIR PAGES ═════════'
select 'before — bob owns ' || count(*)::text || ' pages, and is created_by on '
       || (select count(*) from public.topics where created_by = :'BOB'::uuid)::text as state
from public.topics where owner_id = :'BOB'::uuid;
select 'timestamps before: ' || string_agg(to_char(updated_at,'HH24:MI:SS.MS'), ', ' order by title) as t
from public.topics where title like 'Bob %';

begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select public.admin_delete_user(:'BOB') as result;
commit;

select 'bob profile rows: ' || count(*)::text as after_delete from public.profiles where id = :'BOB'::uuid;
select 'bob auth rows:    ' || count(*)::text from auth.users where id = :'BOB'::uuid;
select 'pages now owned by ' || (select username from public.profiles p where p.id=t.owner_id)
       || ', created_by = ' || coalesce((select username from public.profiles p where p.id=t.created_by),'(cleared)')
       || ', ' || count(*)::text || ' pages' as outcome
from public.topics t where t.title like 'Bob %' group by t.owner_id, t.created_by;
select 'timestamps after:  ' || string_agg(to_char(updated_at,'HH24:MI:SS.MS'), ', ' order by title)
       || '   <- unchanged means ownership transfer did not fake an edit' as t
from public.topics where title like 'Bob %';
\echo '-- the transferred pages are still readable by the public:'
begin; set local role anon;
  select 'anon sees: ' || coalesce(string_agg(title, ', '),'(none)') from public.topics where title like 'Bob %';
commit;

\echo ''
\echo '════ I (retry). PROFILE ESCALATION, ONE TRANSACTION EACH ══════'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  update public.profiles set role='admin' where id = :'ALI';
rollback;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  update public.profiles set status='suspended' where id = :'ALI';
rollback;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  update public.profiles set email='admin@example.com' where id = :'ALI';
rollback;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- the one thing alice MAY change:'
  update public.profiles set display_name='Alice A.' where id = :'ALI'
    returning username, display_name, role, status;
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  \echo '-- alice edits SOMEONE ELSE''s profile:'
  update public.profiles set display_name='pwned' where id = :'ADM';
  \echo '   ^ rows affected';
commit;

\echo ''
\echo '════ K. can_edit() agrees with what the database actually allows ══'
select t.path, t.effective_visibility,
       (select username from public.profiles p where p.id=t.owner_id) as owner
from public.topics t where t.path in
 ('database','system-design/caching/cache-eviction','system-design/caching/redis','alice-notes')
order by t.path;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ALI';
  select 'alice can_edit: '
      || string_agg(path || '=' || public.can_edit(id)::text, '  ' order by path)
  from public.topics
  where path in ('database','system-design/caching/cache-eviction','system-design/caching/redis','alice-notes');
commit;
begin; set local role anon;
  select 'anon can_edit collaborative page: ' ||
    public.can_edit((select id from public.topics where path='system-design/caching/cache-eviction'))::text;
commit;


\echo ''
\echo '════ L. THE LAST-ADMINISTRATOR GUARD, PRECISELY ═══════════════'
\echo '-- A suspended administrator is not administering anything, so demoting'
\echo '-- them must be allowed even while only one ACTIVE admin remains.'
\set A2 77777777-7777-7777-7777-777777777777
insert into auth.users (id,email) values (:'A2','second-admin@example.com');
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select username, role from public.admin_set_role(:'A2','admin');
commit;
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select username, status from public.admin_set_status(:'A2','suspended');
commit;
\echo '-- one active admin + one suspended admin; demote the suspended one:'
begin; set local role authenticated; set local request.jwt.claim.sub = :'ADM';
  select username, role from public.admin_set_role(:'A2','member');
commit;
select username, role, status from public.profiles where id = :'A2';
