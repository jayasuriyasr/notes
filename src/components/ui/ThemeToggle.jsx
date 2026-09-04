import { useTheme } from '../../hooks/useTheme';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: '☀' },
  { value: 'system', label: 'System', icon: '◐' },
  { value: 'dark', label: 'Dark', icon: '☾' },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={theme === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => setTheme(o.value)}
          className={`rounded-md px-2 py-1 text-sm leading-none transition ${
            theme === o.value
              ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-500 dark:hover:text-zinc-200'
          }`}
        >
          <span aria-hidden="true">{o.icon}</span>
        </button>
      ))}
    </div>
  );
}
