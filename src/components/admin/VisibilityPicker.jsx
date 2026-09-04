/**
 * The three-way access control, in the words a person would use.
 *
 * The labels avoid the database's vocabulary on purpose. Nobody thinks
 * "set effective_visibility to collaborative" — they think "let anyone
 * edit this". The stored values stay private/public/collaborative; only
 * the presentation changes.
 */
export const VISIBILITY = {
  private: {
    value: 'private',
    label: 'Private',
    short: 'Private',
    icon: '🔒',
    summary: 'Only you and administrators',
    detail: 'Nobody else can open it, find it in search, or see it in the navigation.',
    tone: 'zinc',
  },
  public: {
    value: 'public',
    label: 'Anyone can view',
    short: 'Public',
    icon: '👁',
    summary: 'Everyone reads · only you edit',
    detail: 'Published on the site for visitors who are not signed in. You stay the only editor.',
    tone: 'emerald',
  },
  collaborative: {
    value: 'collaborative',
    label: 'Anyone can edit',
    short: 'Shared',
    icon: '✎',
    summary: 'Everyone reads · any signed-in member edits',
    detail:
      'Other members can change the title and text, and add pages inside it. Only you can rename it, move it, change this setting, or delete it.',
    tone: 'sky',
  },
};

const TONE = {
  zinc: 'border-zinc-300 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300',
  emerald:
    'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-500/10 dark:text-emerald-300',
  sky: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800/60 dark:bg-sky-500/10 dark:text-sky-300',
};

/** Small inline badge, used in trees and page headers. */
export function VisibilityBadge({ value, inherited = false, className = '' }) {
  const v = VISIBILITY[value] ?? VISIBILITY.private;
  return (
    <span
      title={inherited ? `${v.summary} — inherited from a parent section` : v.summary}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]
                  font-semibold uppercase tracking-wide ${TONE[v.tone]} ${className}`}
    >
      <span aria-hidden="true">{v.icon}</span>
      {v.short}
      {inherited && <span className="font-normal normal-case opacity-70">(inherited)</span>}
    </span>
  );
}

/**
 * The picker itself.
 *
 * `inheritedPrivate` is the case worth handling carefully: when the
 * parent section is private, this page is private no matter what is
 * chosen here. Rather than disabling the control — which leaves people
 * wondering why — it stays usable and says plainly what will happen when
 * the parent is opened up again.
 */
export function VisibilityPicker({ value, onChange, inheritedPrivate = false, disabled = false }) {
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Who can see this?</legend>

      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {Object.values(VISIBILITY).map((v) => {
          const active = value === v.value;
          return (
            <label
              key={v.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 transition
                ${active
                  ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:bg-brand-500/10'
                  : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-700 dark:hover:border-zinc-600'}
                ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="visibility"
                  value={v.value}
                  checked={active}
                  onChange={() => onChange(v.value)}
                  className="h-4 w-4 accent-brand-600"
                />
                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  <span aria-hidden="true" className="mr-1">{v.icon}</span>
                  {v.label}
                </span>
              </span>
              <span className="pl-6 text-xs text-zinc-500 dark:text-zinc-400">{v.summary}</span>
            </label>
          );
        })}
      </div>

      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        {VISIBILITY[value]?.detail}
      </p>

      {inheritedPrivate && (
        <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900
                      dark:border-amber-800/60 dark:bg-amber-500/10 dark:text-amber-200">
          <strong>This page is private regardless</strong>, because a section above it is private. A private
          section hides everything inside it. The setting you choose here takes effect the moment that
          section is opened up.
        </p>
      )}
    </fieldset>
  );
}

export default VisibilityPicker;
