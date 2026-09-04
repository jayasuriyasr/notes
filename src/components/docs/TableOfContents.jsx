import { useEffect, useState } from 'react';
import { HEADING_ID_PREFIX } from '../markdown/sanitizeSchema';

/**
 * On-page contents with scroll spy.
 *
 * IntersectionObserver rather than a scroll listener: the browser does
 * the work off the main thread and there is no per-frame handler to
 * throttle.
 *
 * Note the HEADING_ID_PREFIX. rehype-sanitize rewrites every id to
 * `user-content-*` as DOM-clobbering protection, so the anchors we link
 * to must carry the same prefix or every link in this list silently
 * scrolls nowhere.
 */
export function TableOfContents({ headings = [] }) {
  const [activeId, setActiveId] = useState(null);

  useEffect(() => {
    if (!headings.length) return;

    const elements = headings
      .map((h) => document.getElementById(`${HEADING_ID_PREFIX}${h.id}`))
      .filter(Boolean);
    if (!elements.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      // Top quarter of the viewport: a heading counts as "current" once it
      // reaches the reading position, not when it first peeks in at the bottom.
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );

    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length < 2) return null;

  return (
    <nav aria-label="On this page" className="text-sm">
      <p className="mb-3 font-semibold text-zinc-900 dark:text-zinc-100">On this page</p>
      <ul className="space-y-1 border-l border-zinc-200 dark:border-zinc-800">
        {headings.map((h) => {
          const anchor = `${HEADING_ID_PREFIX}${h.id}`;
          const isActive = activeId === anchor;
          return (
            <li key={h.id} style={{ paddingLeft: `${(h.level - 2) * 12}px` }}>
              <a
                href={`#${anchor}`}
                className={`-ml-px block border-l py-1 pl-3 transition ${
                  isActive
                    ? 'border-brand-500 font-medium text-brand-600 dark:text-brand-400'
                    : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200'
                }`}
              >
                {h.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default TableOfContents;
