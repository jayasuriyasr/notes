import { useEffect, useRef } from 'react';

/**
 * Minimal accessible dialog: Escape closes, focus moves in on open and
 * returns to the trigger on close, and focus is trapped while open.
 *
 * Written by hand rather than pulled from a library because it is 60
 * lines and this is the only dialog pattern the app needs. A headless UI
 * dependency would be larger than the feature.
 */
export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = panelRef.current?.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    const body = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      panelRef.current?.querySelector('input, select, textarea, button')?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = body;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${width} rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900`}
      >
        <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <h2 className="font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export const btn = {
  primary:
    'rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60',
  danger:
    'rounded-lg bg-red-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-60',
  ghost:
    'rounded-lg border border-zinc-300 px-3.5 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800',
};

export default Modal;
