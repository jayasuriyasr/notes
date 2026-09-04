-- =====================================================================
-- seed.sql - sample documentation tree
--
-- RUN THIS *AFTER* CREATING YOUR FIRST ACCOUNT. Every page needs an
-- owner, so the script adopts the oldest administrator (or, failing
-- that, the oldest account) and gives them the sample pages. Register
-- at /register first, promote yourself with
--
--     update public.profiles set role = 'admin' where email = 'you@example.com';
--
-- then run this file.
--
-- Note what is never set: path, depth and effective_visibility are all
-- derived by trigger, and most rows omit slug too, to exercise
-- auto-slugification. The tree demonstrates all three visibility
-- levels, including a private page and a collaborative one.
-- =====================================================================

do $do$
declare
  sd uuid; rl uuid; lb uuid; ca uuid; db uuid; ix uuid;
  v_owner uuid;
begin

select id into v_owner from public.profiles
 where role = 'admin' order by created_at limit 1;

if v_owner is null then
  select id into v_owner from public.profiles order by created_at limit 1;
end if;

if v_owner is null then
  raise exception using
    errcode = 'P0002',
    message = 'No accounts exist yet, so the sample pages would have no owner.',
    hint    = 'Register an account in the app first, then run seed.sql again.';
end if;

-- ============ System Design ==========================================
insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content)
values (null, v_owner, 'System Design', 'public', 0,
  'Foundational building blocks for designing large-scale systems.',
$md$
# System Design

This section collects the recurring building blocks that show up in
almost every large-scale system: limiting traffic, spreading it, and
avoiding work you have already done.

## How to read this section

Each page follows the same shape:

1. **What problem it solves** — the failure mode you are avoiding.
2. **How it works** — the mechanism, with a worked example.
3. **Trade-offs** — what it costs you.

> Design is the art of choosing which problems you are willing to have.

| Topic | Solves | Typical cost |
| --- | --- | --- |
| Rate limiting | Abuse, thundering herds | Added latency, state |
| Load balancing | Single-node capacity | An extra hop |
| Caching | Repeated expensive work | Staleness |
$md$)
returning id into sd;

-- ---- Rate Limiter --------------------------------------------------
insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content)
values (sd, v_owner, 'Rate Limiter', 'public', 0,
  'How to control the number of requests a client may make in a window.',
$md$
# Rate Limiter

A **rate limiter** controls how many requests a client can make in a
given period. It is the cheapest defence you have against a runaway
retry loop, a scraper, or a customer whose cron job fires every second.

## Where it lives

Rate limiting can sit in three places, and the choice matters more than
the algorithm:

- **Client side** — polite, trivially bypassed. Useful only for UX.
- **Edge / gateway** — stops traffic before it costs you anything.
- **Service side** — the only place that sees real business context.

## Choosing a response

When a caller exceeds the limit, return `429 Too Many Requests` together
with a `Retry-After` header. Silently dropping the request is the single
most common mistake: the client cannot distinguish it from a network
failure, so it retries *harder*.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 3
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
```

The algorithms are covered in the child pages.
$md$)
returning id into rl;

insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content) values
(rl, v_owner, 'Token Bucket', 'public', 0,
 'A bucket refills at a steady rate; each request spends one token.',
$md$
# Token Bucket

The token bucket algorithm maintains a bucket of tokens. Tokens are
added at a fixed rate up to a maximum capacity, and every request must
spend one. If the bucket is empty, the request is rejected.

## Why it is the default choice

Token bucket is the algorithm most systems should reach for first,
because it allows **bursts** while still bounding the long-run average.
A user who has been quiet for a minute has a full bucket and can fire a
short burst — which is almost always what you actually want.

```js
const bucket = {
  capacity: 10,      // maximum tokens held
  tokens: 10,        // tokens available right now
  refillPerSecond: 2,
  lastRefill: Date.now()
};

function allow(bucket, cost = 1) {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;

  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + elapsed * bucket.refillPerSecond
  );
  bucket.lastRefill = now;

  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}
```

## Properties

| Property | Value |
| --- | --- |
| Burst allowed | Up to `capacity` |
| Long-run rate | `refillPerSecond` |
| Memory per client | 2 numbers |
| Distributed? | Needs shared state |

> **Note:** the refill is computed lazily, on read. There is no timer,
> no background job, and no cost for idle clients — which is what makes
> this cheap enough to run per-user at scale.

Compare with [Sliding Window](/system-design/rate-limiter/sliding-window),
which trades burst tolerance for a smoother rate.
$md$),
(rl, v_owner, 'Sliding Window', 'public', 1,
 'Counts requests in a moving time window rather than a fixed one.',
$md$
# Sliding Window

A fixed window counter is simple — `requests_in_current_minute < limit` —
but it has a nasty edge: a client can send `limit` requests at 11:59:59
and another `limit` at 12:00:00, doubling the intended rate across the
boundary.

The **sliding window** fixes this by weighting the previous window:

```python
def allow(previous_count, current_count, limit, elapsed_ratio):
    estimated = previous_count * (1 - elapsed_ratio) + current_count
    return estimated < limit
```

## Trade-offs

- *More accurate* than a fixed window at boundaries.
- *Cheaper* than a true log of timestamps — still `O(1)` memory.
- *Approximate*: it assumes the previous window's traffic was uniform.

For an exact answer you need a sliding window **log**, which stores every
timestamp and costs `O(n)` memory per client. Almost nobody needs that.
$md$),
(rl, v_owner, 'Leaky Bucket', 'public', 2,
 'Requests queue and drain at a constant rate, smoothing all bursts.',
$md$
# Leaky Bucket

The leaky bucket models requests as water poured into a bucket with a
hole in the bottom. Water leaks out at a **constant** rate; if you pour
faster than it leaks, the bucket overflows and requests are dropped.

The defining difference from [Token Bucket](/system-design/rate-limiter/token-bucket):

- Token bucket **permits bursts** up to the bucket capacity.
- Leaky bucket **eliminates bursts** — output is perfectly smooth.

That makes leaky bucket the right choice when the thing downstream
cannot absorb a spike at all: a legacy system, a serial device, a
third-party API with a hard per-second ceiling.

```text
     requests in (bursty)
            |
            v
        [ queue ]
            |
            v  constant rate
     requests out (smooth)
```
$md$);

-- ---- Load Balancer -------------------------------------------------
insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content)
values (sd, v_owner, 'Load Balancer', 'public', 1,
  'Distributing requests across a pool of healthy backends.',
$md$
# Load Balancer

A load balancer spreads incoming requests across a pool of backends so
that no single instance becomes the bottleneck, and so that losing an
instance is a non-event rather than an outage.

The two jobs are separable, and confusing them causes most load-balancer
incidents:

1. **Distribution** — which backend gets this request?
2. **Health** — which backends are eligible at all?
$md$)
returning id into lb;

insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content) values
(lb, v_owner, 'Algorithms', 'public', 0,
 'Round robin, least connections, and consistent hashing compared.',
$md$
# Balancing Algorithms

| Algorithm | Picks | Good for | Weakness |
| --- | --- | --- | --- |
| Round robin | Next in list | Uniform, stateless work | Ignores real load |
| Weighted RR | Next, by capacity | Mixed instance sizes | Static weights |
| Least connections | Fewest in-flight | Variable request cost | Needs live state |
| Consistent hashing | Hash of a key | Cache affinity | Hot keys |

## Consistent hashing in one paragraph

Map both servers and keys onto a ring of hash values, and send each key
clockwise to the first server it meets. Adding or removing one server
only moves the keys between it and its neighbour — roughly `1/n` of the
keyspace — instead of remapping everything the way `hash(key) % n` does.

*Virtual nodes* (placing each server at many ring positions) are what
make the distribution actually even in practice.
$md$),
(lb, v_owner, 'Health Checks', 'public', 1,
 'Active and passive probes, and why the two must disagree carefully.',
$md$
# Health Checks

## Active checks

The balancer polls each backend on an interval:

```yaml
healthcheck:
  path: /healthz
  interval: 5s
  timeout: 2s
  unhealthy_threshold: 3
  healthy_threshold: 2
```

The thresholds are not decoration. A single failed probe should never
eject a backend — that turns one slow GC pause into a capacity event.

## Passive checks

The balancer watches *real* traffic and ejects a backend that starts
returning errors. Faster to react, but it requires that some real users
already hit the failure.

> **The failure mode nobody plans for:** a health check that is *too*
> thorough. If `/healthz` verifies the database, a database blip marks
> every backend unhealthy simultaneously and the balancer removes your
> entire fleet. Liveness checks should test the process; readiness
> checks test dependencies — and the balancer should be told which is
> which.
$md$);

-- ---- Caching -------------------------------------------------------
insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content)
values (sd, v_owner, 'Caching', 'public', 2,
  'Trading freshness for speed, and the invalidation bill that follows.',
$md$
# Caching

Caching is the practice of not doing work you have already done. It is
the highest-leverage optimisation available and the one that generates
the most subtle bugs, because a cache is a *second copy of the truth*.

## The only two hard questions

1. **When does an entry become wrong?**
2. **How do you find out?**

Everything else — eviction policy, key design, tiering — is detail.
$md$)
returning id into ca;

insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content) values
(ca, v_owner, 'Cache Eviction', 'collaborative', 0,
 'LRU, LFU, and TTL: choosing what to throw away.',
$md$
# Cache Eviction

A cache is finite, so something must go. The policy you choose should
match how your access pattern actually behaves.

- **LRU** (least recently used) — assumes recency predicts reuse. Right
  most of the time; pathological under a full scan, which evicts your
  entire working set.
- **LFU** (least frequently used) — assumes popularity persists. Better
  under scans; needs decay or yesterday's hits pin the cache forever.
- **TTL** — not really eviction, but *expiry*. The only policy that
  bounds staleness rather than memory.

Most production caches use TTL for correctness and LRU for capacity, at
the same time, because they answer different questions.

```sql
-- The database-side equivalent: let Postgres cache, and keep the
-- working set small enough to fit.
explain (analyze, buffers)
select id, title from topics where path = 'system-design/caching';
```
$md$),
(ca, v_owner, 'Redis', 'private', 1,
 'When an external cache is worth its operational weight.',
$md$
# Redis

*(This page is **private**. Anonymous visitors get a 404 for it; its
owner and administrators see it normally. That difference is enforced by
Row Level Security in PostgreSQL, not by the user interface — try
fetching it with curl and the anon key.)*

Reach for Redis when you have demonstrated that:

- the same expensive result is requested by **many** processes, and
- an in-process cache cannot be shared or would be too large, and
- the staleness window is acceptable.

If you cannot state all three, you are adding an operational dependency
to solve a problem you have not measured.
$md$);

-- ============ Database ===============================================
insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content)
values (null, v_owner, 'Database', 'public', 1,
  'How relational databases store, find and protect your data.',
$md$
# Database

Notes on the parts of a relational database that determine whether your
queries take a microsecond or a minute.
$md$)
returning id into db;

insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content)
values (db, v_owner, 'Indexing', 'public', 0,
  'What an index is, when the planner will use one, and when it will not.',
$md$
# Indexing

An index is a redundant, ordered copy of some of your data that exists
so the planner can avoid reading the rest.

## The costs nobody budgets for

Every index must be updated by every `INSERT`, `UPDATE` and `DELETE` that
touches its columns, occupies disk, and enlarges every backup. An unused
index is not free — it is a permanent tax paid for nothing.

Find them:

```sql
select relname, indexrelname, idx_scan
from pg_stat_user_indexes
where idx_scan = 0
order by pg_relation_size(indexrelid) desc;
```

## When an index will *not* be used

- The predicate is not *sargable*: `where lower(email) = $1` cannot use
  an index on `email` — it needs one on `lower(email)`.
- `LIKE 'prefix%'` on a column in a non-C collation, unless the index
  was built with `text_pattern_ops`.
- The planner estimates it would read most of the table anyway.
$md$)
returning id into ix;

insert into public.topics (parent_id, owner_id, title, visibility, position, excerpt, content) values
(ix, v_owner, 'B-Tree', 'public', 0,
 'The default index type and the shape of nearly every lookup you make.',
$md$
# B-Tree

The B-tree is PostgreSQL's default index and the right answer for
roughly ninety percent of indexes you will ever create.

## Shape

A balanced tree whose leaves hold sorted keys plus a pointer to the heap
tuple. Depth grows logarithmically, so a table of ten rows and a table of
ten million differ by a handful of page reads.

```text
              [ m ]
             /     \
        [ d g ]   [ q t ]
        /  |  \    /  |  \
      ...leaf pages, doubly linked...
```

Because the leaves are **linked and sorted**, one B-tree serves:

- equality — `= $1`
- ranges — `between`, `<`, `>`
- prefix matches — `like 'abc%'` *(in a C collation, or with `text_pattern_ops`)*
- `order by` — no sort node needed
- `min()` / `max()` — read one end

## Composite key ordering

An index on `(a, b)` can serve `where a = 1`, `where a = 1 and b = 2`
and `order by a, b`. It **cannot** serve `where b = 2` alone — the
leading column is the only entry point. This is the single most common
indexing mistake.
$md$),
(ix, v_owner, 'GIN', 'public', 1,
 'The inverted index behind full-text search, JSONB and array containment.',
$md$
# GIN

**G**eneralized **IN**verted index. Where a B-tree maps *one row* to
*one key*, GIN maps *one key* to *many rows* — which is exactly the
shape you need when a single value contains many searchable items.

Used for:

- `tsvector` — full-text search
- `jsonb` — containment (`@>`)
- arrays — overlap and containment

```sql
create index topics_search_idx
  on public.topics using gin (search_vector);

select title, ts_rank(search_vector, q)
from topics, websearch_to_tsquery('english', 'token bucket') q
where search_vector @@ q
order by 2 desc;
```

GIN is slower to build and to update than a B-tree, and considerably
faster to query. That trade is correct for a documentation table, which
is written a few times a day and read constantly.
$md$);

end
$do$;
