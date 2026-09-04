import { Link } from 'react-router-dom';

/**
 * Previous / next in reading order.
 *
 * Both links are derived from the navigation tree already in the React
 * Query cache, so this component costs exactly zero additional requests.
 */
export function PrevNext({ prev, next }) {
  if (!prev && !next) return null;

  const card =
    'group flex flex-col gap-1 rounded-xl border border-zinc-200 p-4 transition ' +
    'hover:border-brand-400 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-brand-500/60 dark:hover:bg-zinc-900/50';

  return (
    <nav aria-label="Pagination" className="mt-16 grid gap-4 border-t border-zinc-200 pt-8 sm:grid-cols-2 dark:border-zinc-800">
      {prev ? (
        <Link to={`/${prev.path}`} className={card} rel="prev">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">← Previous</span>
          <span className="font-medium text-zinc-800 group-hover:text-brand-600 dark:text-zinc-200 dark:group-hover:text-brand-400">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}

      {next && (
        <Link to={`/${next.path}`} className={`${card} sm:text-right`} rel="next">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">Next →</span>
          <span className="font-medium text-zinc-800 group-hover:text-brand-600 dark:text-zinc-200 dark:group-hover:text-brand-400">
            {next.title}
          </span>
        </Link>
      )}
    </nav>
  );
}

export default PrevNext;
