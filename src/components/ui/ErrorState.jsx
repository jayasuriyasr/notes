import { Link } from 'react-router-dom';
import { ERROR_KIND } from '../../lib/errors';

/**
 * One component for every failure the app can surface (§21).
 *
 * The message comes from lib/errors.js, which has already translated the
 * SQLSTATE or HTTP status into something actionable. This component only
 * decides the framing and what to offer next — because "what can I do
 * about it" is the part users actually need.
 */
const PRESET = {
  [ERROR_KIND.NOT_FOUND]: {
    code: '404',
    title: 'Page not found',
    hint: 'The page may have been moved, renamed or unpublished.',
  },
  [ERROR_KIND.UNAUTHENTICATED]: {
    code: '401',
    title: 'Sign-in required',
    hint: 'Your session has ended.',
  },
  [ERROR_KIND.FORBIDDEN]: {
    code: '403',
    title: 'Not permitted',
    hint: 'This action needs administrator access.',
  },
  [ERROR_KIND.CONFLICT]: { code: '409', title: 'Conflict', hint: null },
  [ERROR_KIND.VALIDATION]: { code: '422', title: 'Invalid input', hint: null },
  [ERROR_KIND.NETWORK]: {
    code: '', title: 'Connection problem',
    hint: 'The database could not be reached. It may be a network blip, or the Supabase project may be paused.',
  },
  [ERROR_KIND.SERVER]: { code: '500', title: 'Something went wrong', hint: null },
};

export function ErrorState({ error, kind, title, message, onRetry, compact = false }) {
  const resolvedKind = kind || error?.kind || ERROR_KIND.SERVER;
  const preset = PRESET[resolvedKind] ?? PRESET[ERROR_KIND.SERVER];
  const text = message || error?.message || preset.hint;

  if (compact) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm
                   text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
      >
        <span aria-hidden="true" className="mt-0.5 font-bold">!</span>
        <div className="flex-1">
          <p className="font-medium">{title || preset.title}</p>
          {text && <p className="mt-0.5 opacity-90">{text}</p>}
        </div>
        {onRetry && (
          <button type="button" onClick={onRetry} className="shrink-0 font-medium underline underline-offset-2">
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div role="alert" className="mx-auto max-w-lg py-20 text-center">
      {preset.code && (
        <p className="font-mono text-6xl font-bold tracking-tight text-zinc-200 dark:text-zinc-800">
          {preset.code}
        </p>
      )}
      <h1 className="mt-4 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
        {title || preset.title}
      </h1>
      {text && <p className="mt-3 text-zinc-600 dark:text-zinc-400">{text}</p>}

      <div className="mt-8 flex items-center justify-center gap-3">
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Try again
          </button>
        )}
        <Link
          to="/"
          className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700
                     hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Back to documentation
        </Link>
      </div>
    </div>
  );
}

export default ErrorState;
