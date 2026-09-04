# Markdown Documentation Platform — Architecture

**Stack:** React 19 (Vite SPA) · Tailwind CSS v4 · Supabase (PostgreSQL 15+/17, Auth, RLS) · Vercel

**Shape:** a multi-author documentation platform. Anyone may register; every page has an
owner and one of three access levels — private, anyone-can-view, or anyone-can-edit — and
a private section hides everything beneath it. Administrators manage accounts and every
page.

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
  email         text NOT NULL
  username      text NOT NULL UNIQUE   CHECK (3-30 chars, [a-z0-9_-])
  display_name  text
  role          text NOT NULL DEFAULT 'member'  CHECK (IN ('member','admin'))
  status        text NOT NULL DEFAULT 'active'  CHECK (IN ('active','suspended'))
  created_at / updated_at  timestamptz

topics                                -- why: the page tree, its content, and its access rules
  id            uuid PK DEFAULT gen_random_uuid()
  parent_id     uuid → topics(id)              -- NO ACTION on delete (see §15)
  slug          text NOT NULL   CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
  path          text NOT NULL   UNIQUE          -- DERIVED, trigger-only
  depth         int  NOT NULL   CHECK (1..8)    -- DERIVED, trigger-only
  position      int  NOT NULL DEFAULT 0         -- sibling order

  owner_id      uuid NOT NULL → profiles(id)    -- MUTABLE: transfers on account deletion
  created_by    uuid → profiles(id) ON DELETE SET NULL   -- historical author
  updated_by    uuid → profiles(id) ON DELETE SET NULL   -- last editor

  title         text NOT NULL
  content       text NOT NULL DEFAULT ''        -- the Markdown
  excerpt       text            CHECK (≤ 320)

  visibility           text NOT NULL DEFAULT 'private'
                       CHECK (IN ('private','public','collaborative'))
  effective_visibility text NOT NULL DEFAULT 'private'   -- DERIVED from the ancestor chain
                       CHECK (IN ('private','public','collaborative'))

  created_at / updated_at / published_at  timestamptz
  search_vector tsvector GENERATED ALWAYS AS (weighted title/excerpt/content) STORED

  CONSTRAINT topics_path_key            UNIQUE (path)
  CONSTRAINT topics_no_self_parent      CHECK (parent_id IS NULL OR parent_id <> id)
  CONSTRAINT topics_reserved_root_slug  CHECK (nested OR slug NOT IN ('admin','dashboard','login',…))

topic_redirects                       -- why: renaming a page must not break the internet
  old_path    text PK
  topic_id    uuid NOT NULL → topics(id) ON DELETE CASCADE
  created_at  timestamptz NOT NULL DEFAULT now()
```

Plus one view:

```sql
public_profiles = SELECT id, username, display_name FROM profiles
```

Pages show who wrote them, so every reader must resolve an `owner_id` to a
username — and must not get the rest of the row. A view runs with its owner's
privileges unless `security_invoker` is set, so it reads through profiles' RLS
while exposing three harmless columns. The alternative, a policy letting
everyone SELECT `profiles`, would publish every member's email address and
account status to the world.

### Why each non-obvious column exists

| Column | Justification | Would removing it hurt? |
|---|---|---|
| `path` | Turns "find the page at this URL" from a recursive walk into one index probe | Yes — it is the entire read-performance story |
| `depth` | O(1) nesting guard and breadcrumb ordering with no string splitting | Mildly — derivable from `path`, at a cost on every read |
| `position` | Authors care about reading order; alphabetical is wrong for docs | Yes |
| `owner_id` | Who controls the page. Separate from `created_by` because it *transfers* when an account is deleted | Yes — it is the subject of half the policies |
| `created_by` | Historical author. The day it differs from `owner_id` is the day you need both | No, but authorship is then unrecoverable |
| `updated_by` | On a page anyone can edit, the last editor is routinely not the owner | No — but "who changed this" is the first question asked |
| `visibility` | The owner's stated intent | Yes |
| `effective_visibility` | That intent **after** the ancestor rule is applied. The only access column RLS reads | Yes — without it every policy walks the tree |
| `excerpt` | `<meta description>` and search snippets need prose, not raw Markdown | No (auto-derived fallback exists) |
| `username` | Bylines and the people table need a stable public handle that is not an email | No, but you would be printing email addresses |
| `status` | A reversible ban that keeps a member's content | No — but then the only moderation tool is deletion |
| `search_vector` | Generated column keeps the index in sync with zero application code | Yes, if search is wanted |

### Explicitly rejected

- **A `permissions` or `topic_shares` table.** Per-user grants ("Alice may edit
  this one page") would need it. Three global levels do not, and adding the
  table would put a join on the hot read path to answer a question nobody asked.
- **A separate `content` table.** Content is 1:1 with a page and always fetched
  with it. Splitting it adds a join to the hottest query for nothing.
- **A `soft_deleted_at` column.** `visibility='private'` already provides "make
  it disappear without losing it".
- **Storing `is_private` as a boolean plus a separate `is_editable`.** Two
  booleans give four states, one of which (private *and* world-editable) is
  incoherent. One three-valued column cannot express it.

### ID type: `uuid`, not `bigint`

Supabase Auth identifies users by uuid, so `owner_id`, `created_by` and
`updated_by` all match without a translation layer. A leaked sequential id is
also an information leak — it tells you how many pages exist and lets you
enumerate them, which matters far more now that some of those pages are
private. The usual counter-argument (random v4 uuids scatter B-tree inserts, 16
bytes vs 8) is real and irrelevant at documentation scale — and costs nothing
here anyway, because ids never appear in a URL (§6).

## 4. ER diagram

```
                        ┌─────────────────────┐
                        │     auth.users      │   (managed by Supabase GoTrue)
                        │  id (uuid) PK       │
                        └──────────┬──────────┘
                                   │ 1:1, ON DELETE CASCADE
                                   │ populated by on_auth_user_created;
                                   │ ALWAYS ('member','active') — which is why
                                   │ open registration cannot mint an admin
                                   ▼
                        ┌─────────────────────┐        ┌──────────────────────┐
                        │      profiles       │───────►│   public_profiles    │
                        │  id (uuid) PK/FK    │  view  │  id, username,       │
                        │  username  UNIQUE   │        │  display_name        │
                        │  role    member|admin │      │  (world-readable)    │
                        │  status  active|suspended │  └──────────────────────┘
                        └──────────┬──────────┘
                                   │  is_admin()  reads role
                                   │  is_active() reads status
                                   │  — every policy in the system
                                   │    resolves through these two
                    owner_id  ─────┤ 1:N  (NOT NULL, no delete action:
                    created_by ────┤       admin_delete_user reassigns first)
                    updated_by ────┤ 1:N  ON DELETE SET NULL
                                   ▼
    ┌──────────────────────────────────────────┐
    │                 topics                   │
    │  id (uuid) PK                            │
    │  parent_id (uuid) FK ────────┐           │
    │  owner_id, created_by,       │ SELF-     │
    │  updated_by                  │ REFERENCE │
    │  slug, title, content        │ 1:N       │
    │  path  UNIQUE   (derived)    │ NO ACTION │
    │  depth          (derived)    │           │
    │  visibility                  │           │
    │  effective_visibility (derived from      │
    │                        the ancestor chain)│
    │  search_vector  (generated)  │           │
    └──────────┬───────────────────┴───────────┘
               │        ▲                 │
               │        └─────────────────┘
               │  a page's parent is another page;
               │  NULL parent = a root section, which
               │  any active member may create.
               │  Arbitrary depth, capped at 8 by CHECK.
               │
               │ 1:N, ON DELETE CASCADE
               ▼
    ┌──────────────────────────────┐
    │       topic_redirects        │
    │  old_path (text) PK          │   written only by trigger;
    │  topic_id (uuid) FK          │   points at the page, never at
    └──────────────────────────────┘   another path — so no chains
```

### Relationships in words

1. **auth.users → profiles (1:1).** A trigger mirrors each signup, because RLS
   policies run as `anon`/`authenticated` and those roles cannot read
   `auth.users`. The trigger never reads a role from the signup payload.
2. **profiles → public_profiles (view).** The only projection the world sees.
3. **profiles → topics (1:N, three times).** `owner_id` (who controls it),
   `created_by` (who wrote it), `updated_by` (who touched it last). Only
   `owner_id` is NOT NULL, and it deliberately has no `ON DELETE` action:
   `admin_delete_user()` must reassign the pages *before* the profile row goes,
   which is what makes "removing a person keeps their documentation" an
   invariant rather than a hope.
4. **topics → topics (1:N, self-referencing).** The hierarchy, and the channel
   the visibility rule propagates along.
5. **topics → topic_redirects (1:N).** Every historical URL for a page.

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

## 7. Access model: accounts, visibility, and inheritance

### Authentication — Supabase Auth (GoTrue)

Registration is open. Anyone may create an account at `/register`; the signup
trigger writes `('member','active')` and **never reads a role from the
payload**, so posting `{"role":"admin"}` to the signup endpoint achieves exactly
nothing. The first administrator is promoted once, by hand:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

After that, administrators promote each other through `admin_set_role()`.
Reading the site never requires an account.

### The three visibility levels

| Setting | Who reads | Who edits | Who renames, moves, deletes |
|---|---|---|---|
| **private** | owner + admins | owner + admins | owner + admins |
| **public** | everyone | owner + admins | owner + admins |
| **collaborative** | everyone | **any active member** | owner + admins |

One three-valued column, not a pair of switches. The obvious alternative —
keeping `draft/published` and adding a sharing level beside it — produces six
states, two of which ("published but private", "draft but world-editable") are
incoherent and have to be explained away in the UI. Collapsing them loses
nothing: *draft* and *private* were always the same idea.

### Inheritance: the most restrictive ancestor wins

A private section hides its entire subtree, whatever the children say.

This is not a nicety. URLs here are paths. If `/research` were private but
`/research/notes` were public, a visitor could open `/research/notes` and then
be shown a breadcrumb to `/research` that 404s for them. "Private" has to mean
the whole subtree or it means nothing.

```
        visibility          effective_visibility
vault     private      →      private
 └ notes  public       →      private     ← the parent wins
    └ deep public      →      private     ← and keeps winning, all the way down
 └ secret private      →      private

  ... then the owner opens the vault:

vault     public       →      public
 └ notes  public       →      public      ← restored to its own setting
    └ deep public      →      public
 └ secret private      →      private     ← still private on its own merit
```

Note what does **not** propagate. A collaborative page under a merely *public*
parent stays collaborative. Only `private` travels downward, because only
`private` is a statement about who may *see* the subtree; edit rights are a
per-page decision.

### How the rule is enforced: materialisation, not recursion

`effective_visibility` is computed by trigger and stored, exactly like `path`:

```sql
effective_visibility := CASE WHEN parent.effective_visibility = 'private'
                             THEN 'private' ELSE visibility END
```

Because the parent's value is already correct, each row needs only its parent —
no ancestor walk. When a section's visibility changes, an `AFTER` trigger walks
*down* one level at a time with a recursive CTE:

```sql
with recursive sub as (
  select c.id, case when NEW.effective_visibility = 'private'
                    then 'private' else c.visibility end as eff
  from topics c where c.parent_id = NEW.id
  union all
  select c.id, case when s.eff = 'private' then 'private' else c.visibility end
  from topics c join sub s on c.parent_id = s.id
)
update topics t set effective_visibility = sub.eff from sub where t.id = sub.id;
```

The alternative — testing every ancestor of every descendant — is `O(depth)`
per row and cannot use an index, because the pattern side of
`descendant.path LIKE ancestor.path || '/%'` is the column. Walking down uses
`(parent_id, position)` and touches each row once.

The payoff is in the policies: they read **one column** and never touch the
tree. A page's access check is a single indexed comparison, not a recursive CTE
evaluated per row of every read.

### Authorization — four actors

```
   anon key            ┌────────────────────────────────────────┐
   (no JWT)      ────► │  Postgres role: anon                   │
                       │  GRANT: SELECT on topics only          │
                       │  RLS:   effective_visibility <> 'private'│
                       └────────────────────────────────────────┘

   + JWT               ┌────────────────────────────────────────┐
   (member,      ────► │  reads the above, plus pages they own   │
    active)            │  creates pages they will own            │
                       │  edits any collaborative page (text only)│
                       │  edits + deletes their own              │
                       └────────────────────────────────────────┘

   + JWT               ┌────────────────────────────────────────┐
   (member,      ────► │  is_active() = false                    │
    suspended)         │  → exactly an anonymous reader,         │
                       │    while keeping every page they wrote  │
                       └────────────────────────────────────────┘

   + JWT               ┌────────────────────────────────────────┐
   (admin)       ────► │  every row, plus the admin_* functions  │
                       └────────────────────────────────────────┘
```

**Two independent locks, not one.** Supabase's default privileges grant `anon`
full DML on new public tables and lean entirely on RLS. This project revokes
that and grants `anon` `SELECT` only, so an anonymous `INSERT` fails at the
*privilege* layer before a policy is consulted. If a policy is ever mis-written,
the grant still holds.

### The three helper functions

```sql
is_admin()        role = 'admin' AND status = 'active'   -- a suspended admin is not an admin
is_active()       status = 'active'                      -- the gate on every write
can_edit(topic)   admin, OR owner, OR effectively collaborative
```

All three are `SECURITY DEFINER` with `SET search_path = ''`, and both
properties are load-bearing:

1. **`SECURITY DEFINER`** — a policy on `topics` that reads `profiles` would
   otherwise be subject to profiles' own RLS, and the moment two tables'
   policies reference each other you get infinite recursion (`42P17`), a classic
   Supabase failure. Running as the owner side-steps it.
2. **`search_path = ''`** — without it, a caller can create a temp table named
   `profiles` and impersonate an administrator. This is *the* `SECURITY DEFINER`
   escalation hole.
3. **`STABLE`** — evaluated once per statement rather than once per row.
4. **`(select auth.uid())`** — wrapping in a subquery lets the planner cache it
   as an InitPlan; Supabase's documented RLS performance idiom.

### Suspension: a ban that keeps the content

`admin_set_status(user, 'suspended')` flips one column. `is_active()` stops
returning true, so every write policy declines — and nothing else changes. The
account exists, every page it owns stays exactly as published, and reactivating
restores everything in one click.

This is deliberately the *first* moderation tool offered, ahead of deletion. The
problem is almost always "this person must stop changing things", not "this
person and their work must cease to exist".

### Anti-escalation

A member cannot grant themselves anything, because:

- `profiles` has no INSERT or DELETE policy, and its UPDATE policy covers only
  their own row.
- `profiles_guard()` rejects any change to `role`, `status`, `id` or `email`
  from a request carrying an end-user JWT — so the only field that UPDATE policy
  actually opens is `display_name`.
- `role` and `status` are writable only through `admin_set_role()` /
  `admin_set_status()`, which check `is_admin()` on their first line.
- `authenticated` is granted `SELECT, UPDATE` on `profiles` and nothing more.

### The collaborative-edit trap

This is the one place where a permissive policy, alone, would be a hole.

"Any active member may update this row" also permits setting `owner_id` to
yourself, flipping `visibility` to private, renaming the URL, or moving the page
into your own section — a hostile takeover wearing an edit's clothing. `WITH
CHECK` cannot stop it, because **a policy cannot see the OLD row**.

`topics_before_write()` closes it: when the caller is neither the owner nor an
administrator, a request that would change `owner_id`, `visibility`, `slug` or
`parent_id` is refused outright:

> You can edit the text of a shared page, but only its owner can rename it,
> move it, or change who may see it

It compares against `OLD` rather than blanket-rejecting those columns, so an
ordinary save that echoes back unchanged values still goes through. And it
*refuses* rather than silently reverting — a guest who somehow submits a rename
should be told no, not shown "saved" over a change that did not happen.

### The frontend's role in authorization: none

`isAdmin`, `canWrite` and `canEdit` decide what the UI *renders*.
`RequireMember` decides which route *mounts*. None of them decide what the
database *permits*. Delete all of them from the bundle and a member still sees
non-private pages plus their own, and every write they attempt is still refused.
That is the test: **if removing the frontend check grants no new capability, the
check was never the security control.**

## 8. RLS policies

```sql
-- ── topics: SELECT ───────────────────────────────────────────────────────
-- Three permissive policies, OR'ed. Split rather than combined into one
-- expression so the anonymous path is a bare column comparison that never
-- calls a function or touches profiles — the shape of 99% of the traffic.
create policy "topics: anyone reads what is not private" on public.topics
  for select to anon, authenticated  using (effective_visibility <> 'private');

create policy "topics: owners read their own" on public.topics
  for select to authenticated        using (owner_id = (select auth.uid()));

create policy "topics: admins read everything" on public.topics
  for select to authenticated        using ((select public.is_admin()));

-- ── topics: INSERT ───────────────────────────────────────────────────────
-- can_edit(parent_id) is the whole rule:
--   parent NULL -> creating at the shared root; any active member may.
--   otherwise   -> you must own the parent, or it must be collaborative.
--                  You cannot drop a page into someone else's private section.
create policy "topics: members create what they will own" on public.topics
  for insert to authenticated with check (
    (select public.is_active())
    and owner_id = (select auth.uid())
    and (select public.can_edit(parent_id))
  );

create policy "topics: admins create anywhere" on public.topics
  for insert to authenticated with check ((select public.is_admin()));

-- ── topics: UPDATE ───────────────────────────────────────────────────────
create policy "topics: owners update their own" on public.topics
  for update to authenticated
  using      (owner_id = (select auth.uid()) and (select public.is_active()))
  with check (owner_id = (select auth.uid()));

-- The dangerous one. See §7, "The collaborative-edit trap": on its own this
-- would permit a takeover, and topics_before_write() is what closes it.
create policy "topics: members update collaborative pages" on public.topics
  for update to authenticated
  using      (effective_visibility = 'collaborative' and (select public.is_active()))
  with check (effective_visibility = 'collaborative');

create policy "topics: admins update everything" on public.topics
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ── topics: DELETE ───────────────────────────────────────────────────────
-- Note what is ABSENT: there is no collaborative delete policy. "Anyone can
-- edit" is an invitation to contribute, not permission to destroy.
create policy "topics: owners delete their own" on public.topics
  for delete to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_active()));

create policy "topics: admins delete anything" on public.topics
  for delete to authenticated using ((select public.is_admin()));

-- ── profiles ─────────────────────────────────────────────────────────────
-- Readable only by its owner and by administrators; the world gets the
-- public_profiles view instead, which carries no email, role or status.
create policy "profiles: read your own"    on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: admins read all"  on public.profiles
  for select to authenticated using ((select public.is_admin()));

-- Not a hole: profiles_guard() rejects any change to role, status, id or
-- email from an end-user JWT, so the only field this opens is display_name.
create policy "profiles: edit your own display name" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ── topic_redirects ──────────────────────────────────────────────────────
-- A redirect is visible only if its TARGET is. The EXISTS is evaluated with
-- the topics policies applied, so a redirect pointing at a private page
-- simply is not there — rather than resolving to a 404 and thereby
-- confirming that the page exists.
create policy "redirects: visible when the target is" on public.topic_redirects
  for select to anon, authenticated
  using (exists (select 1 from public.topics t where t.id = topic_id));
```

### A consequence worth knowing

An owner deleting a subtree that contains a page **someone else** created inside
their collaborative folder will find the delete blocked by the foreign key: the
other person's row is invisible to the DELETE and survives it, leaving a child
with no parent. That is the correct outcome — it fails loudly instead of quietly
destroying a contributor's work.

### Administrator functions

`admin_set_role`, `admin_set_status`, `admin_delete_user` and `admin_list_users`
are `SECURITY DEFINER`, because each does something an `authenticated` caller
genuinely cannot: write a column no policy exposes, or delete from
`auth.users`. That makes **the first line of each body the actual access
control** — a `SECURITY DEFINER` function without an internal check is a
privilege-escalation endpoint with a friendly name.

Two invariants are enforced on top of `is_admin()`, because losing either leaves
the installation unadministrable:

1. You cannot demote, suspend or delete **yourself**.
2. You cannot remove the **last active administrator**.

`admin_delete_user()` transfers the departing member's pages to the acting
administrator before deleting the profile — ordering that is forced by
`owner_id` being NOT NULL with no delete action, and that turns "removing a
person keeps their documentation" into something the schema guarantees rather
than something the code remembers to do.

## 9. Indexes — exactly five

Four more come free from constraints: `topics_path_key UNIQUE (path)`,
`topic_redirects_pkey (old_path)`, `profiles_pkey (id)` and
`profiles_username_key (username)`. Between them they serve the two hottest
reads in the system, which is why the list below is short.

| # | Index | Optimises | Why it cannot be skipped |
|---|---|---|---|
| — | `topics_path_key UNIQUE (path)` | page lookup `path = $1`; breadcrumbs `path IN (…)` | the workhorse; also enforces sibling-slug uniqueness |
| 1 | `topics_path_prefix_idx (path text_pattern_ops)` | subtree scans `path LIKE 'x/%'` — move cascade, subtree delete, `descendant_count` | **the unique index cannot serve this.** Supabase DBs use a non-C collation (`en_US.UTF-8`), and a btree in a non-C collation is unusable for prefix `LIKE`. `text_pattern_ops` rebuilds it with C-style byte ordering |
| 2 | `topics_parent_position_idx (parent_id, position)` | children ordered by sibling position; the authoring trees; `reorder_siblings`; **and the recursive visibility cascade**, which walks the tree by `parent_id` one level at a time | also required for writes: PostgreSQL does not auto-index the referencing side of an FK, so without it every page DELETE seq-scans `topics` |
| 3 | `topics_owner_idx (owner_id)` | `where owner_id = $1` — now one of the two hottest queries, run on every dashboard load | and for writes: `owner_id` is NOT NULL with no delete action, so `admin_delete_user` must find every page referencing the account. Without this, removing a member is a seq scan |
| 4 | `topics_search_idx GIN (search_vector)` | full-text search | GIN over GiST: ~3× faster to query, slower to write — correct for a read-dominated table |
| 5 | `topic_redirects_topic_id_idx (topic_id)` | `ON DELETE CASCADE` from topics | same FK story as #2 |

Index #1's necessity is verifiable — with seq scan disabled, the planner picks
it and rewrites the predicate into a byte-range scan:

```
Index Only Scan using topics_path_prefix_idx on topics
  Index Cond: ((path ~>=~ 'system-design/') AND (path ~<~ 'system-design0'))
```

### Deliberately NOT created, and why

| Candidate | Why not |
|---|---|
| `(effective_visibility)` | Three values, ~90% one of them. The planner will never choose it; pure write overhead |
| `(visibility)` | Never queried — every policy and every list reads the *effective* column |
| `(created_by)`, `(updated_by)` | Both `ON DELETE SET NULL`, so scanned only when an account is deleted. `admin_delete_user()` clears them explicitly in one pass; one extra scan of a few thousand rows costs under a millisecond. `owner_id` is indexed because it is read on every dashboard load; these are not |
| `(created_at)`, `(updated_at)` | The dashboards fetch a member's whole tree and sort in the browser |
| `(slug)` | Never queried alone. Lookups go by full path or by `(parent_id, …)` |
| partial `(path) WHERE effective_visibility <> 'private'` | Would make the public navigation query an index-only scan. **Add it when the shared tree passes ~10,000 pages**; below that, seq scan + sort beats the index maintenance |

Every index is a permanent tax on every write and on backup size. Five is what
this query set justifies.

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
where parent_id = $1 and effective_visibility <> 'private'
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
where effective_visibility <> 'private'
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
/login          → AuthPage mode=login             (lazy)
/register       → AuthPage mode=register          (lazy)
/dashboard      → RequireMember > DashboardLayout (lazy)
  index         → MyPages
  pages/new     → Editor
  pages/:id     → Editor
  all           → RequireMember adminOnly > AllPages
  people        → RequireMember adminOnly > People
/admin, /admin/*→ redirect to /dashboard          ← older bookmarks
/               → DocsLayout
  index         → HomePage
  *             → DocPage      ← the splat: every documentation URL
```

The splat is what makes URLs content-driven. `/a/b/c` arrives as one string, becomes one
indexed lookup, and renders. **Publishing a page makes its URL live immediately — no route
table to update, no rebuild, no deploy.**

Route *ranking*, not declaration order, decides the winner: React Router scores static
segments above dynamic above splats, so `/login` can never be swallowed by `/*`. The
reserved-slug `CHECK` constraint closes the other half, and it matters far more now
that *any member* can claim a top-level name: without it someone could create a page at
`/dashboard` and make the dashboard permanently unreachable for everyone. **Both halves
are needed.**

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
| `myTopics`, `allTopics`, `users` | 15–30 s | Authors expect to see their own writes promptly |

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

## 13. Authoring UI

One dashboard for everyone, with two extra tabs for administrators. The
alternative — a member area and a separate admin area — would mean two
implementations of the same page tree, which is how they drift apart.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [D] Dashboard   My pages │ All pages │ People    View site ↗  @ada  ADMIN │
├──────────────────────────────────────────────────────────────────────────┤
│  My pages                                            [ + New page ]      │
│  4 pages · 3 visible to others · 1 private                               │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Title                  URL              Owner   Updated  Actions   │  │
│  │ ▾ System Design 👁PUBLIC /system-design  @ada    31 Aug            │  │
│  │   ▾ Caching     👁PUBLIC /system-design… @ada    31 Aug            │  │
│  │     Cache Evict ✎SHARED /…/cache-evict… @ada    31 Aug  [▾] ↑↓+⇄✕ │  │
│  │     Redis       🔒PRIVATE /…/redis        @ada    31 Aug  [▾] ↑↓+⇄✕ │  │
│  │   Vault         🔒PRIVATE(inherited) …                             │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘

Editor:
┌──────────────────────────────────────────────────────────────────────────┐
│ ← All pages                                       [View ↗] [  Save   ]   │
│ Token Bucket   /system-design/rate-limiter/token-bucket   👁 PUBLIC       │
│ ┌ Title ──────────────────┐ ┌ Address ────┐ ┌ Section ────────────────┐  │
│ ┌ Who can see this? ─────────────────────────────────────────────────┐   │
│ │ ( ) 🔒 Private      (•) 👁 Anyone can view   ( ) ✎ Anyone can edit │   │
│ │     Only you…           Everyone reads·you edit  …any member edits │   │
│ └────────────────────────────────────────────────────────────────────┘   │
│ ┌ Summary (0/320) ─────────────────────────── [Generate from content]    │
├──────────────────────────────────────────────────────────────────────────┤
│ H2 B I </> {} 🔗 • 1. ❝ ▦        312 words · ~2 min read  [Write|Preview] │
├─────────────────────────────────┬────────────────────────────────────────┤
│ # Token Bucket                  │  Token Bucket                          │
└─────────────────────────────────┴────────────────────────────────────────┘
```

Decisions worth defending:

- **Three cards, not a dropdown, for visibility.** It is the setting people get
  wrong, and the consequence of getting it wrong is either an embarrassing leak
  or work nobody can find. Each option states who reads and who edits, in that
  order, in words rather than in the database's vocabulary — nobody thinks "set
  effective_visibility to collaborative", they think "let anyone edit this".
- **The inheritance warning is shown, not enforced by disabling.** When the
  parent is private, this page is private whatever is chosen. Greying the
  control out leaves people wondering why; leaving it usable and saying *"This
  page is private regardless, because a section above it is private… the setting
  you choose takes effect the moment that section is opened up"* explains the
  model in the one place it matters.
- **The guest editor is a different form, not a disabled one.** Editing someone
  else's shared page hides the address, section and visibility fields entirely,
  and says why. Rendering controls the database would refuse is worse than not
  rendering them.
- **The preview uses the *same* `MarkdownRenderer` as the public page** — same
  plugins, same sanitiser, same components. Two implementations would eventually
  diverge, and a preview that lies about what readers see is worse than none.
- **Up/down buttons, not drag-and-drop.** Dragging a nested tree well needs a
  drag library, pointer *and* keyboard equivalents, and "inside vs between"
  drop-target logic. Two buttons are keyboard-accessible, screen-reader
  friendly, dependency-free, and each click is one atomic `reorder_siblings()`.
- **Deletion friction scales with consequences.** A leaf is one click. A section
  with descendants shows the exact count and requires typing the title.
- **Suspension is offered before deletion on the People page**, and the delete
  dialog says so again. The usual problem is "this person must stop changing
  things", not "this person must cease to exist".

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
| Anonymous reads a private page | RLS `effective_visibility <> 'private'`; `get_page` is `SECURITY INVOKER` | ✓ 404 in browser |
| Anonymous reads a public page inside a private section | `effective_visibility` is materialised from the ancestor chain | ✓ hidden, then revealed when the parent opens |
| Anonymous writes | `anon` granted `SELECT` only — fails before RLS | ✓ `permission denied` |
| Member reads someone else's private page | No policy matches | ✓ row invisible |
| Member writes into someone else's section | INSERT policy calls `can_edit(parent_id)` | ✓ RLS violation |
| **Collaborator seizes ownership** | `topics_before_write()` compares against OLD and refuses | ✓ explicit refusal |
| **Collaborator flips a shared page to private** | same guard | ✓ explicit refusal |
| **Collaborator renames or moves a shared page** | same guard | ✓ explicit refusal |
| Collaborator deletes a shared page | No collaborative DELETE policy exists | ✓ 0 rows / error |
| Suspended member writes | `is_active()` in every write policy | ✓ RLS violation; content untouched |
| Suspended administrator uses admin powers | `is_admin()` requires `status='active'` | ✓ by construction |
| Member promotes themself | No writable `role`; `profiles_guard()`; `admin_set_role` checks `is_admin()` | ✓ three refusals |
| Member changes their own status or email | `profiles_guard()` | ✓ distinct messages |
| Member reads others' emails | `profiles` SELECT is own-row only; world gets a 3-column view | ✓ 1 row visible |
| Admin removes the last administrator | `assert_admin_target()` | ✓ refused |
| Admin locks themselves out | Self-guard on role, status and delete | ✓ refused; UI also disables |
| Deleting a member destroys documentation | `admin_delete_user()` transfers pages first | ✓ pages survive, timestamps unchanged |
| `SECURITY DEFINER` hijack | `set search_path = ''` on all of them | ✓ 8/8 pinned |
| RLS recursion (`42P17`) | Helpers are `SECURITY DEFINER`, bypassing profiles' RLS | ✓ policies apply cleanly |
| Route shadowing (`/dashboard`, `/register`) | Reserved root slugs `CHECK` — now that any member can claim a top-level name | ✓ constraint violation |
| XSS via Markdown | No raw HTML + `urlTransform` + `rehype-sanitize` last | ✓ 18/18 blocked |
| XSS via search snippet | `ts_headline` returns `<<…>>` sentinels; React builds `<mark>` | ✓ no `innerHTML` in path |
| DOM clobbering | `clobberPrefix: 'user-content-'` retained | ✓ ids prefixed |
| SQL injection | PostgREST parameterises everything; RPC args are typed and bound | ✓ by construction |
| Forged `owner_id` / `path` / `created_by` | Trigger overwrites all three regardless of payload | ✓ |
| Private page indexed by search engines | `noindex` on private pages; sitemap filters on `effective_visibility` | ✓ |
| Redirect confirms a private page exists | Redirect policy requires the target to be visible | ✓ invisible, not 404 |
| Accidental subtree wipe | FK `NO ACTION` + typed confirmation | ✓ FK error, dialog gated |
| Service-role leak | Never referenced in any `VITE_` variable | ✓ absent from bundle |

### Cascading deletion — the design

The requirement most easily got wrong in both directions, fixed by one word in
the schema.

| FK action | Delete a parent alone | Delete a subtree in one statement |
|---|---|---|
| `CASCADE` | silently destroys the subtree ✗ | works |
| `RESTRICT` | errors ✓ | **also errors** ✗ — checked immediately, not deferrable |
| **`NO ACTION`** (chosen) | **errors ✓** | **works ✓** — checked at *end of statement* |

### The anon key is public, and that is fine

Vite inlines every `VITE_*` variable into the bundle. The anon key **grants
nothing** — it identifies the request as the `anon` Postgres role, and every
permission decision happens afterwards in RLS. The service-role key is a
different matter: it bypasses RLS completely, and on a multi-user site that
means publishing every member's private pages. This application has no
server-side context in which it could legitimately appear; it is absent from the
codebase and called out in `.env.example` and in the sitemap script, which
deliberately uses the anon key precisely so it cannot leak private paths.

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
| `Editor` + `PageManager` + `People` + `DashboardLayout` + `AuthPage` + `Modal` + `MyPages` + `AllPages` | **15.8 KB** | **only when authoring** |

Code-splitting the authoring surface keeps the shared application chunk at 25.4 KB
gzipped — a reader never downloads the editor, the dialogs, the tree manager or the
people table, even though the site now has accounts.

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
│   ├── layouts/         DocsLayout.jsx · DashboardLayout.jsx (+ RequireMember)
│   ├── pages/           HomePage · DocPage · AuthPage · RouteError
│   │                    dashboard/ MyPages · AllPages · People · Editor · PageManager
│   ├── routes/          index.jsx                     ← the whole route table
│   ├── hooks/           useAuth · useTheme · useTopics · useDebounced
│   ├── services/        topics.js · admin.js          ← the ONLY modules that query
│   ├── lib/             supabase.js · config.js · errors.js · queryClient.js
│   ├── utils/           slug.js · tree.js · markdown.js
│   ├── App.jsx · main.jsx · index.css
├── supabase/
│   ├── migrations/      schema → functions → admin → rls → indexes
│   ├── schema.sql       all five, concatenated for one-shot pasting
│   └── seed.sql
├── scripts/             generate-sitemap.mjs
├── tests/               db.*.test.sql · xss.test.jsx
│                        public / authoring / multiuser .e2e.mjs
│                        + local harness and a PostgREST stand-in
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
| 8 · Multi-user | Registration, per-page visibility with inheritance, collaborative editing, suspension, account management | ✅ |
| 9 · Testing | 74 SQL checks · 30 XSS/feature checks · 95 browser checks | ✅ |
| 10 · Deployment | `vercel.json`, env docs, migration + domain runbook | ✅ (documented) |

---

## 21. Edge cases

| # | Case | Handling |
|---|---|---|
| 1 | Two siblings, same title | Auto-slug numbers the second: `notes-2` |
| 2 | Two siblings, same slug typed explicitly | `23505` → "Another page already uses that URL" |
| 3 | Two **root** pages, same slug | Caught — `UNIQUE (path)` has no NULL-distinctness hole |
| 4 | A member claims `/dashboard` at the root | Reserved-slug `CHECK` refuses; nested `dashboard` is fine |
| 5 | Move a page into its own descendant | Trigger raises `23514`; the UI also greys out the option |
| 6 | Move that would push descendants past depth 8 | Pre-checked against `max(depth)` of the subtree |
| 7 | Rename a mid-tree page | Descendants rewritten in one statement; redirects for all |
| 8 | Move a 2-level subtree | Grandchildren correct — the cascade-flag fix (§5) |
| 9 | Old URL after three renames | One hop: redirects store a page **id**, so no chains |
| 10 | New page claims a previously-redirected path | Insert trigger clears the stale redirect |
| 11 | Redirect points at a page you may not see | Redirect policy hides the row entirely — not a 404 that confirms it exists |
| 12 | **Public page inside a private section** | `effective_visibility` = private; hidden from everyone but the owner |
| 13 | **Private section is opened up** | Descendants revert to their own settings; an independently-private child stays private |
| 14 | **Collaborative page inside a private section** | Effectively private — nobody can edit what nobody can see |
| 15 | **Collaborative page under a merely public parent** | Stays collaborative; only `private` propagates |
| 16 | Guest edits a shared page and resends unchanged metadata | Passes — the guard compares against OLD, not a blanket column ban |
| 17 | Guest attempts a rename, move, or visibility change | Refused with one readable sentence |
| 18 | Owner deletes a subtree containing someone else's page | FK blocks it; the contributor's work is not silently destroyed |
| 19 | Suspended member's pages | Stay published, stay owned, stay exactly as they were |
| 20 | Suspended member opens the dashboard | Let in, shown a banner; every write control is inert |
| 21 | Suspended administrator | `is_admin()` returns false — no admin powers |
| 22 | Last administrator demotes, suspends or deletes themselves | `assert_admin_target()` refuses all three |
| 23 | Deleting a member | Pages transfer to the acting admin; `created_by` cleared; timestamps untouched |
| 24 | Two accounts with the same email local part | Usernames de-duplicated: `alice`, `alice2` |
| 25 | Signup with a 1-character local part (`j@…`) | Padded to `j00` rather than failing the CHECK |
| 26 | Registering an email that already exists | Detected via GoTrue's empty `identities` array → "An account already exists" |
| 27 | Email confirmation is switched on | `signUp` returns no session → "Check your email" screen |
| 28 | Page saved with no Markdown heading | The stored title renders as `<h1>` so the page is never untitled |
| 29 | Title with accents/punctuation | `unaccent` + regex: `Cache Éviction: LRU!` → `cache-eviction-lru` |
| 30 | Title with no URL-safe characters | Explicit error rather than an empty slug |
| 31 | Empty content | Renderer shows "This page has no content yet" |
| 32 | Malformed Markdown | remark never throws; renders as literal text |
| 33 | Very wide table / long code line | Scrolls inside its own box; the page never scrolls sideways |
| 34 | Anchor link `[x](#heading)` | Rewritten with the `user-content-` clobber prefix |
| 35 | Duplicate headings in one page | github-slugger suffixes `-1`, `-2`; the TOC matches |
| 36 | Session expires mid-edit | `PGRST301` → "Your session expired. Please sign in again." |
| 37 | Supabase project paused / offline | `Failed to fetch` → network error state with retry |
| 38 | Migrations not applied | `42P01` → "Have the migrations been applied?" |
| 39 | Missing `.env` | Caught at boot; instructions rendered instead of a white screen |
| 40 | Tab closed with unsaved Markdown | `beforeunload` guard |
| 41 | `localStorage` blocked (private mode) | Theme falls back to system; wrapped in try/catch |
| 42 | Hard refresh on a deep URL | Vercel SPA rewrite → `index.html` |

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
| Nav tree > ~10k shared pages | Add partial index `(path) WHERE effective_visibility <> 'private'`; consider lazy sidebar branches |
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

Nothing above is asserted from reading the code. The database ran on PostgreSQL
16.13 with an `en_US.UTF-8` collation (matching Supabase) behind a minimal
`auth` schema shim; the UI ran in headless Chromium against that database,
through a ~200-line PostgREST/GoTrue stand-in that runs every request as the
real `anon` or `authenticated` role — so the browser suites exercise the actual
RLS policies rather than mocks.

| Suite | Checks | Result |
|---|---|---|
| SQL — paths, plans, rename/move cascade, cycle guards, slug rules, depth ceiling, delete semantics, reorder, search | 29 | **all pass** |
| SQL — the permission model: registration and username de-duplication, the read matrix for four actors, private inheritance both directions, creation rights, the collaborative takeover attempt, owner rights, suspension, admin guards, account deletion with page transfer, escalation through `profiles`, `public_profiles` exposure, `can_edit` agreement | 45 | **all pass** |
| Markdown security — 18 XSS payloads + 12 feature checks | 30 | **18/18 blocked, 12/12 working** |
| Browser — public site: routing, metadata, breadcrumbs, GFM, highlighting, TOC anchors, prev/next, search, dark mode, RLS-backed 404s, mobile layout, request count | 36 | **all pass** |
| Browser — authoring: the full tree, auto-slug, live preview, DB-materialised path, publish→live URL, rename→redirect, move→redirect, delete blast radius, visibility from the tree, reorder | 22 | **all pass** |
| Browser — multi-user: registration, private-by-default, publishing, collaborative editing, the guest form, private inheritance through the UI, the People page, self-action guards, suspension, admin route guards, account deletion with transfer | 37 | **all pass** |

Six real defects were found and fixed by these tests, not by inspection:

1. **Deleting a user failed with a foreign-key violation.** The "created_by is
   never rewritten" guard in `topics_before_write()` was undoing PostgreSQL's
   own `ON DELETE SET NULL`, so the delete then failed on the very constraint
   that action exists to satisfy. The guard now rejects a change to a *different*
   author and lets NULL through.
2. **`can_edit` never reached the page.** `get_page()` returned it, and the
   service layer mapped exactly three fields out of the response and silently
   dropped it — so "Edit this page" never appeared on a shared page.
3. **Duplicate `<title>` and `<meta description>`.** React 19 prepends hoisted
   tags rather than replacing the static ones in `index.html`.
4. **Heading anchors silently broken.** `rehype-sanitize` prefixes ids with
   `user-content-`, so every TOC and in-document anchor pointed at nothing.
5. **Syntax highlighting silently stripped.** Sanitising after
   `rehype-highlight` removes `className` from `<span>` unless the schema allows
   it.
6. **A page with no Markdown heading rendered with no title at all**, leaving
   the breadcrumb as the only clue what you were reading.

All six look fine in code review.

One deliberate change came out of testing rather than a bug: the collaborative
guard originally reverted a guest's forbidden fields silently and reported
success. It now refuses with a sentence explaining what a guest may and may not
change — a no-op that says "saved" is worse than an error.
