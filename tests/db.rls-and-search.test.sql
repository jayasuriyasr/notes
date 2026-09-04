\pset pager off
\set ON_ERROR_STOP off

\echo '=== 20b. ADMIN inside one transaction (correct JWT simulation) ==='
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
  select public.is_admin() as am_i_admin, count(*) as visible_rows, count(*) filter (where status='draft') as drafts
  from public.topics;
  insert into public.topics (parent_id, title, content)
    values ((select id from public.topics where path='database'), 'Transactions', '# Transactions')
    returning path, status, created_by, position;
  \echo '--- publish it ---'
  update public.topics set status='published' where path='database/transactions'
    returning path, status, published_at is not null as has_published_at;
commit;

\echo ''
\echo '=== 21. VIEWER inside one transaction: still powerless ==='
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
  select public.is_admin() as am_i_admin, count(*) filter (where status='draft') as drafts_visible from public.topics;
  select public.move_topic(
    (select id from public.topics where path='database/indexing'),
    null) is not null as moved;
rollback;
\echo '--- indexing did NOT move: ---'
select path from public.topics where path like '%indexing%' order by path;

\echo ''
\echo '=== 22. DELETE semantics: parent without cascade must be refused ==='
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
  select public.descendant_count((select id from public.topics where path='system-design/rate-limiter')) as descendants;
  select public.delete_topic((select id from public.topics where path='system-design/rate-limiter'), false);
rollback;

\echo ''
\echo '=== 23. DELETE with cascade: whole subtree, one statement ==='
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
  select public.delete_topic((select id from public.topics where path='system-design/rate-limiter'), true) as rows_deleted;
  select count(*) as remaining_under_rate_limiter from public.topics where path like 'system-design/rate-limiter%';
rollback;

\echo ''
\echo '=== 24. SEARCH: ranking, weighting, safe highlight sentinels ==='
select path, round(rank::numeric, 4) as rank, headline
from public.search_topics('token bucket', 5);

\echo ''
\echo '--- websearch syntax: quoted phrase + exclusion ---'
select path from public.search_topics('"leaky bucket"', 5);
select path from public.search_topics('index -gin', 5);

\echo ''
\echo '=== 25. SEARCH respects RLS (anon cannot find the draft "Redis" page) ==='
begin;
  set local role anon;
  select coalesce(string_agg(path, ', '), '(nothing)') as anon_results from public.search_topics('redis operational dependency', 5);
commit;
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
  select coalesce(string_agg(path, ', '), '(nothing)') as admin_results from public.search_topics('redis operational dependency', 5);
commit;

\echo ''
\echo '=== 26. ts_headline emits NO html (sentinels only) ==='
select headline from public.search_topics('bucket', 3);
