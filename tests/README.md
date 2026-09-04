# Tests

Everything runs offline against a **local PostgreSQL** plus a small stand-in for
Supabase's HTTP layer. No cloud project, no credentials, no network.

```
tests/
├── local-harness.sql            fake `auth` schema + the anon/authenticated/service_role roles
├── postgrest-shim.mjs           ~200-line PostgREST + GoTrue stand-in on :54321
│
├── db.paths-and-plans.test.sql  path materialisation, get_page, EXPLAIN plans
├── db.hierarchy.test.sql        rename/move cascades, cycle guards, slug rules
├── db.rls-and-search.test.sql   delete semantics, full-text search
├── db.permissions.test.sql      the multi-user model: 4 actors × 3 visibility levels,
│                                inheritance, takeover attempts, admin guards
├── xss.test.jsx                 18 XSS payloads + 12 feature checks
│
├── public.e2e.mjs               36 browser checks — the public site
├── authoring.e2e.mjs            22 browser checks — creating and managing pages
└── multiuser.e2e.mjs            37 browser checks — registration, visibility, people
```

The shim is a **test fixture, not production code**. It translates the handful
of requests this app makes into SQL and runs each one as the `anon` or
`authenticated` role with the caller's uid in `request.jwt.claim.sub` — so the
browser suites exercise the **real RLS policies**, not mocks. It also mints
unsigned JWTs for `/auth/v1/signup` and `/auth/v1/token`, which is why
registration and sign-in work end to end without GoTrue.

## Setup

```bash
# 1. a local Postgres with a non-C collation (matching Supabase)
initdb -D /tmp/pgdata -U postgres --locale=en_US.UTF-8 -E UTF8
pg_ctl -D /tmp/pgdata -o "-k /tmp/pgrun -p 5433" -l /tmp/pg.log start

# 2. harness + migrations
for f in tests/local-harness.sql supabase/migrations/*.sql; do
  psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
done

# 3. an administrator, and sample content owned by them
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -c "
  insert into auth.users (id, email, raw_user_meta_data)
    values ('11111111-1111-1111-1111-111111111111','admin@example.com','{\"display_name\":\"Ada Admin\"}');
  update public.profiles set role='admin'
    where id='11111111-1111-1111-1111-111111111111';"
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -f supabase/seed.sql
```

Every browser suite mutates the tree and the accounts, so **repeat steps 2–3
between runs**. A `reset` shell function around those two blocks pays for itself
immediately.

## Running

```bash
# database behaviour and permissions
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -f tests/db.paths-and-plans.test.sql
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -f tests/db.hierarchy.test.sql
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -f tests/db.rls-and-search.test.sql
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -f tests/db.permissions.test.sql

# markdown security (renders through the real pipeline in Node)
npx esbuild tests/xss.test.jsx --bundle --format=cjs --platform=node \
  --jsx=automatic --outfile=/tmp/xss.cjs && node /tmp/xss.cjs

# browser suites
node tests/postgrest-shim.mjs &                    # :54321
printf 'VITE_SUPABASE_URL=http://localhost:54321\nVITE_SUPABASE_ANON_KEY=local-test-anon-key\nVITE_SITE_URL=http://localhost:4173\nVITE_SITE_NAME=Engineering Docs\n' > .env
npm run build && npx vite preview --port 4173 &
npm install playwright
node tests/public.e2e.mjs
node tests/authoring.e2e.mjs      # reset the database first
node tests/multiuser.e2e.mjs      # reset the database first
```

`db.permissions.test.sql` creates its own accounts, so it expects a database with
the migrations applied but **no** accounts yet; run it before the seed, then run
the seed, then the rest of the file. The header comment inside spells out the
order.

The browser suites assume `playwright` is installed and a Chromium binary is
available; set `executablePath` at the top of each file if yours is not at
`/opt/pw-browsers/chromium`.
