# Markdown Documentation Platform — Architecture

**Stack:** React 19 (Vite SPA) · Tailwind CSS v4 · Supabase (PostgreSQL 15+/17, Auth, RLS) · Vercel

**Priorities, in the order used to break every tie:**
Simplicity → Security → Query performance → User experience → Scalability

Every significant decision below states what was chosen, what was rejected, and why.
Claims about behaviour are not aspirational: the database layer was exercised against a
real PostgreSQL 16 instance and the UI against headless Chromium. Results are in §23.

---

## 1. High-level architecture

Three tiers, one security boundary.

```
Browser (React SPA)  ──►  Supabase PostgREST  ──►  PostgreSQL
                              + GoTrue (Auth)         └── RLS policies  ◄── THE boundary
```

The application has **no backend of its own**. That is the central architectural choice,
and it is defensible only because of a specific property of this problem: every
operation in the system is expressible as *"may this identity touch this row?"* — which
is exactly the question Row Level Security answers, inside the database, where the data
is.

A Node/Express tier would add a deployment, a cold start, a network hop per read, and a
second copy of the authorization rules that could drift from the first. It would buy
nothing here. The moment a requirement appears that RLS genuinely cannot express —
sending invitation emails, importing from GitHub, calling a paid API with a secret key —
*that one operation* becomes a Supabase Edge Function and everything else stays as it is.

### Request paths

| Path | Requests to the database |
|---|---|
| Cold visit to a documentation page | 2 — navigation tree + `get_page()` |
| Any subsequent page in the session | **1** — `get_page()` only (tree is cached) |
| Back button / revisit within 5 min | **0** — served from the React Query cache |
| Search keystroke (debounced 180 ms) | 1 — `search_topics()` |
| A URL that has moved | 2 — the miss, then the redirect lookup |

Verified in the browser: navigating between two pages issued exactly one network
request (§23, test 31).

---

## 2. Architecture diagram

```
┌───────────────────────────────────────────────────────────────────────────┐
│                                 BROWSER                                   │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                        React 19 SPA (Vite build)                    │  │
│  │                                                                     │  │
│  │  Router (splat `/*`)      React Query cache      Auth context       │  │
│  │        │                        │                     │             │  │
│  │        ▼                        ▼                     ▼             │  │
│  │  ┌───────────┐  ┌────────────────────────┐  ┌──────────────────┐    │  │
│  │  │ Public UI │  │  services/topics.js    │  │  Admin UI        │    │  │
│  │  │ sidebar   │  │  ── the ONLY module    │  │  tree · editor   │    │  │
│  │  │ crumbs    │◄─┤     that talks to      ├─►│  move · delete   │    │  │
│  │  │ TOC       │  │     Supabase           │  │  (lazy-loaded)   │    │  │
│  │  │ search    │  └────────────┬───────────┘  └──────────────────┘    │  │
│  │  └───────────┘               │                                      │  │
│  │  ┌──────────────────────────────────────────────────────────────┐   │  │
│  │  │ MarkdownRenderer: remark-gfm → rehype-slug → highlight →      │  │  │
│  │  │                   rehype-sanitize (LAST)                      │  │  │
│  │  └──────────────────────────────────────────────────────────────┘   │  │
│  └────────────────────────────────┬────────────────────────────────────┘  │
└───────────────────────────────────┼───────────────────────────────────────┘
                                    │ HTTPS · anon key + (optional) user JWT
                    ┌───────────────┴────────────────┐
                    ▼                                ▼
┌───────────────────────────────┐   ┌───────────────────────────────────────┐
│      VERCEL EDGE / CDN        │   │              SUPABASE                 │
│                               │   │                                       │
│  static assets, immutable     │   │  ┌─────────────┐   ┌──────────────┐   │
│  SPA fallback → index.html    │   │  │   GoTrue    │   │  PostgREST   │   │
│  security headers + CSP       │   │  │   (Auth)    │   │  (REST/RPC)  │   │
│  sitemap.xml + robots.txt     │   │  └──────┬──────┘   └──────┬───────┘   │
│  (generated at build time)    │   │         │ issues JWT      │           │
└───────────────────────────────┘   │         └────────┬────────┘           │
                                    │                  ▼                    │
                                    │  ╔══════════════════════════════════╗ │
                                    │  ║          PostgreSQL              ║ │
                                    │  ║                                  ║ │
                                    │  ║  ┌────────────────────────────┐  ║ │
                                    │  ║  │  ROW LEVEL SECURITY        │  ║ │
                                    │  ║  │  the authorization boundary│  ║ │
                                    │  ║  └────────────┬───────────────┘  ║ │
                                    │  ║               ▼                  ║ │
                                    │  ║  topics · profiles ·             ║ │
                                    │  ║  topic_redirects                 ║ │
                                    │  ║                                  ║ │
                                    │  ║  triggers: path materialisation, ║ │
                                    │  ║    slug derivation, cycle guard, ║ │
                                    │  ║    redirect capture              ║ │
                                    │  ║  functions: get_page,            ║ │
                                    │  ║    search_topics, move_topic,    ║ │
                                    │  ║    delete_topic, reorder         ║ │
                                    │  ║  indexes: 5 (§9)                 ║ │
                                    │  ╚══════════════════════════════════╝ │
                                    └───────────────────────────────────────┘
```

---

## 3. Database schema

Three tables. Not two, not seven.

```sql
profiles                              -- why: RLS cannot read auth.users, and roles need a home
  id            uuid PK → auth.users(id) ON DELETE CASCADE
  email         text
  display_name  text
  role          text NOT NULL DEFAULT 'viewer'  CHECK (role IN ('viewer','admin'))
  created_at    timestamptz NOT NULL DEFAULT now()

topics                                -- why: the documentation tree and its content
  id            uuid PK DEFAULT gen_random_uuid()
  parent_id     uuid → topics(id)              -- NO ACTION on delete (see §15)
  slug          text NOT NULL   CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
  path          text NOT NULL   UNIQUE          -- DERIVED, trigger-only
  depth         int  NOT NULL   CHECK (1..8)    -- DERIVED, trigger-only
  position      int  NOT NULL DEFAULT 0         -- sibling order
  title         text NOT NULL
  content       text NOT NULL DEFAULT ''        -- the Markdown
  excerpt       text            CHECK (≤ 320)   -- meta description + search snippet
  status        text NOT NULL DEFAULT 'draft'   CHECK (IN ('draft','published'))
  created_by    uuid → profiles(id) ON DELETE SET NULL
  updated_by    uuid → profiles(id) ON DELETE SET NULL
  created_at    timestamptz NOT NULL DEFAULT now()
  updated_at    timestamptz NOT NULL DEFAULT now()
  published_at  timestamptz
  search_vector tsvector GENERATED ALWAYS AS (weighted title/excerpt/content) STORED

  CONSTRAINT topics_path_key            UNIQUE (path)
  CONSTRAINT topics_no_self_parent      CHECK (parent_id IS NULL OR parent_id <> id)
  CONSTRAINT topics_reserved_root_slug  CHECK (nested OR slug NOT IN ('admin','login',…))

topic_redirects                       -- why: renaming a page must not break the internet
  old_path    text PK
  topic_id    uuid NOT NULL → topics(id) ON DELETE CASCADE
  created_at  timestamptz NOT NULL DEFAULT now()
```

### Why each non-obvious column exists

| Column | Justification | Would removing it hurt? |
|---|---|---|
| `path` | Turns "find the page at this URL" from a recursive walk into one index probe | Yes — it is the entire read-performance story |
| `depth` | O(1) nesting guard and breadcrumb ordering with no string splitting | Mildly — derivable from `path`, but at a cost on every read |
| `position` | Authors care about reading order; alphabetical is wrong for docs | Yes |
| `excerpt` | `<meta description>` and search snippets need prose, not raw Markdown | No, but quality drops (auto-derived fallback exists) |
| `status` | Draft/published is the whole point of an editorial workflow | Yes |
| `published_at` | "First published" is different from "last edited"; sitemaps and readers want both | No — nice to have |
| `search_vector` | Generated column keeps the index perfectly in sync with zero app code | Yes, if search is wanted |
| `updated_by` | Answers "who broke this page" in a multi-admin team | No |

### Explicitly rejected

- **A separate `content` / `topic_versions` table.** Content is 1:1 with a topic and always
  fetched with it. Splitting it means a join on the hottest query for no benefit. Versioning
  is deliberately out of scope for the MVP (§19 of the brief; see §22 here).
- **`tags`, `categories`, `authors` tables.** Nothing in the requirements needs them.
- **A `soft_deleted_at` column.** `status='draft'` already provides "make it disappear
  without losing it", which is what soft delete is usually reaching for.

### ID type: `uuid`, not `bigint`

Chosen because Supabase Auth identifies users by uuid (so `created_by` matches without a
translation layer) and because a leaked sequential id is an information leak — it tells you
how many pages exist and lets you enumerate them.

The usual counter-argument is real: random v4 uuids scatter B-tree inserts and are 16 bytes
instead of 8. At documentation scale — thousands of rows, not billions — that is noise.
**And it costs nothing here anyway, because ids never appear in a URL** (§6); the public
key is `path`.

---

## 4. ER diagram

```
                        ┌─────────────────────┐
                        │     auth.users      │   (managed by Supabase GoTrue)
                        │  id (uuid) PK       │
                        └──────────┬──────────┘
                                   │ 1:1, ON DELETE CASCADE
                                   │ populated by the on_auth_user_created trigger
                                   ▼
                        ┌─────────────────────┐
                        │      profiles       │
                        │  id (uuid) PK/FK    │
                        │  role  viewer|admin │──────┐
                        └──────────┬──────────┘      │ every RLS policy in the
                                   │                 │ system resolves through
                    created_by ────┤                 │ public.is_admin(), which
                    updated_by ────┤ 1:N             │ reads this one column
                                   │ ON DELETE SET NULL
                                   ▼                 │
    ┌──────────────────────────────────────────┐     │
    │                 topics                   │◄────┘
    │  id (uuid) PK                            │
    │  parent_id (uuid) FK ────────┐           │
    │  slug, title, content        │ SELF-     │
    │  path  UNIQUE   (derived)    │ REFERENCE │
    │  depth          (derived)    │ 1:N       │
    │  position, status            │ NO ACTION │
    │  search_vector  (generated)  │           │
    └──────────┬───────────────────┴───────────┘
               │        ▲                 │
               │        └─────────────────┘
               │  a topic's parent is another topic;
               │  NULL parent = a root section.
               │  Arbitrary depth, capped at 8 by CHECK.
               │
               │ 1:N, ON DELETE CASCADE
               ▼
    ┌──────────────────────────────┐
    │       topic_redirects        │
    │  old_path (text) PK          │   written only by trigger;
    │  topic_id (uuid) FK          │   points at the topic, never at
    └──────────────────────────────┘   another path — so no chains
```

### Relationships in words

1. **auth.users → profiles (1:1).** A trigger mirrors each signup. The mirror exists
   because RLS policies run as `anon`/`authenticated`, which cannot read `auth.users`,
   and because the application role needs somewhere to live that is not the JWT.
2. **profiles → topics (1:N, twice).** `created_by` and `updated_by`. `ON DELETE SET NULL`:
   removing a person must not remove their documentation.
3. **topics → topics (1:N, self-referencing).** The hierarchy. `NULL` parent means a root
   section. `ON DELETE NO ACTION` is load-bearing — see §15.
4. **topics → topic_redirects (1:N).** Every historical URL for a topic. Cascade on delete:
   a deleted page's old URLs should 404, not redirect into a void.

---

## 5. The hierarchical data model

### The decision

**Adjacency list (`parent_id`) as the source of truth, plus a trigger-maintained
materialized path (`path`) as a derived read cache.**

Neither alone is adequate. Together each covers the other's weakness.

### The four candidates, scored on the brief's own criteria

| | Adjacency only | Materialized path only | **Adjacency + path** | `ltree` | Nested sets |
|---|---|---|---|---|---|
| Look up `/a/b/c` | ✗ recursive CTE | ✓ one index probe | **✓ one index probe** | ✓ | ✓ |
| Children of X | ✓ indexed | ~ prefix + depth filter | **✓ indexed** | ✓ | ~ |
| Breadcrumbs | ✗ recursive | ✓ n prefix probes | **✓ n prefix probes** | ✓ | ✓ |
| Whole tree | ~ recursive CTE | ✓ order by path | **✓ flat select** | ✓ | ✓ |
| Move a node | ✓ one UPDATE | ✗ rewrite subtree | ~ **one UPDATE + cascade** | ~ | ✗✗ renumber |
| Reorder siblings | ✓ | ✓ | **✓** | ✓ | ✗✗ |
| Referential integrity | ✓ FK | ✗ strings only | **✓ FK** | ✗ | ✗ |
| Storage | best | +path | **+path (~60 B/row)** | +ltree | best |
| URL generation | ✗ derive per request | ✓ **is** the URL | **✓ is the URL** | ~ mapping needed | ✗ |
| Unlimited depth | ✓ | ✓ | **✓** | ✓ (65535) | ✓ |
| Supabase/PG fit | ✓ | ✓ | **✓ no extension** | ~ extension | ✓ |
| Complexity | lowest | low | **medium (3 triggers)** | medium | highest |

### Why `ltree` was rejected — a concrete, checkable reason

`ltree` is the obvious "PostgreSQL-native" answer and it is genuinely good at deep-ancestor
queries. It loses here on a detail that is easy to miss until it bites:

> **ltree labels did not permit hyphens until PostgreSQL 16.**
> PG 15 and earlier: *"A label is a sequence of alphanumeric characters and underscores
> (for example, in C locale the characters `A-Za-z0-9_` are allowed)."*
> PG 16+: *"…alphanumeric characters, underscores, and hyphens."*

URL slugs are hyphenated by convention — `rate-limiter`, not `rate_limiter`. On a Supabase
project running PG 15 (many still do; the platform hosts both 15 and 17), `ltree` cannot
store the path in the form the URL needs. You would maintain `rate_limiter` in the ltree
column and `rate-limiter` in the slug column and translate on every read — a lossy mapping
(what about a title that legitimately contains an underscore?) in exchange for GiST
ancestor operators you do not need at depth ≤ 8.

Secondary reasons: PG 15 also caps labels at 255 characters vs 1000 in PG 17; ltree adds an
extension dependency; and a GiST index is larger and slower to probe for equality than the
plain unique B-tree the chosen design already needs for `UNIQUE (path)`.

**Nested sets** were rejected outright: every insert renumbers half the table, which is
catastrophic for a CMS where inserts are the primary write.

### How the two representations stay consistent

Three triggers, and one non-obvious flag.

```
BEFORE INSERT OR UPDATE  topics_before_write()
  ├─ derive slug from title when blank; normalise an explicit slug
  ├─ de-duplicate AUTO-generated slugs (rate-limiter-2); let EXPLICIT ones error
  ├─ path  := parent.path || '/' || slug     depth := parent.depth + 1
  ├─ reject a move into own subtree  (cycle guard, checked against old.path)
  ├─ reject a move that would push descendants past depth 8
  └─ stamp updated_at / updated_by; forbid client-supplied created_by, path, depth

AFTER INSERT OR UPDATE   topics_after_write()
  ├─ on INSERT: clear any stale redirect that pointed at this now-claimed path
  └─ on path change:
       ├─ record old_path → topic id in topic_redirects
       ├─ delete any redirect that would shadow the new live path
       └─ rewrite every descendant in ONE statement:
            SET path = new.path || substring(path FROM length(old.path)+1)
```

**The subtle part.** That cascading UPDATE re-fires the BEFORE trigger on every descendant.
Inside a single statement, a grandchild reading its parent's row still sees the
*pre-statement* snapshot — so recomputing `path` from the parent would silently corrupt
level 3 and below. The cascade therefore sets a transaction-local flag
(`app.topics_cascade`) that tells the BEFORE trigger *"the path in NEW is already
authoritative, don't recompute it."*

This is exactly the class of bug that passes a two-level test and fails in production.
It is verified explicitly (§23, test 8: a two-level subtree moved to a new parent, with
grandchildren checked).

---

## 6. URL and path strategy

### Should the full path be stored, or derived per request?

**Stored.** The argument is one-sided once you count index probes.

- *Derived:* every page view runs a recursive CTE that walks down from the root matching
  one slug per level — for `/a/b/c/d`, four dependent index lookups plus CTE machinery,
  on the hottest query in the system.
- *Stored:* one probe against `UNIQUE (path)`. Breadcrumbs are then free: every ancestor's
  path is a *prefix* of the current one, so you generate the prefixes client-side or in
  SQL and fetch all ancestors with a single `path IN (...)` — n probes against the same
  index, no recursion.

The cost of storing is denormalisation, and denormalisation is only safe when something
guarantees consistency. Here that guarantee is a trigger, not application discipline:
`path` is not writable by any client. Even a hand-crafted PostgREST request setting
`path` to an arbitrary value is overwritten before the row lands.

### Slug rules

| Rule | Enforced by |
|---|---|
| URL-safe: `^[a-z0-9]+(?:-[a-z0-9]+)*$` | `CHECK` constraint |
| Auto-generated from the title when blank | trigger (`slugify()` with `unaccent`) |
| Explicit slugs normalised, not rejected | trigger — "Not A Slug!" becomes `not-a-slug` |
| No duplicate siblings | `UNIQUE (path)` — see below |
| Reserved words unusable at root | `CHECK` (`admin`, `login`, `api`, `sitemap`, …) |
| Max 80 chars, depth ≤ 8 | `CHECK` |

**Why `UNIQUE (path)` and not `UNIQUE (parent_id, slug)`.** The latter looks more natural
and is *wrong*: in SQL, `NULL` values compare as distinct, so `UNIQUE (parent_id, slug)`
happily allows two root topics both slugged `database`. You would need a partial index or
`NULLS NOT DISTINCT` (PG 15+) to fix it. Since `path = parent.path || '/' || slug` by
construction, a unique `path` makes duplicate siblings *structurally impossible* — one
constraint, no NULL semantics to reason about, and it is the same index the read path
already needs.

**Duplicate handling differs by intent, deliberately.** A slug the system *derived* from a
title gets silently numbered (`rate-limiter`, `rate-limiter-2`) — the author did not choose
it, so renaming it surprises nobody. A slug the author *typed* raises a conflict error
instead, because silently renaming a deliberate choice is worse than saying no.

### IDs never appear in URLs

`/system-design/rate-limiter` — never `/topics/9f3a...`. Public URLs are human-readable,
stable, editable, and shareable. Ids remain stable *behind* the URL, which is what makes
redirects work: `topic_redirects` maps an old path to a **topic id**, not to another path.
A page renamed three times still resolves in one hop, with no redirect chain to follow and
no possibility of a redirect loop.

### When a URL changes

Rename, re-slug, or move — all three change `path`, and all three are handled identically
by the same trigger:

```
system-design/rate-limiter/token-bucket   ──move──►   distributed-systems/token-bucket

topic_redirects:
  system-design/rate-limiter/token-bucket → <topic id>       ← recorded automatically
```

The SPA's behaviour on a miss (§11) is: look up the path → nothing → **ask the redirect
table before rendering 404** → `navigate(newPath, { replace: true })`. `replace` matters:
without it the Back button bounces the reader between the dead URL and the live one.

Verified end to end in the browser: rename a published page, request the old URL, land on
the new one (§23, admin tests 13 and 15).

---

## 7. Authentication and authorization

### Authentication — Supabase Auth (GoTrue)

The project owner creates administrator accounts from the Supabase dashboard. Signup
produces a `profiles` row with `role = 'viewer'` via a `SECURITY DEFINER` trigger that
**never reads a role from the signup payload** — which is why self-signup cannot mint an
admin. The owner promotes an account with one statement:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

Public readers are never authenticated. There is no session, no cookie, no token.

### Authorization — Row Level Security, and nothing else

```
                       ┌────────────────────────────────────────┐
   anon key            │  Postgres role: anon                   │
   (no JWT)      ────► │  GRANT: SELECT on topics only          │
                       │  RLS:   status = 'published'           │
                       └────────────────────────────────────────┘

   anon key            ┌────────────────────────────────────────┐
   + user JWT    ────► │  Postgres role: authenticated          │
   (role=viewer)       │  GRANT: SELECT/INSERT/UPDATE/DELETE    │
                       │  RLS:   published rows only;           │
                       │         is_admin() = false → 0 rows    │
                       └────────────────────────────────────────┘

   anon key            ┌────────────────────────────────────────┐
   + user JWT    ────► │  Postgres role: authenticated          │
   (role=admin)        │  RLS:   is_admin() = true → all rows,  │
                       │         full write                     │
                       └────────────────────────────────────────┘
```

**Two independent locks, not one.** Supabase's default privileges grant `anon` full DML on
new public tables and lean entirely on RLS. This project revokes that and grants `anon`
`SELECT` only, so an anonymous `INSERT` fails at the *privilege* layer before a policy is
consulted. If a policy is ever mis-written, the grant still holds.

### `is_admin()` — why its definition matters

```sql
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.profiles p
                     where p.id = (select auth.uid()) and p.role = 'admin'); $$;
```

Four details, each load-bearing:

1. **`SECURITY DEFINER`** — a policy on `topics` that reads `profiles` would otherwise be
   subject to `profiles`' own RLS. If `profiles`' policy ever referenced `topics`, you get
   infinite recursion (`42P17`), a classic Supabase failure. Running as owner side-steps
   RLS on the lookup entirely.
2. **`set search_path = ''`** — without it, a caller can create a temp table named
   `profiles` and impersonate an admin. This is *the* `SECURITY DEFINER` escalation hole.
3. **`STABLE`** — lets PostgreSQL evaluate it once per statement instead of once per row.
4. **`(select auth.uid())`** — wrapping in a subquery lets the planner cache it as an
   InitPlan; this is Supabase's documented RLS performance idiom.

### Anti-escalation

A user cannot grant themselves `admin` because:

- `profiles` has **no INSERT, UPDATE or DELETE policy at all** — the table is read-only
  through the API.
- `authenticated` is granted `SELECT` on `profiles` and nothing else.
- A `profiles_guard_role()` trigger rejects any role change when `auth.uid()` is non-NULL
  (i.e. a real end-user request), while leaving service-role and SQL-editor updates free.

Three locks for one attack. Verified: an authenticated viewer attempting
`update profiles set role='admin' where id = <self>` gets `permission denied for table
profiles` (§23, test 19).

### The frontend's role in authorization: none

`useAuth().isAdmin` controls what *renders*. `RequireAdmin` controls which route *mounts*.
Neither controls what the database *permits*. Deleting both from the bundle changes the UI
and changes nothing about access — a non-admin who forces the admin dashboard to render
watches every request return zero rows. That is the test: **if removing the frontend check
grants no new capability, the check was never the security control.**

---

## 8. RLS policies

```sql
-- ── topics ───────────────────────────────────────────────────────────────
-- Two SELECT policies rather than one with an OR. Permissive policies are
-- OR'ed anyway, and splitting them means the anonymous path never calls
-- is_admin() at all — no function call, no profiles lookup, for the 99%
-- of traffic that is a logged-out reader.
create policy "topics: anyone reads published" on public.topics
  for select to anon, authenticated  using (status = 'published');

create policy "topics: admins read everything" on public.topics
  for select to authenticated        using ((select public.is_admin()));

create policy "topics: admins insert" on public.topics
  for insert to authenticated   with check ((select public.is_admin()));

-- USING gates which rows you may target; WITH CHECK gates what the row may
-- become. Both are specified: WITH CHECK is what stops an admin-scoped
-- UPDATE from writing a row that would fall outside the policy.
create policy "topics: admins update" on public.topics
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "topics: admins delete" on public.topics
  for delete to authenticated        using ((select public.is_admin()));

-- ── profiles ─────────────────────────────────────────────────────────────
-- SELECT only. No write policy exists, by design.
create policy "profiles: read own"        on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: admins read all" on public.profiles
  for select to authenticated using ((select public.is_admin()));

-- ── topic_redirects ──────────────────────────────────────────────────────
-- World-readable: a redirect reveals only that a URL moved. Resolving one
-- still fetches the target through the topics policies, so a redirect that
-- points at a draft yields 404 for anonymous visitors rather than leaking it.
-- No write policy: rows come only from the SECURITY DEFINER trigger.
create policy "redirects: world readable" on public.topic_redirects
  for select to anon, authenticated using (true);
```

### Function execution grants

`get_page`, `search_topics`, `slugify` → `anon, authenticated`.
`move_topic`, `delete_topic`, `reorder_siblings`, `descendant_count` → `authenticated` only.

All of them are `SECURITY INVOKER` (the default). **This is the important part**: the write
RPCs are *not* a privilege escalation path. They exist for atomicity and validation, and
every statement inside them is still filtered by the `topics` policies. A viewer who calls
`delete_topic()` deletes zero rows — confirmed in §23, test 18.

---

## 9. Indexes — exactly five

Two more come free from constraints: `topics_path_key UNIQUE (path)` and
`topic_redirects_pkey (old_path)`. Between them they serve the two hottest reads in the
system, which is why the list below is short.

| # | Index | Optimises | Why it cannot be skipped |
|---|---|---|---|
| — | `topics_path_key UNIQUE (path)` | page lookup `path = $1`; breadcrumbs `path IN (…)` | the workhorse; also enforces sibling-slug uniqueness |
| 1 | `topics_path_prefix_idx (path text_pattern_ops)` | subtree scans `path LIKE 'x/%'` — move cascade, subtree delete, `descendant_count` | **the unique index cannot serve this.** Supabase DBs use a non-C collation (`en_US.UTF-8`), and a btree in a non-C collation is unusable for prefix `LIKE`. `text_pattern_ops` rebuilds it with C-style byte ordering |
| 2 | `topics_parent_position_idx (parent_id, position)` | children ordered by sibling position; admin tree; `reorder_siblings` | also required for **writes**: PostgreSQL does not auto-index the referencing side of an FK, so without it every topic DELETE seq-scans `topics` to check for children |
| 3 | `topics_search_idx GIN (search_vector)` | full-text search | GIN over GiST: ~3× faster to query, slower to write — correct for a read-dominated table |
| 4 | `topic_redirects_topic_id_idx (topic_id)` | `ON DELETE CASCADE` from topics | same FK story as #2 |

Index #1's necessity is verifiable — with a seq scan disabled, the planner picks it and
rewrites the predicate into a byte-range scan:

```
Index Only Scan using topics_path_prefix_idx on topics
  Index Cond: ((path ~>=~ 'system-design/') AND (path ~<~ 'system-design0'))
```

### Deliberately NOT created, and why

| Candidate | Why not |
|---|---|
| `(status)` | Two values, ~90% one of them. The planner will never choose it; it is pure write overhead |
| `(created_at)`, `(updated_at)` | The admin dashboard fetches the whole tree (a few thousand narrow rows) and sorts in the browser — under a millisecond |
| `(slug)` | Never queried alone. Lookups are by full path or by `(parent_id, …)` |
| `(created_by)` | Scanned only when a profile is deleted — a manual, rare operation |
| partial `(path) WHERE status='published'` | Would make the nav-tree query an index-only scan. **Add it when the published tree passes ~10,000 rows**; below that, seq scan + sort beats the index maintenance |

Every index is a permanent tax on every write and on backup size. Five is what this query
set justifies.

---

## 10. Important SQL queries

### Get a public page — `GET /system-design/rate-limiter`

One round trip returns the topic, its ancestors and its children.

```sql
create or replace function public.get_page(p_path text)
returns json language sql stable
as $$
  with target as (select * from public.topics where path = p_path),
  segments as (select string_to_array(p_path, '/') as parts),
  ancestor_paths as (
    select array_to_string((select parts from segments)[1:i], '/') as p
    from generate_series(1, coalesce(array_length((select parts from segments),1),0)) i
  )
  select json_build_object(
    'topic',       (select to_json(t) from (select … from target) t),
    'breadcrumbs', (select json_agg(… order by b.depth) from public.topics b
                    where b.path in (select p from ancestor_paths)),
    'children',    (select json_agg(… order by c.position, c.title) from public.topics c
                    where c.parent_id = (select id from target))
  );
$$;
```

**Plan:** `Index Scan using topics_path_key` — one probe for the page. Breadcrumbs are
`path IN ('system-design', 'system-design/rate-limiter')` — n probes against the same
index, **no recursive CTE anywhere**. Children use `topics_parent_position_idx`.

`SECURITY INVOKER`, so RLS applies transparently: an anonymous caller requesting a draft
gets `{"topic": null}` and the SPA renders 404. No `status` filter appears in the function
body — and none is needed.

### Get children

```sql
select id, parent_id, title, slug, path, depth, position, excerpt
from public.topics
where parent_id = $1 and status = 'published'
order by position;                     -- topics_parent_position_idx
```

### Get parent / breadcrumbs

The parent of `a/b/c` is at path `a/b` — derivable by string manipulation with **zero**
queries, or fetched with the full ancestor set in one statement:

```sql
select id, title, slug, path, depth
from public.topics
where path in ('system-design', 'system-design/rate-limiter',
               'system-design/rate-limiter/token-bucket')
order by depth;                        -- topics_path_key, one probe per level
```

### Complete navigation tree

```sql
select id, parent_id, title, slug, path, depth, position
from public.topics
where status = 'published'
order by path;
```

Flat, narrow (no `content`), and assembled into a tree in the browser. For 5,000 pages this
is roughly 400 KB uncompressed, ~60 KB gzipped, fetched **once per session** and cached.
The alternatives — a recursive CTE per page, or lazy-loading children per expand (N round
trips) — are both worse for a sidebar that must render fully on first paint.

### Search

```sql
select t.id, t.title, t.path,
       ts_headline('english', coalesce(nullif(t.excerpt,''), left(t.content, 4000)), q,
                   'StartSel=<<,StopSel=>>,MaxFragments=1,MaxWords=32,MinWords=12'),
       ts_rank(t.search_vector, q)
from public.topics t, websearch_to_tsquery('english', p_query) q
where t.search_vector @@ q             -- topics_search_idx (GIN)
order by ts_rank(t.search_vector, q) desc, t.depth asc
limit least(greatest(coalesce(p_limit,20),1), 50);
```

Two decisions worth naming:

- **`websearch_to_tsquery`**, not `plainto_tsquery`: it understands quoted phrases, `OR`,
  and `-exclusions` — what people actually type — and never raises a syntax error on
  malformed input.
- **`StartSel=<<`**, not `<mark>`: **`ts_headline` does not escape the document it
  highlights.** Asking Postgres for HTML and injecting it would pipe raw page content
  straight into the DOM. Non-HTML sentinels let the client split the string and build real
  `<mark>` React elements with no HTML interpolation anywhere (§14).

### Move, reorder, delete

```sql
select public.move_topic($1, $2, $3);          -- triggers do the path cascade
select public.reorder_siblings($1, $2::uuid[]);-- rewrites the sibling list atomically
select public.delete_topic($1, p_cascade);     -- see §15 for the NO ACTION story
select public.descendant_count($1);            -- what the confirm dialog shows
```

---

## 11. React architecture

### The router

```jsx
/login          → LoginPage                      (lazy)
/admin          → RequireAdmin > AdminLayout     (lazy)
  index         → AdminTopics
  topics/new    → AdminEditor
  topics/:id    → AdminEditor
/               → DocsLayout
  index         → HomePage
  *             → DocPage      ← the splat: every documentation URL
```

The splat is what makes URLs content-driven. `/a/b/c` arrives as one string, becomes one
indexed lookup, and renders. **Publishing a page makes its URL live immediately — no route
table to update, no rebuild, no deploy.**

Route *ranking*, not declaration order, decides the winner: React Router scores static
segments above dynamic above splats, so `/login` can never be swallowed by `/*`. The
reserved-slug `CHECK` constraint closes the other half — an author cannot create a
top-level page at `admin` and shadow the dashboard. **Both halves are needed**; the router
alone would let a topic at `/admin` become permanently unreachable.

| Case | Handling |
|---|---|
| Dynamic route | Splat → `get_page(path)` |
| Deep nesting | Free — the whole path is one string |
| Slug change | `topic_redirects` → `navigate(new, {replace:true})` |
| Invalid route | 404 **after** the redirect table says no |
| Render crash | `errorElement` on every branch (`RouteError`) |

### Data layer

```
components → hooks/useTopics.js → services/topics.js → lib/supabase.js
             (React Query)        (the ONLY module      (one client)
                                   that queries)
```

Confining every query to `services/topics.js` is not just tidiness: it makes the column
lists auditable in one place. The nav query selects seven narrow columns and never
`content` — the thing that keeps a 500-page sidebar at tens of kilobytes. Scatter
`select('*')` across twenty components and that guarantee silently evaporates.

### Cache policy is the performance strategy

| Query | staleTime | Effect |
|---|---|---|
| `navTree` | 5 min | Sidebar never refetches while browsing |
| `page` | 5 min | Back button and revisits are instant, 0 requests |
| `search` | 1 min | `keepPreviousData` — no flicker between keystrokes |
| `adminTree` | 30 s | Admins expect to see their own writes promptly |

Invalidation after a write is deliberately **blunt** — every tree and every cached page.
A rename or move rewrites the `path` of an unknown number of pages, so there is no
reliable way to know which entries are now wrong. Writes happen a few times an hour;
re-fetching one small tree is far cheaper than reasoning about partial invalidation, and
enormously cheaper than serving a stale URL.

---

## 12. Public UI

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [D] Engineering Docs              [🔍 Search ⌘K]  [☀ ◐ ☾]     Sign in    │  sticky
├───────────────────┬──────────────────────────────────┬───────────────────┤
│ ▾ System Design   │ Docs / System Design / Rate …    │  On this page     │
│   ▾ Rate Limiter  │                                  │  ─────────────    │
│     • Token Bucket│  # Token Bucket                  │  │ Why it is …    │  scroll
│       Sliding Win │                                  │  │ Properties     │   spy
│       Leaky Bucket│  The token bucket algorithm …    │                   │
│   ▸ Load Balancer │                                  │                   │
│   ▸ Caching       │  ```js  ← highlighted, copyable  │                   │
│ ▸ Database        │                                  │                   │
│                   │  ┌── In this section ──┐         │                   │
│  auto-expands to  │  │ child cards         │         │                   │
│  the current page │  └─────────────────────┘         │                   │
│                   │  ← Previous        Next →        │                   │
└───────────────────┴──────────────────────────────────┴───────────────────┘
  < 1024px: sidebar becomes a drawer      < 1280px: table of contents hides
```

- **Sidebar** — recursive tree, auto-expands along the current page's ancestor chain
  (derived from the URL, so a deep link opens with exactly the right branches showing).
- **Breadcrumbs** — plus `BreadcrumbList` JSON-LD, which is what puts a trail in a Google
  result instead of a bare URL.
- **Prev/next** — computed from the cached tree in depth-first reading order. **Zero
  extra requests.**
- **Table of contents** — headings extracted from the Markdown source with `IntersectionObserver`
  scroll spy (off the main thread; no scroll handler to throttle).
- **Search** — ⌘K / `/`, debounced 180 ms, arrow-key navigation, highlighted snippets.
- **Dark mode** — three-way light/system/dark, applied by an inline script in `index.html`
  *before first paint* so a dark-mode reader never sees a white flash.
- **States** — skeletons shaped like the incoming content (better CLS than a spinner),
  typed error states, and a 404 that only appears after the redirect table has been asked.
- **Accessibility** — skip link, `aria-current` on the active page, labelled landmarks,
  focus-visible rings, `prefers-reduced-motion` honoured, focus trap in dialogs.

---

## 13. Admin UI

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [A] Admin                     View site ↗  [☀◐☾]  admin@…   [Sign out]   │
├──────────────────────────────────────────────────────────────────────────┤
│  Topics                                             [+ Create topic]     │
│  16 pages · 15 published · 1 draft                                       │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Title                    URL                  Updated    Actions   │  │
│  │ ▾ System Design          /system-design       31 Aug     ↑↓ + ⇄ ● ✕│  │
│  │   ▾ Rate Limiter         /system-design/rate… 31 Aug     ↑↓ + ⇄ ● ✕│  │
│  │     Token Bucket         /…/token-bucket      31 Aug     ↑↓ + ⇄ ● ✕│  │
│  │     Redis        [DRAFT] /…/redis             31 Aug     ↑↓ + ⇄ ◯ ✕│  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘

Editor:
┌──────────────────────────────────────────────────────────────────────────┐
│ ← All topics                              [View ↗] [Publish] [  Save  ]  │
│ Token Bucket    /system-design/rate-limiter/token-bucket  PUBLISHED      │
│ ┌── Title ─────────────────────┐ ┌── Slug ────┐ ┌── Parent ───────────┐  │
│ ┌── Summary (0/320) ──────────────────────────── [Generate from content]│
├──────────────────────────────────────────────────────────────────────────┤
│ H2 B I </> {} 🔗 • 1. ❝ ▦          312 words · ~2 min read   [Write|Prev]│
├─────────────────────────────────┬────────────────────────────────────────┤
│ # Token Bucket                  │  Token Bucket                          │
│                                 │  ──────────────                        │
│ The token bucket algorithm …    │  The token bucket algorithm …          │
└─────────────────────────────────┴────────────────────────────────────────┘
```

Decisions worth defending:

- **The preview uses the *same* `MarkdownRenderer` as the public page** — same plugins,
  same sanitiser, same components. Two implementations would eventually diverge, and a
  preview that lies about what readers see is worse than no preview.
- **Up/down buttons, not drag-and-drop.** Dragging a nested tree well needs a drag library,
  pointer *and* keyboard equivalents, and "inside vs between" drop-target logic. Two
  buttons are keyboard-accessible, screen-reader friendly and dependency-free, and each
  click is one atomic `reorder_siblings()` call. Drag-and-drop can be layered on later over
  the same RPC.
- **Slug auto-derives while typing, and stops the moment you touch it.** An existing page's
  slug is never auto-rewritten from its title — that would silently change a live URL.
- **Deletion friction scales with consequences.** A leaf is one click. A page with
  descendants shows the exact count and requires typing the title.
- **`execCommand('insertText')`** for toolbar insertions, which preserves the browser's
  native undo stack; assigning `value` directly would destroy it.
- **Unsaved-changes guard** on tab close, and ⌘S to save.

---

## 14. Markdown rendering strategy

```
Markdown source (PostgreSQL text)
   │
   ├─ remark-gfm ......... tables, task lists, strikethrough, autolinks
   ├─ rehype-slug ........ stable heading ids (feeds the table of contents)
   ├─ rehype-highlight ... syntax colouring (language-tagged fences only)
   └─ rehype-sanitize .... LAST — vets everything above it
   │
   ▼
React elements (never innerHTML)
```

**Order is a security decision.** Sanitising *last* means `rehype-highlight`'s output is
also vetted. Sanitising first would leave whatever later plugins emit unchecked. The cost
is that the schema must explicitly allow `className` matching `/^hljs-/` on `<span>` —
without that one line, syntax highlighting is silently stripped and nobody notices until
someone looks at a code block.

**Three layers of XSS defence:**

1. `react-markdown` does not interpret raw HTML at all (no `rehype-raw`). A `<script>` tag
   in a document renders as literal text.
2. Its default `urlTransform` neutralises dangerous URL protocols.
3. `rehype-sanitize` enforces an allow-list over the final tree.

**A trap worth documenting.** `hast-util-sanitize` rewrites every `id` with the prefix
`user-content-` to prevent DOM clobbering (a document defining `id="body"` reaching
`document.body`). That protection is worth keeping — and it means the anchor for
`## Token Bucket` is `#user-content-token-bucket`, not `#token-bucket`. Both the table of
contents and in-document anchor links apply the same prefix. Miss this and every anchor
link on the site silently scrolls nowhere while looking perfectly correct in the source.

**Custom renderers:** internal links become React Router `<Link>` (SPA navigation, no full
reload); external links get `target="_blank" rel="noopener noreferrer nofollow"` —
without `noopener` the opened page can reach back through `window.opener`; tables are
wrapped in an `overflow-x: auto` box so a wide table scrolls itself instead of widening the
page; code blocks get a copy button; images get `loading="lazy"`.

The renderer is `memo`ised — the editor's live preview re-renders on every keystroke, and
re-parsing a long document each time is the most expensive thing the page can do.

**Attack results:** 18 payloads tested (script tags, `onerror`, `svg onload`, iframe,
`javascript:`/`vbscript:`/`data:` URLs, style injection, form, base, object/embed, meta
refresh, external stylesheet, DOM clobbering). All 18 neutralised; all 12 legitimate
features confirmed still working (§23).

---

## 15. Security analysis

| Threat | Control | Verified |
|---|---|---|
| Anonymous reads a draft | RLS `status='published'`; `get_page` is `SECURITY INVOKER` | ✓ 404 in browser |
| Anonymous writes | `anon` granted `SELECT` only — fails before RLS | ✓ `permission denied` |
| Viewer writes | RLS `is_admin()`; policies OR'ed, no admin policy matches | ✓ 0 rows / RLS violation |
| Privilege escalation | No write policy on `profiles`; no grant; guard trigger | ✓ `permission denied` |
| `SECURITY DEFINER` hijack | `set search_path = ''` on every such function | ✓ by construction |
| RLS recursion (`42P17`) | `is_admin()` is `SECURITY DEFINER`, bypassing `profiles` RLS | ✓ policies apply cleanly |
| XSS via Markdown | No raw HTML + `urlTransform` + `rehype-sanitize` last | ✓ 18/18 blocked |
| XSS via search snippet | `ts_headline` returns `<<…>>` sentinels; React builds `<mark>` | ✓ no `innerHTML` in path |
| DOM clobbering | `clobberPrefix: 'user-content-'` retained | ✓ ids prefixed |
| SQL injection | PostgREST parameterises everything; RPC args are typed and bound | ✓ by construction |
| Forged `path` / `created_by` | Trigger overwrites both regardless of payload | ✓ |
| Slug manipulation | `CHECK` regex + `slugify()` normalisation + reserved-word `CHECK` | ✓ |
| Route shadowing | Reserved root slugs cannot be created | ✓ constraint violation |
| Accidental subtree wipe | FK `NO ACTION` + typed confirmation | ✓ FK error, dialog gated |
| Reverse tabnabbing | `rel="noopener noreferrer"` on external links | ✓ |
| Clickjacking | `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` | ✓ headers set |
| Service-role leak | Never referenced in any `VITE_` variable; documented in `.env.example` | ✓ absent from bundle |

### Cascading deletion — the design

This is the requirement most easily got wrong in both directions, and the fix is one word
in the schema.

| FK action | Delete a parent alone | Delete a subtree in one statement |
|---|---|---|
| `CASCADE` | silently destroys the subtree ✗ | works |
| `RESTRICT` | errors ✓ | **also errors** ✗ — checked immediately, not deferrable |
| **`NO ACTION`** (chosen) | **errors ✓** | **works ✓** — checked at *end of statement* |

`NO ACTION` gives exactly the requested semantics for free. `delete_topic(id, cascade)`
then reads:

```sql
if p_cascade then
  delete from public.topics where path = v_path or path like v_path || '/%';  -- one statement
else
  delete from public.topics where id = p_id;                                   -- FK guards it
end if;
```

A stray delete of a section cannot destroy it. A deliberate one succeeds and returns the
count, so the UI says "deleted 4 pages" instead of leaving the author guessing.

### The anon key is public, and that is fine

Vite inlines every `VITE_*` variable into the bundle. The anon key **grants nothing** — it
identifies the request as the `anon` Postgres role. Every permission decision happens
afterwards, in RLS. The service-role key is a different matter entirely: it bypasses RLS
completely, and this application has no server-side context in which it could legitimately
appear. It is absent from the codebase and called out in `.env.example`.

---

## 16. Performance analysis

```
Browser ──► Vercel CDN ──► React ──► Supabase ──► PostgreSQL
   │            │             │          │            │
 React      immutable      code       PostgREST     5 indexes
 Query      assets;        splitting  connection    generated
 cache      SPA fallback   admin      pooling       tsvector
 (5 min)    at the edge    deferred
```

### Where caching lives, and where it deliberately does not

| Layer | Cached | Rationale |
|---|---|---|
| Vercel CDN | JS/CSS/fonts, `immutable`, 1 year | Content-hashed filenames; free and correct |
| Vercel CDN | `index.html` | Must not be long-cached, or deploys don't reach users |
| React Query | nav tree, pages, search | Turns a session into ~1 request per new page |
| PostgreSQL | shared buffers | A docs corpus is a few MB — it lives in RAM |
| **Redis** | **nothing** | **Not used, and the brief is right to be suspicious of it** |

**Why no Redis.** Redis earns its operational weight when the same expensive computation is
repeated across processes and cannot be cached closer to the user. Here the "expensive"
query is a single index probe returning one row, against a working set of a few megabytes
that PostgreSQL keeps in shared buffers. Adding Redis would introduce a second source of
truth, a cache-invalidation problem on every rename, and a service to operate — to
accelerate something that is already sub-millisecond. The honest answer at this scale is
that a correctly configured client cache does the job for free.

### Frontend budget (measured, gzipped)

| Chunk | Size | Loaded when |
|---|---|---|
| `react` | 57.2 KB | always |
| `supabase` | 54.0 KB | always |
| `router` | 31.1 KB | always |
| `index` (app) | 22.9 KB | always |
| `markdown` | 108.0 KB | on any documentation page |
| CSS | 10.6 KB | always |
| `AdminTopics` + `AdminEditor` + `AdminLayout` + `Modal` + `LoginPage` | **9.8 KB** | **only after signing in** |

Code-splitting the admin surface cut the shared application chunk from 29.1 KB to 22.9 KB
gzipped — a reader never downloads the editor, the dialogs or the admin tree.

### Query costs

| Operation | Plan | Rows touched |
|---|---|---|
| Page by path | Index Scan on unique `path` | 1 |
| Breadcrumbs | Index Scan × depth | ≤ 8 |
| Children | Index Scan `(parent_id, position)` | fan-out |
| Nav tree | Seq Scan + sort (correct at this size) | all published |
| Search | Bitmap Index Scan (GIN) | matches |
| Move a subtree | Index Only Scan (prefix) + one UPDATE | subtree |

---

## 17. SEO — and the honest cost of a client-rendered SPA

### What works

React 19 hoists `<title>`, `<meta>` and `<link>` rendered anywhere in the tree into
`document.head` natively — **no `react-helmet` dependency needed**. Each page emits a
unique title, description, canonical URL, Open Graph and Twitter tags. Googlebot executes
JavaScript, sees them, and indexes the pages. Add semantic HTML (`<article>`, `<nav>`,
`<time>`, one `<h1>` from the Markdown), `BreadcrumbList` JSON-LD, a build-time
`sitemap.xml` and `robots.txt`, and standard-search SEO is in good shape.

One trap found and fixed: React *prepends* hoisted tags rather than replacing what
`index.html` already declares, so the document ended up with **two** `<title>` elements and
**two** descriptions. `document.title` happened to resolve correctly, but leaving duplicate
metadata for a crawler to choose between is not something to rely on. The static tags are
now marked `data-default` and removed once React owns the head — they remain in the served
HTML for non-JS clients, and the live DOM holds exactly one of each. (§23, tests 7–8.)

### What does not work, and cannot

> **Social crawlers do not execute JavaScript.** Slack, Twitter/X, LinkedIn, Discord and
> iMessage read the raw `index.html`. Every shared link previews with the same generic
> title and description, whichever page was shared.

This is inherent to client-side rendering, not a bug in this implementation. It also means
the first paint is a blank shell until JS parses and the data arrives.

### Should this be Next.js instead?

**Honestly: for a public documentation site, yes** — and the brief asked to be told rather
than have the stack swapped silently.

| | Vite SPA (built) | Next.js App Router |
|---|---|---|
| Google indexing | ✓ (JS-rendered) | ✓ (HTML) |
| Social link previews | **✗** | ✓ |
| First contentful paint | after JS + data | server-rendered |
| Per-page metadata | ✓ (React 19) | ✓ (`generateMetadata`) |
| Sitemap freshness | last deploy | on request |
| Page HTML cached at CDN | ✗ | ✓ ISR |
| Runtime to operate | none | serverless functions |
| Conceptual complexity | lower | higher (server/client split) |

The stack was built as specified. **The migration path is short and was designed for**:
`services/topics.js` is framework-agnostic and moves unchanged; the SQL, RLS, triggers and
indexes — the majority of this system — do not change at all. What changes is the routing
layer (`app/[...slug]/page.jsx` replacing the splat route) and `<Seo>` becoming
`generateMetadata`. That is roughly a day of work, not a rewrite.

**Two intermediate options** if staying on Vite:

1. **Prerender at build time** — render each published path to static HTML during the build
   (`vite-plugin-ssr`, or a Playwright crawl). Fixes social previews and first paint;
   requires a rebuild per publish.
2. **Vercel middleware for bot user-agents** — inject per-page meta tags into `index.html`
   for known crawlers. Cheaper, but it is a second source of truth for metadata.

### Sitemap: build-time, deliberately

`scripts/generate-sitemap.mjs` runs after `vite build`, queries published paths **with the
anon key** (RLS already restricts it to exactly what belongs in a sitemap — a build script
has no business holding the service-role key), and writes `dist/sitemap.xml` and
`dist/robots.txt`. It never fails the deploy: a missing `.env` produces a warning and a
minimal `robots.txt`.

The cost is staleness between deploys. The fix, when it matters, is one Supabase Database
Webhook on `topics` pointing at a Vercel Deploy Hook — publishing a page triggers a
rebuild.

---

## 18. Deployment architecture

```
GitHub ──push──► Vercel Build ──► Vercel Edge Network ──► Readers
                     │
                     ├─ vite build          → dist/assets/* (content-hashed)
                     └─ generate-sitemap    → dist/sitemap.xml, dist/robots.txt

Supabase (separate lifecycle)
   └─ supabase db push  →  migrations  →  Production PostgreSQL
```

### Environment variables

| Variable | Where | Public? |
|---|---|---|
| `VITE_SUPABASE_URL` | Vercel + `.env` | Yes — inlined into the bundle |
| `VITE_SUPABASE_ANON_KEY` | Vercel + `.env` | Yes — grants nothing on its own |
| `VITE_SITE_URL` | Vercel + `.env` | Yes — canonical URLs, sitemap |
| `VITE_SITE_NAME` | Vercel + `.env` | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | **nowhere in this project** | **Never** |

### Vercel configuration (`vercel.json`)

- **SPA fallback:** `{"source": "/(.*)", "destination": "/index.html"}` — without it, a
  hard refresh on `/system-design/rate-limiter` returns 404 from the CDN, because no such
  file exists. Vercel checks the filesystem before rewrites, so real assets still win.
- **Immutable caching** on `/assets/*` (content-hashed, safe for a year).
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy`, and a CSP whose `connect-src` allows only
  `'self'` and `*.supabase.co`.

### Supabase configuration

- **Migrations:** `supabase link --project-ref <ref>` then `supabase db push`. Files are
  timestamp-ordered and idempotent in ordering, not in effect — run them once, in order.
- **CORS:** nothing to configure. Supabase permits browser origins by default; the
  restriction that matters is RLS, not CORS.
- **Auth redirects:** set Site URL to the production domain and add preview-deployment URLs
  to Redirect URLs. Only relevant for magic links / OAuth; password sign-in needs neither.
- **Email confirmations:** turn off in development, on in production.
- **Domain:** add it in Vercel, point DNS, and update `VITE_SITE_URL` **and** the Supabase
  Site URL — a stale `VITE_SITE_URL` produces canonical tags pointing at the wrong host,
  which is worse than none.

---

## 19. Project structure

```
project/
├── src/
│   ├── components/
│   │   ├── markdown/    MarkdownRenderer.jsx · sanitizeSchema.js
│   │   ├── docs/        Sidebar · Breadcrumbs · PrevNext · TableOfContents · SearchDialog
│   │   ├── admin/       TopicTree · MarkdownEditor · MoveDialog · DeleteDialog
│   │   └── ui/          Spinner · ErrorState · ThemeToggle · Modal · Seo
│   ├── layouts/         DocsLayout.jsx · AdminLayout.jsx (+ RequireAdmin)
│   ├── pages/           HomePage · DocPage · LoginPage · RouteError · admin/*
│   ├── routes/          index.jsx                     ← the whole route table
│   ├── hooks/           useAuth · useTheme · useTopics · useDebounced
│   ├── services/        topics.js                     ← the ONLY module that queries
│   ├── lib/             supabase.js · config.js · errors.js · queryClient.js
│   ├── utils/           slug.js · tree.js · markdown.js
│   ├── App.jsx · main.jsx · index.css
├── supabase/
│   ├── migrations/      schema → functions → rls → indexes
│   └── seed.sql
├── scripts/             generate-sitemap.mjs
├── tests/               db.test.sql · xss.test.jsx · public.e2e.mjs · admin.e2e.mjs
│                        + local harness (fake Supabase for offline testing)
├── public/              favicon.svg
├── .env.example · vercel.json · vite.config.js · index.html · package.json
└── README.md · ARCHITECTURE.md
```

Two deviations from the suggested structure, both deliberate: `types/` is absent (this is
JavaScript, not TypeScript — see §22), and `layouts/` holds the route guard next to the
shell it guards rather than in a separate `guards/` folder.

---

## 20. Implementation plan

| Phase | Work | Status |
|---|---|---|
| 1 · Setup | Vite + React 19 + Tailwind v4, env config, routing skeleton | ✅ |
| 2 · Database | 3 tables, constraints, 5 indexes, triggers, RPCs, RLS, seed | ✅ |
| 3 · Auth | Supabase Auth, `profiles` + role, `is_admin()`, guarded routes | ✅ |
| 4 · Topics | CRUD, hierarchy, slugs, path materialisation, move, reorder, redirects | ✅ |
| 5 · Markdown | Editor + toolbar, live preview, GFM, highlighting, sanitisation | ✅ |
| 6 · Public docs | Splat routing, sidebar, breadcrumbs, TOC, prev/next, search, responsive | ✅ |
| 7 · Perf & SEO | Code splitting, cache policy, metadata, JSON-LD, sitemap, headers | ✅ |
| 8 · Testing | 29 SQL behaviour checks · 30 XSS/feature checks · 56 browser checks | ✅ |
| 9 · Deployment | `vercel.json`, env docs, migration + domain runbook | ✅ (documented) |

---

## 21. Edge cases

| # | Case | Handling |
|---|---|---|
| 1 | Two siblings, same title | Auto-slug numbers the second: `caching-2` |
| 2 | Two siblings, same slug typed explicitly | `23505` on `topics_path_key` → "Another page already uses that URL" |
| 3 | Two **root** topics, same slug | Caught — `UNIQUE (path)` has no NULL-distinctness hole |
| 4 | Move a node into its own descendant | Trigger raises `23514`; the UI also greys out the option |
| 5 | Move a node into itself | Same guard + `CHECK (parent_id <> id)` |
| 6 | Move that would push descendants past depth 8 | Pre-checked against `max(depth)` of the subtree |
| 7 | Title with accents/punctuation | `unaccent` + regex: `Cache Éviction: LRU / LFU!` → `cache-eviction-lru-lfu` |
| 8 | Title with no URL-safe characters (e.g. `"…"`) | Explicit error rather than an empty slug |
| 9 | Root topic slugged `admin` | `CHECK` rejects; nested `admin` is fine |
| 10 | Rename a mid-tree node | Descendants rewritten in one statement; redirects for all |
| 11 | Move a 2-level subtree | Grandchildren correct — the cascade-flag fix (§5) |
| 12 | Old URL after 3 renames | One hop: redirects store a topic **id**, so no chains |
| 13 | New page claims a previously-redirected path | Insert trigger clears the stale redirect |
| 14 | Redirect points at a page that became a draft | RLS filters the join → 404, not a leak |
| 15 | Delete a page with children, no cascade | FK `NO ACTION` errors at statement end; nothing lost |
| 16 | Delete a subtree deliberately | One statement, `NO ACTION` permits it, count returned |
| 17 | Published child of an unpublished parent | Promoted to a sidebar root rather than hidden |
| 18 | Draft requested anonymously | `get_page` returns `{topic: null}` → 404 |
| 19 | Draft found via search | RLS filters `search_topics` too |
| 20 | Empty content | Renderer shows "This page has no content yet" |
| 21 | Malformed Markdown | remark never throws; renders as literal text |
| 22 | Very wide table / long code line | Scrolls inside its own box; page never scrolls horizontally |
| 23 | Anchor link `[x](#heading)` | Rewritten with the `user-content-` clobber prefix |
| 24 | Duplicate headings in one page | github-slugger suffixes `-1`, `-2`; TOC matches |
| 25 | Session expires mid-edit | `PGRST301` → "Your session expired. Please sign in again." |
| 26 | Supabase project paused / offline | `Failed to fetch` → network error state with retry |
| 27 | Migrations not applied | `42P01` → "Have the migrations been applied?" |
| 28 | Missing `.env` | Caught at boot; instructions rendered instead of a white screen |
| 29 | Non-admin signs in | "Signed in, but not an administrator" — not a bare 403 |
| 30 | Tab closed with unsaved Markdown | `beforeunload` guard |
| 31 | `localStorage` blocked (private mode) | Theme falls back to system; wrapped in try/catch |
| 32 | Hard refresh on a deep URL | Vercel SPA rewrite → `index.html` |

---

## 22. Future scalability

### Deliberately deferred, with the path in place

**Versioning — not in the MVP.** The brief asks whether it is needed; it is not. Editorial
history matters once multiple people edit the same page and need to answer "who changed
this and can we go back". Until then it doubles write complexity for nobody's benefit.

The design does not preclude it. Adding it is additive:

```sql
create table public.topic_revisions (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.topics(id) on delete cascade,
  version int not null, title text, content text, excerpt text,
  created_by uuid references public.profiles(id), created_at timestamptz default now(),
  unique (topic_id, version)
);
-- + an AFTER UPDATE trigger snapshotting the OLD row when content changed
-- + RLS: admins read; nobody writes except the trigger
```

No existing table or query changes. `topics` stays the current version, which keeps the
hot read path exactly as it is.

### Growth path, in order of when it bites

| Trigger | Change |
|---|---|
| Nav tree > ~10k published pages | Add partial index `(path) WHERE status='published'`; consider lazy sidebar branches |
| Search feels imprecise | Add trigram fuzzy matching (`pg_trgm`) before reaching for an external engine |
| Corpus > ~100k documents | Postgres FTS is still fine; beyond that, Typesense/Meilisearch for typo tolerance and faceting |
| Social previews / first paint matter | Migrate to Next.js — data layer moves unchanged (§17) |
| Multiple editors collide | Add `topic_revisions` + optimistic concurrency on `updated_at` |
| Non-technical authors | Layer a WYSIWYG over the same Markdown storage |
| Multi-language | `topics.locale` + composite unique `(locale, path)` |
| Multi-tenant | `topics.workspace_id` + one extra RLS predicate |

### Known limitations, stated plainly

1. **Social link previews do not work** (§17). The single real cost of the SPA choice.
2. **No optimistic locking.** Two admins editing one page: last write wins. Add an
   `updated_at` precondition when a second editor exists.
3. **JavaScript, not TypeScript.** Matches the brief. On a team, the `services/` and
   `utils/` layers would repay typing first.
4. **Redirects accumulate forever.** Harmless at this scale (one narrow row per URL
   change); prune by age if it ever matters.
5. **Depth capped at 8.** Not a technical limit — a deliberate guard against pathological
   nesting and unbounded `path` length. Raising it is a one-line `CHECK` change.

---

## 23. Verification

Nothing above is asserted from reading the code. The database ran on PostgreSQL 16.13 with
an `en_US.UTF-8` collation (matching Supabase) behind a minimal `auth` schema shim; the UI
ran in headless Chromium against that database.

| Suite | Checks | Result |
|---|---|---|
| SQL behaviour — paths, plans, rename/move cascade, cycle guards, slug rules, depth ceiling, delete semantics, reorder, search, RLS for anon/viewer/admin, privilege escalation | 29 | **all pass** |
| Markdown security — 18 XSS payloads + 12 feature checks | 30 | **18/18 blocked, 12/12 working** |
| Public UI — routing, metadata, breadcrumbs, GFM, highlighting, TOC anchors, prev/next, search + highlight, dark mode, RLS-backed 404s, mobile layout, request count | 36 | **all pass** |
| Admin UI — sign-in, tree, auto-slug, live preview, DB-materialised path, publish→live URL, rename→redirect, move→redirect, delete blast radius + confirmation gate, reorder | 20 | **all pass** |

Three real defects were found and fixed by these tests, not by inspection:

1. **Duplicate `<title>` and `<meta description>`** — React 19 prepends hoisted tags rather
   than replacing the static ones in `index.html`. Fixed with `data-default` markers that
   `<Seo>` removes on mount.
2. **Heading anchors silently broken** — `rehype-sanitize` prefixes ids with
   `user-content-`, so every TOC and in-document anchor link pointed at nothing. Fixed by
   applying the same prefix on both sides.
3. **Syntax highlighting silently stripped** — sanitising after `rehype-highlight` removes
   `className` from `<span>` unless the schema allows it. Fixed with a narrow
   `/^hljs-/` allowance.

All three are the kind that look fine in code review and fail in production.
