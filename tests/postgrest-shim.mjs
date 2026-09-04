/**
 * Minimal PostgREST + GoTrue stand-in for local end-to-end testing ONLY.
 *
 * It translates the requests this app actually makes into SQL against a
 * local PostgreSQL, running each one as `anon` or `authenticated` with
 * the caller's uid in request.jwt.claim.sub — so the browser tests
 * exercise the REAL Row Level Security policies rather than mocks.
 *
 * Not production code, and not a complete PostgREST.
 */
import http from 'node:http';
import pg from 'pg';

const pool = new pg.Pool({ host: '/tmp/pgrun', port: 5433, user: 'postgres', database: 'postgres' });
const ANON_KEY = 'local-test-anon-key';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'content-range',
};
const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function claims(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || token === ANON_KEY) return null;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch { return null; }
}

function mintSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: user.id, email: user.email, role: 'authenticated',
                    aud: 'authenticated', iat: now, exp: now + 3600 };
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`,
    token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'r',
    user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated',
            app_metadata: {}, user_metadata: {}, identities: [{ id: user.id }] },
  };
}

/** Run one statement as the caller's Postgres role, with RLS in force. */
async function asCaller(fn, jwt) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (jwt?.sub) {
      await client.query('set local role authenticated');
      await client.query(`set local request.jwt.claim.sub = '${jwt.sub}'`);
    } else {
      await client.query('set local role anon');
    }
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const body = (req) => new Promise((r) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {}));
});

/** PostgREST filter syntax -> a WHERE fragment. Supports eq/neq/in and or=(). */
function buildWhere(params, out) {
  const where = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;

    if (k === 'or') {
      const inner = v.replace(/^\(|\)$/g, '').split(',').map((clause) => {
        const [col, op, ...rest] = clause.split('.');
        out.push(rest.join('.'));
        return `${col} ${op === 'eq' ? '=' : '<>'} $${out.length}`;
      });
      where.push(`(${inner.join(' or ')})`);
      continue;
    }

    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    if (op === 'eq')  { out.push(val); where.push(`${k} = $${out.length}`); }
    if (op === 'neq') { out.push(val); where.push(`${k} <> $${out.length}`); }
    if (op === 'in')  { out.push(val.replace(/^\(|\)$/g, '').split(',')); where.push(`${k} = any($${out.length})`); }
  }
  return where;
}

/** Rewrite an embedded resource in `select` into a lateral join. */
function expandSelect(select) {
  const embed = select.match(/([a-z_]+)!([a-z_]+)\(([^)]*)\)/);
  if (!embed) return { cols: select.split(',').map((c) => c.trim()).join(', '), join: '' };
  const [full, table, , fields] = embed;
  const cols = select.split(',').map((c) => c.trim()).filter((c) => !c.startsWith(full.split('(')[0]));
  return {
    cols: `${cols.join(', ')}, (select json_build_object(${fields.split(',')
      .map((f) => `'${f.trim()}', e.${f.trim()}`).join(', ')})
      from public.${table} e where e.id = public.topics.owner_id) as ${table}`,
    join: '',
  };
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // ---------------- GoTrue ----------------
    if (p.startsWith('/auth/v1/signup')) {
      const { email, password, data } = await body(req);
      if (!password || password.length < 6) {
        return send(res, 422, { message: 'Password should be at least 6 characters', code: 'weak_password' });
      }
      const dup = await pool.query('select id from auth.users where email = $1', [email]);
      if (dup.rowCount) {
        // GoTrue's behaviour: no error, but an empty identities array.
        return send(res, 200, { user: { id: dup.rows[0].id, email, identities: [] }, session: null });
      }
      const ins = await pool.query(
        `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id, email`,
        [email, JSON.stringify(data || {})]);
      return send(res, 200, mintSession(ins.rows[0]));
    }

    if (p.startsWith('/auth/v1/token')) {
      const { email } = await body(req);
      const u = await pool.query('select id, email from auth.users where email = $1', [email]);
      if (!u.rowCount) {
        return send(res, 400, { message: 'Invalid login credentials', error_code: 'invalid_credentials' });
      }
      return send(res, 200, mintSession(u.rows[0]));
    }

    if (p.startsWith('/auth/v1/logout')) return send(res, 204, {});
    if (p.startsWith('/auth/v1/')) return send(res, 200, {});

    // ---------------- RPC ----------------
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.split('/').pop();
      const args = await body(req);
      const keys = Object.keys(args);
      // `select * from fn(...)` is what PostgREST does: it expands a
      // set-returning function into rows instead of composite text.
      const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      const out = await asCaller((c) => c.query(sql, keys.map((k) => args[k])), claims(req));
      const cols = out.fields.map((f) => f.name);
      if (cols.length === 1 && cols[0] === fn) {
        return send(res, 200, out.rows.length === 1 ? out.rows[0][fn] : out.rows.map((r) => r[fn]));
      }
      return send(res, 200, out.rows);
    }

    // ---------------- table writes ----------------
    if (p.startsWith('/rest/v1/') && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const table = p.replace('/rest/v1/', '');
      const payload = await body(req);
      const params = [];
      const where = buildWhere(url.searchParams, params);
      let sql;
      if (req.method === 'POST') {
        const cols = Object.keys(payload);
        const vals = cols.map((c) => { params.push(payload[c]); return `$${params.length}`; });
        sql = `insert into public.${table} (${cols.join(',')}) values (${vals.join(',')}) returning *`;
      } else if (req.method === 'PATCH') {
        const sets = Object.keys(payload).map((c) => { params.push(payload[c]); return `${c} = $${params.length}`; });
        sql = `update public.${table} set ${sets.join(', ')}`
            + (where.length ? ` where ${where.join(' and ')}` : '') + ' returning *';
      } else {
        sql = `delete from public.${table}`
            + (where.length ? ` where ${where.join(' and ')}` : '') + ' returning *';
      }
      const out = await asCaller((c) => c.query(sql, params), claims(req));
      return send(res, 200, out.rows);
    }

    // ---------------- table reads ----------------
    if (p.startsWith('/rest/v1/')) {
      const table = p.replace('/rest/v1/', '');
      const select = url.searchParams.get('select') || '*';

      // The redirect lookup uses an embedded resource; special-case it.
      if (table === 'topic_redirects' && select.includes('topics')) {
        const oldPath = (url.searchParams.get('old_path') || '').replace('eq.', '');
        const out = await asCaller((c) => c.query(
          `select r.topic_id,
                  json_build_object('path', t.path, 'effective_visibility', t.effective_visibility) as topics
           from public.topic_redirects r join public.topics t on t.id = r.topic_id
           where r.old_path = $1 limit 1`, [oldPath]), claims(req));
        return send(res, 200, out.rows);
      }

      const params = [];
      const where = buildWhere(url.searchParams, params);
      const order = url.searchParams.get('order');
      const limit = url.searchParams.get('limit');
      const { cols } = expandSelect(select);

      const sql = `select ${cols} from public.${table}`
        + (where.length ? ` where ${where.join(' and ')}` : '')
        + (order ? ` order by ${order.split('.')[0]} ${order.includes('desc') ? 'desc' : 'asc'}` : '')
        + (limit ? ` limit ${Number(limit)}` : '');

      const out = await asCaller((c) => c.query(sql, params), claims(req));
      return send(res, 200, out.rows);
    }

    send(res, 404, { message: 'not found' });
  } catch (err) {
    send(res, 400, { message: err.message, code: err.code, details: err.detail, hint: err.hint });
  }
}).listen(54321, () => console.log('shim on 54321'));
