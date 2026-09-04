/**
 * Turns whatever Supabase/PostgREST threw into something a human can act on.
 *
 * Everything the database rejects arrives here as a PostgREST error with
 * a Postgres SQLSTATE. Mapping them centrally means the UI never has to
 * pattern-match on error strings, and a constraint added later surfaces
 * with a sane default instead of "[object Object]".
 */

export const ERROR_KIND = {
  NOT_FOUND: 'not_found',
  UNAUTHENTICATED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  CONFLICT: 'conflict',
  VALIDATION: 'validation',
  NETWORK: 'network',
  SERVER: 'server',
};

export class AppError extends Error {
  constructor(kind, message, { cause, detail } = {}) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.detail = detail;
    this.cause = cause;
  }
}

const CONSTRAINT_MESSAGES = {
  topics_path_key:
    'Another page already uses that URL. Pick a different slug, or move this page under a different parent.',
  topics_slug_format:
    'Slugs may contain lowercase letters, numbers and single hyphens only — for example "rate-limiter".',
  topics_reserved_root_slug:
    'That slug is reserved for the application itself. Choose another, or nest this page under a parent.',
  topics_depth_check: 'Pages can be nested at most 8 levels deep.',
  topics_status_check: 'Status must be either draft or published.',
  topics_title_length: 'The title must be between 1 and 200 characters.',
  topics_excerpt_length: 'The summary must be 320 characters or fewer.',
  profiles_role_check: 'Unknown role.',
};

export function normalizeError(error) {
  if (!error) return null;
  if (error instanceof AppError) return error;

  // Fetch failed entirely: offline, DNS, CORS, project paused.
  if (error.message === 'Failed to fetch' || error.name === 'TypeError') {
    return new AppError(
      ERROR_KIND.NETWORK,
      'Could not reach the server. Check your connection and try again.',
      { cause: error },
    );
  }

  const code = error.code;
  const raw = error.message || '';

  switch (code) {
    // ---- Postgres SQLSTATEs -----------------------------------------
    case '23505': {
      // unique_violation - find which constraint blew up
      const hit = Object.keys(CONSTRAINT_MESSAGES).find(
        (name) => raw.includes(name) || (error.details || '').includes(name),
      );
      return new AppError(ERROR_KIND.CONFLICT, hit ? CONSTRAINT_MESSAGES[hit] : 'That value is already taken.', {
        cause: error,
      });
    }
    case '23503': // foreign_key_violation
      return new AppError(
        ERROR_KIND.CONFLICT,
        raw.includes('topics_parent_id_fkey')
          ? 'This page still has sub-pages. Delete them first, or choose "delete this page and everything under it".'
          : 'That parent page no longer exists. Refresh and try again.',
        { cause: error },
      );
    case '23514': // check_violation - includes our cycle and depth guards
    case '22023': {
      const hit = Object.keys(CONSTRAINT_MESSAGES).find((name) => raw.includes(name));
      return new AppError(ERROR_KIND.VALIDATION, hit ? CONSTRAINT_MESSAGES[hit] : raw, { cause: error });
    }
    case '42501': // insufficient_privilege
      return new AppError(ERROR_KIND.FORBIDDEN, 'You do not have permission to do that.', { cause: error });
    case 'P0002':
      return new AppError(ERROR_KIND.NOT_FOUND, 'That page no longer exists.', { cause: error });

    // ---- PostgREST codes --------------------------------------------
    case 'PGRST301':
      return new AppError(ERROR_KIND.UNAUTHENTICATED, 'Your session expired. Please sign in again.', {
        cause: error,
      });
    case 'PGRST116':
      return new AppError(ERROR_KIND.NOT_FOUND, 'Not found.', { cause: error });
    case '42P01':
      return new AppError(
        ERROR_KIND.SERVER,
        'The database schema is missing. Have the migrations in supabase/migrations been applied?',
        { cause: error },
      );
    default:
      break;
  }

  // RLS rejection on INSERT/UPDATE arrives as this rather than a code.
  if (/row-level security/i.test(raw)) {
    return new AppError(
      ERROR_KIND.FORBIDDEN,
      'You do not have permission to change this content. Administrator access is required.',
      { cause: error },
    );
  }

  if (error.status === 401) {
    return new AppError(ERROR_KIND.UNAUTHENTICATED, 'Please sign in to continue.', { cause: error });
  }
  if (error.status === 403) {
    return new AppError(ERROR_KIND.FORBIDDEN, 'You do not have permission to do that.', { cause: error });
  }

  return new AppError(ERROR_KIND.SERVER, raw || 'Something went wrong. Please try again.', { cause: error });
}

/** Throw a normalized error if a Supabase response carries one. */
export function unwrap({ data, error }) {
  if (error) throw normalizeError(error);
  return data;
}
