import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearch } from '../../hooks/useTopics';
import { useDebounced } from '../../hooks/useDebounced';
import { parseHighlight } from '../../utils/markdown';
import { Spinner } from '../ui/Spinner';
import { ErrorState } from '../ui/ErrorState';

/**
 * Renders a ts_headline result WITHOUT ever touching innerHTML.
 *
 * search_topics() returns matches wrapped in `<<...>>` sentinels rather
 * than <mark> tags, precisely so this can be done. ts_headline does not
 * escape the document it highlights, so asking Postgres for HTML and
 * injecting it would pipe raw page content straight into the DOM.
 */
function Highlighted({ text }) {
  return (
    <>
      {parseHighlight(text).map((part, i) =>
        part.highlight ? (
          <mark key={i} className="rounded bg-brand-100 px-0.5 text-brand-900 dark:bg-brand-500/25 dark:text-brand-100">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

export function SearchDialog({ open, onClose }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const debounced = useDebounced(query, 180);
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const { data: results = [], isFetching, error } = useSearch(debounced);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      // Wait a frame so the input exists before focusing it.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setCursor(0), [debounced]);

  const go = useCallback(
    (path) => {
      onClose();
      navigate(`/${path}`);
    },
    [navigate, onClose],
  );

  const onKeyDown = (e) => {
    if (e.key === 'Escape') return onClose();
    if (!results.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[cursor];
      if (hit) go(hit.path);
    }
  };

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, results]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-900/40 p-4 pt-[10vh] backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search documentation"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl
                   dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800">
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-400">
            <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.08 3.08a1 1 0 01-1.42 1.42l-3.08-3.08A7 7 0 012 9z" clipRule="evenodd" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documentation…"
            aria-label="Search documentation"
            className="w-full bg-transparent py-3.5 text-sm outline-none placeholder:text-zinc-400"
          />
          {isFetching && <Spinner className="h-4 w-4" />}
          <kbd className="hidden rounded border border-zinc-200 px-1.5 py-0.5 text-[10px] text-zinc-400 sm:block dark:border-zinc-700">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="thin-scrollbar max-h-[55vh] overflow-y-auto p-2">
          {error && <ErrorState compact error={error} />}

          {!error && debounced.trim().length >= 2 && !isFetching && results.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-zinc-500">
              No results for <span className="font-medium text-zinc-700 dark:text-zinc-300">“{debounced}”</span>
            </p>
          )}

          {debounced.trim().length < 2 && (
            <p className="px-3 py-8 text-center text-sm text-zinc-400">
              Type at least two characters. Quotes match a phrase; a leading minus excludes a word.
            </p>
          )}

          <ul>
            {results.map((hit, i) => (
              <li key={hit.id}>
                <button
                  type="button"
                  data-active={i === cursor}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(hit.path)}
                  className={`w-full rounded-lg px-3 py-2.5 text-left transition ${
                    i === cursor ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                  }`}
                >
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{hit.title}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-zinc-400">/{hit.path}</p>
                  {hit.headline && (
                    <p className="mt-1 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">
                      <Highlighted text={hit.headline} />
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default SearchDialog;
