/**
 * Build-time sitemap.xml + robots.txt generator.
 *
 * WHY BUILD TIME AND NOT A SERVERLESS FUNCTION
 * A pure Vite SPA on Vercel has no server runtime of its own, and adding
 * one just to serve two text files would mean adding a whole backend
 * framework. Generating them during `vite build` needs nothing extra and
 * cannot fail at request time.
 *
 * The cost: the sitemap reflects the content as of the last deploy. For a
 * docs site that is usually fine — and when it is not, the fix is one
 * Supabase Database Webhook on `topics` pointing at a Vercel Deploy Hook,
 * so publishing a page triggers a rebuild. See ARCHITECTURE.md §17.
 *
 * This script NEVER fails the build. A missing .env during a fresh clone
 * produces a minimal sitemap and a warning, not a broken deploy.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'dist';

// Vite has already loaded .env into its own env; read it directly here
// because this script runs as a separate Node process after the build.
function readEnv() {
  const env = { ...process.env };
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const env = readEnv();
const SITE_URL = (env.VITE_SITE_URL || '').replace(/\/$/, '');
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const ANON_KEY = env.VITE_SUPABASE_ANON_KEY;

const xmlEscape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function fetchPublishedPaths() {
  if (!SUPABASE_URL || !ANON_KEY) return null;

  // The anon key is all that is needed: RLS already restricts this to
  // pages an anonymous visitor can read, which is exactly what belongs
  // in a sitemap. There is no reason for a build script to hold the
  // service-role key — and with a multi-user site, holding it would mean
  // publishing every member's private pages to Google.
  const url =
    `${SUPABASE_URL}/rest/v1/topics` +
    `?select=path,updated_at&effective_visibility=neq.private&order=path.asc`;

  const res = await fetch(url, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase responded ${res.status} ${res.statusText}`);
  return res.json();
}

function sitemapXml(rows) {
  const urls = [
    { loc: `${SITE_URL}/`, priority: '1.0', lastmod: null },
    ...rows.map((r) => ({
      loc: `${SITE_URL}/${r.path}`,
      priority: (0.9 - Math.min(0.4, (r.path.split('/').length - 1) * 0.1)).toFixed(1),
      lastmod: r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : null,
    })),
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) =>
      [
        '  <url>',
        `    <loc>${xmlEscape(u.loc)}</loc>`,
        u.lastmod ? `    <lastmod>${u.lastmod}</lastmod>` : null,
        '    <changefreq>weekly</changefreq>',
        `    <priority>${u.priority}</priority>`,
        '  </url>',
      ].filter(Boolean).join('\n'),
    ),
    '</urlset>',
    '',
  ].join('\n');
}

const robotsTxt = () =>
  [
    'User-agent: *',
    'Allow: /',
    // Nothing secret lives here — RLS makes an unauthenticated request
    // to any of these useless — but there is no reason to spend crawl
    // budget on routes that render a sign-in prompt.
    'Disallow: /dashboard',
    'Disallow: /login',
    'Disallow: /register',
    '',
    SITE_URL ? `Sitemap: ${SITE_URL}/sitemap.xml` : '',
    '',
  ].filter(Boolean).join('\n');

try {
  if (!SITE_URL) {
    console.warn('[sitemap] VITE_SITE_URL is not set — skipping sitemap generation.');
    process.exit(0);
  }

  const rows = await fetchPublishedPaths();
  if (rows === null) {
    console.warn('[sitemap] Supabase credentials not available — writing robots.txt only.');
    writeFileSync(join(OUT, 'robots.txt'), robotsTxt());
    process.exit(0);
  }

  writeFileSync(join(OUT, 'sitemap.xml'), sitemapXml(rows));
  writeFileSync(join(OUT, 'robots.txt'), robotsTxt());
  console.log(`[sitemap] wrote ${rows.length + 1} URLs to dist/sitemap.xml`);
} catch (err) {
  // Never fail the deploy over a sitemap.
  console.warn(`[sitemap] skipped: ${err.message}`);
  try {
    writeFileSync(join(OUT, 'robots.txt'), robotsTxt());
  } catch { /* dist may not exist if the build itself failed */ }
}
