\pset pager off
\echo '=== 1. Paths and depths materialised correctly ==='
select lpad('', (depth-1)*2) || title as tree, path, depth, status
from public.topics order by path;

\echo ''
\echo '=== 2. get_page for a deep page (topic + breadcrumbs + children) ==='
select jsonb_pretty(
  jsonb_set(get_page('system-design/rate-limiter')::jsonb,
            '{topic,content}', '"<omitted>"')
);

\echo ''
\echo '=== 3. Breadcrumbs use the unique path index (no seq scan, no recursion) ==='
explain (costs off)
select b.title, b.path from public.topics b
where b.path in ('system-design','system-design/rate-limiter','system-design/rate-limiter/token-bucket');

\echo ''
\echo '=== 4. Public page lookup plan ==='
explain (costs off)
select id, title, content from public.topics where path = 'system-design/rate-limiter' and status = 'published';

\echo ''
\echo '=== 5. Subtree prefix scan uses the text_pattern_ops index ==='
set enable_seqscan = off;
explain (costs off) select count(*) from public.topics where path like 'system-design/%';
reset enable_seqscan;
