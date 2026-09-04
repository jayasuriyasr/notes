\pset pager off
\set ON_ERROR_STOP off

\echo '=== 6. RENAME: change slug of a mid-tree node, descendants must follow ==='
update public.topics set slug = 'throttling' where path = 'system-design/rate-limiter';
select path, depth from public.topics where path like 'system-design/throttling%' order by path;
\echo '--- redirects recorded for the node AND every descendant ---'
select old_path, (select path from public.topics t where t.id = r.topic_id) as now_at
from public.topic_redirects r order by old_path;

\echo ''
\echo '=== 7. MOVE: token-bucket -> new root "distributed-systems" (the §18 scenario) ==='
insert into public.topics (parent_id, title, status) values (null, 'Distributed Systems', 'published');
select public.move_topic(
  (select id from public.topics where path = 'system-design/throttling/token-bucket'),
  (select id from public.topics where path = 'distributed-systems')
) is not null as moved;
select path from public.topics where path like 'distributed-systems%' order by path;
\echo '--- old URL still resolves via redirect ---'
select old_path, (select path from public.topics t where t.id = r.topic_id) as now_at
from public.topic_redirects r where old_path like '%token-bucket' order by old_path;

\echo ''
\echo '=== 8. DEEP MOVE: move a 2-level subtree, grandchildren must be correct ==='
select public.move_topic(
  (select id from public.topics where path = 'system-design/throttling'),
  (select id from public.topics where path = 'database/indexing')
) is not null as moved;
select path, depth from public.topics where path like 'database/%' order by path;

\echo ''
\echo '=== 9. CYCLE: move an ancestor beneath its own descendant (must fail) ==='
select public.move_topic(
  (select id from public.topics where path = 'database'),
  (select id from public.topics where path = 'database/indexing/throttling')
);

\echo ''
\echo '=== 10. SELF-PARENT (must fail) ==='
update public.topics set parent_id = id where path = 'database';

\echo ''
\echo '=== 11. DUPLICATE SIBLING SLUG, explicitly typed (must fail) ==='
insert into public.topics (parent_id, title, slug)
values ((select id from public.topics where path='system-design'), 'Another Caching Page', 'caching');

\echo ''
\echo '=== 12. DUPLICATE TITLE, auto-slug (must silently dedupe) ==='
insert into public.topics (parent_id, title)
values ((select id from public.topics where path='system-design'), 'Caching');
select path from public.topics where path like 'system-design/caching%' order by path;

\echo ''
\echo '=== 13. RESERVED ROOT SLUG (must fail), but fine when nested ==='
insert into public.topics (parent_id, title, slug) values (null, 'Admin', 'admin');
insert into public.topics (parent_id, title, slug)
values ((select id from public.topics where path='database'), 'Admin', 'admin');
select path from public.topics where slug = 'admin';

\echo ''
\echo '=== 14. BAD SLUG FORMAT (must fail) ==='
insert into public.topics (parent_id, title, slug) values (null, 'Bad', 'Not A Slug!');

\echo ''
\echo '=== 15. SLUGIFY normalises unicode + punctuation ==='
select public.slugify('Cache Éviction: LRU / LFU  &  TTL!') as slugified;
