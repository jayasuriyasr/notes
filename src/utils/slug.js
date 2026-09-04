/**
 * Client-side slugify. Deliberately mirrors public.slugify() in SQL.
 *
 * This exists for INSTANT FEEDBACK ONLY - so the admin sees the URL
 * update as they type the title. The database runs its own copy on every
 * write and a CHECK constraint rejects anything malformed, so a bug here
 * produces a bad preview, never bad data.
 */
export function slugify(input) {
  return String(input ?? '')
    .normalize('NFKD')             // decompose accents: é -> e + combining acute
    .replace(/[̀-ͯ]/g, '') // drop the combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isValidSlug = (s) => SLUG_PATTERN.test(s || '');

/** Root-level slugs that would collide with application routes. */
export const RESERVED_ROOT_SLUGS = new Set([
  'admin', 'login', 'logout', 'api', 'assets', 'static',
  'search', 'sitemap', 'robots', '404', '_app', 'favicon',
]);

/** Normalise a URL path: no leading/trailing slashes, no empty segments. */
export function normalizePath(path) {
  return String(path ?? '')
    .split('/')
    .filter(Boolean)
    .join('/');
}

export const pathToHref = (path) => `/${normalizePath(path)}`;
