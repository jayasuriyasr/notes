/**
 * Minimal PostgREST stand-in for local end-to-end testing ONLY.
 * Translates the handful of requests this app makes into SQL against the
 * local Postgres, running each one as the `anon` role so RLS applies.
 */
import http from 'node:http';
import pg from 'pg';

const pool = new pg.Pool({ host: '/tmp/pgrun', port: 5433, user: 'postgres', database: 'postgres' });

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

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function claims(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  if (!token || token === 'local-test-anon-key') return null;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch { return null; }
}

async function asAnon(fn, jwt) {
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

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // ---- auth: mint an unsigned JWT; supabase-js does not verify signatures ----
    if (p.startsWith('/auth/v1/token')) {
      const now = Math.floor(Date.now() / 1000);
      const payload = { sub: ADMIN_ID, role: 'authenticated', exp: now + 3600, iat: now,
                        email: 'admin@example.com', aud: 'authenticated' };
      const access_token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
      return send(res, 200, {
        access_token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
        refresh_token: 'r', user: { id: ADMIN_ID, email: 'admin@example.com', aud: 'authenticated',
                                    role: 'authenticated', app_metadata: {}, user_metadata: {} },
      });
    }
    if (p.startsWith('/auth/v1/logout')) return send(res, 204, {});
    if (p.startsWith('/auth/v1/')) return send(res, 200, {});

    // ---- rpc ----
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.split('/').pop();
      const body = await new Promise((r) => {
        let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {}));
      });
      const keys = Object.keys(body);
      // `select * from fn(...)` is what PostgREST does: it expands a
      // set-returning function into real rows instead of composite text.
      const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      const out = await asAnon((c) => c.query(sql, keys.map((k) => body[k])), claims(req));
      const cols = out.fields.map((f) => f.name);
      if (cols.length === 1 && cols[0] === fn) {
        return send(res, 200, out.rows.length === 1 ? out.rows[0][fn] : out.rows.map((r) => r[fn]));
      }
      return send(res, 200, out.rows);
    }

    // ---- table writes ----
    if (p.startsWith('/rest/v1/') && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const table = p.replace('/rest/v1/', '');
      const body = await new Promise((r) => {
        let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {}));
      });
      const where = [], params = [];
      for (const [k, v] of url.searchParams) {
        if (k === 'select') continue;
        const [op, ...rest] = v.split('.');
        if (op === 'eq') { params.push(rest.join('.')); where.push(`${k} = $${params.length}`); }
      }
      let sql;
      if (req.method === 'POST') {
        const cols = Object.keys(body);
        const vals = cols.map((c) => { params.push(body[c]); return `$${params.length}`; });
        sql = `insert into public.${table} (${cols.join(',')}) values (${vals.join(',')}) returning *`;
      } else if (req.method === 'PATCH') {
        const sets = Object.keys(body).map((c) => { params.push(body[c]); return `${c} = $${params.length}`; });
        sql = `update public.${table} set ${sets.join(', ')}` + (where.length ? ` where ${where.join(' and ')}` : '') + ' returning *';
      } else {
        sql = `delete from public.${table}` + (where.length ? ` where ${where.join(' and ')}` : '') + ' returning *';
      }
      const out = await asAnon((c) => c.query(sql, params), claims(req));
      return send(res, 200, out.rows);
    }

    // ---- table reads ----
    if (p.startsWith('/rest/v1/')) {
      const table = p.replace('/rest/v1/', '');
      const select = url.searchParams.get('select') || '*';

      // the redirect query uses an embedded resource; special-case it
      if (table === 'topic_redirects' && select.includes('topics')) {
        const oldPath = (url.searchParams.get('old_path') || '').replace('eq.', '');
        const out = await asAnon((c) =>
          c.query(
            `select r.topic_id, json_build_object('path', t.path, 'status', t.status) as topics
             from public.topic_redirects r join public.topics t on t.id = r.topic_id
             where r.old_path = $1 limit 1`, [oldPath]), claims(req));
        return send(res, 200, out.rows);
      }

      const where = [], params = [];
      for (const [k, v] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
        const [op, ...rest] = v.split('.');
        const val = rest.join('.');
        if (op === 'eq') { params.push(val); where.push(`${k} = $${params.length}`); }
        if (op === 'in') { params.push(val.replace(/^\(|\)$/g, '').split(',')); where.push(`${k} = any($${params.length})`); }
      }
      const order = url.searchParams.get('order');
      const limit = url.searchParams.get('limit');

      const sql =
        `select ${select.split(',').map((s) => s.trim()).join(', ')} from public.${table}` +
        (where.length ? ` where ${where.join(' and ')}` : '') +
        (order ? ` order by ${order.split('.')[0]} ${order.includes('desc') ? 'desc' : 'asc'}` : '') +
        (limit ? ` limit ${Number(limit)}` : '');

      const out = await asAnon((c) => c.query(sql, params), claims(req));
      return send(res, 200, out.rows);
    }

    send(res, 404, { message: 'not found' });
  } catch (err) {
    send(res, 400, { message: err.message, code: err.code, details: err.detail });
  }
}).listen(54321, () => console.log('shim on 54321'));
