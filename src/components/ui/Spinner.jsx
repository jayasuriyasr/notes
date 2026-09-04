export function Spinner({ className = 'h-5 w-5' }) {
  return (
    <svg className={`animate-spin text-zinc-400 ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z" />
    </svg>
  );
}

/**
 * Skeleton rather than a spinner for the article body.
 * A shape that matches the incoming content keeps the layout from
 * jumping when it arrives, which is both calmer to look at and better
 * for Cumulative Layout Shift.
 */
export function ArticleSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-hidden="true">
      <div className="h-8 w-2/3 rounded bg-zinc-200 dark:bg-zinc-800" />
      <div className="h-4 w-full rounded bg-zinc-100 dark:bg-zinc-800/60" />
      <div className="h-4 w-11/12 rounded bg-zinc-100 dark:bg-zinc-800/60" />
      <div className="h-4 w-4/5 rounded bg-zinc-100 dark:bg-zinc-800/60" />
      <div className="h-32 w-full rounded-lg bg-zinc-100 dark:bg-zinc-800/60" />
      <div className="h-4 w-full rounded bg-zinc-100 dark:bg-zinc-800/60" />
      <div className="h-4 w-3/4 rounded bg-zinc-100 dark:bg-zinc-800/60" />
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <div className="animate-pulse space-y-2 py-2" aria-hidden="true">
      {[80, 60, 70, 50, 65, 45].map((w, i) => (
        <div key={i} className="h-4 rounded bg-zinc-100 dark:bg-zinc-800/60" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
