# Tests

These run entirely offline against a **local PostgreSQL** plus a small stand-in for
Supabase's HTTP layer. No cloud project, no credentials, no network.

```
tests/
├── local-harness.sql            fake `auth` schema + anon/authenticated roles
├── postgrest-shim.mjs           ~150-line PostgREST/GoTrue stand-in on :54321
├── db.paths-and-plans.test.sql  path materialisation, get_page, EXPLAIN plans
├── db.hierarchy.test.sql        rename/move cascades, cycle guards, slug rules
├── db.rls-and-search.test.sql   RLS per role, delete semantics, full-text search
├── xss.test.jsx                 18 XSS payloads + 12 feature checks
├── public.e2e.mjs               36 browser checks, public site
└── admin.e2e.mjs                20 browser checks, admin dashboard
```

The shim is a **test fixture, not production code**. It translates the handful of requests
this app makes into SQL and runs each one as the `anon` or `authenticated` role, so the
browser tests exercise the real RLS policies rather than mocks.

## Setup

```bash
# 1. a local Postgres with a non-C collation (matching Supabase)
initdb -D /tmp/pgdata -U postgres --locale=en_US.UTF-8 -E UTF8
pg_ctl -D /tmp/pgdata -o "-k /tmp/pgrun -p 5433" -l /tmp/pg.log start

# 2. harness + migrations + seed
for f in tests/local-harness.sql supabase/migrations/*.sql supabase/seed.sql; do
  psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f"
done

# 3. an admin account for the browser tests
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -c "
  insert into auth.users (id,email)
    values ('11111111-1111-1111-1111-111111111111','admin@example.com');
  update public.profiles set role='admin'
    where id='11111111-1111-1111-1111-111111111111';"
```

## Running

```bash
# database behaviour
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -f tests/db.paths-and-plans.test.sql
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -f tests/db.hierarchy.test.sql
psql -h /tmp/pgrun -p 5433 -U postgres -d postgres -f tests/db.rls-and-search.test.sql

# markdown security (renders through the real pipeline in Node)
npx esbuild tests/xss.test.jsx --bundle --format=cjs --platform=node \
  --jsx=automatic --outfile=/tmp/xss.cjs && node /tmp/xss.cjs

# browser suites
node tests/postgrest-shim.mjs &                    # :54321
printf 'VITE_SUPABASE_URL=http://localhost:54321\nVITE_SUPABASE_ANON_KEY=local-test-anon-key\nVITE_SITE_URL=http://localhost:4173\nVITE_SITE_NAME=Engineering Docs\n' > .env
npm run build && npx vite preview --port 4173 &
npm install playwright && node tests/public.e2e.mjs && node tests/admin.e2e.mjs
```

The browser suites assume `playwright` is installed and a Chromium binary is available;
set `executablePath` at the top of each file if yours is not at `/opt/pw-browsers/chromium`.

Reset the database between runs of `db.hierarchy.test.sql` and `admin.e2e.mjs` — both
mutate the tree on purpose.
