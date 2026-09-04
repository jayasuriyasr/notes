import { useRef, useCallback, useState } from 'react';
import { MarkdownRenderer } from '../markdown/MarkdownRenderer';

/**
 * Split-pane Markdown editor.
 *
 *   Desktop : source and preview side by side.
 *   Mobile  : tabs, because two 45%-wide columns are useless on a phone.
 *
 * The preview is the SAME MarkdownRenderer the public page uses — same
 * plugins, same sanitiser, same components. If they were separate
 * implementations the preview would eventually lie about what readers
 * see, which is the one thing a preview must never do.
 */

const TOOLBAR = [
  { label: 'H2',  title: 'Heading',      prefix: '## ',    suffix: '',    block: true },
  { label: 'B',   title: 'Bold',         prefix: '**',     suffix: '**',  className: 'font-bold' },
  { label: 'I',   title: 'Italic',       prefix: '_',      suffix: '_',   className: 'italic' },
  { label: '</>', title: 'Inline code',  prefix: '`',      suffix: '`',   className: 'font-mono text-xs' },
  { label: '{ }', title: 'Code block',   prefix: '```\n',  suffix: '\n```', block: true, className: 'font-mono text-xs' },
  { label: '🔗',  title: 'Link',         prefix: '[',      suffix: '](https://)' },
  { label: '•',   title: 'Bullet list',  prefix: '- ',     suffix: '',    block: true },
  { label: '1.',  title: 'Numbered list',prefix: '1. ',    suffix: '',    block: true },
  { label: '❝',   title: 'Quote',        prefix: '> ',     suffix: '',    block: true },
  { label: '▦',   title: 'Table',        prefix: '| Column | Column |\n| --- | --- |\n| ', suffix: ' |  |', block: true },
];

export function MarkdownEditor({ value, onChange, onSave }) {
  const taRef = useRef(null);
  const [mobileView, setMobileView] = useState('write');

  /** Wrap or prefix the current selection, preserving undo history. */
  const apply = useCallback(
    ({ prefix, suffix, block }) => {
      const ta = taRef.current;
      if (!ta) return;

      const { selectionStart: start, selectionEnd: end, value: text } = ta;
      const selected = text.slice(start, end);

      let insertAt = start;
      let replacement;

      if (block) {
        // Block constructs go at the start of the line, on their own line.
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        insertAt = lineStart;
        const needsBlankLine = lineStart > 0 && text[lineStart - 2] !== '\n';
        replacement = `${needsBlankLine ? '\n' : ''}${prefix}${selected}${suffix}`;
        ta.setSelectionRange(lineStart, end);
      } else {
        replacement = `${prefix}${selected}${suffix}`;
      }

      ta.focus();
      // execCommand keeps the browser's native undo stack intact, which a
      // direct value assignment would destroy.
      if (!document.execCommand('insertText', false, replacement)) {
        const next = text.slice(0, insertAt) + replacement + text.slice(end);
        onChange(next);
      }

      requestAnimationFrame(() => {
        const caret = insertAt + prefix.length + selected.length + (block ? 0 : 0);
        ta.setSelectionRange(caret, caret);
      });
    },
    [onChange],
  );

  const onKeyDown = (e) => {
    // Cmd/Ctrl+S saves; Tab indents instead of leaving the field.
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      onSave?.();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      apply({ prefix: '**', suffix: '**' });
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    }
  };

  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        {TOOLBAR.map((item) => (
          <button
            key={item.title}
            type="button"
            title={item.title}
            aria-label={item.title}
            onClick={() => apply(item)}
            className={`grid h-7 min-w-7 place-items-center rounded px-1.5 text-sm text-zinc-500
                        transition hover:bg-zinc-100 hover:text-zinc-900
                        dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${item.className ?? ''}`}
          >
            {item.label}
          </button>
        ))}

        <div className="flex-1" />

        <span className="hidden px-2 text-xs text-zinc-400 sm:block">
          {words} word{words === 1 ? '' : 's'} · ~{Math.max(1, Math.round(words / 220))} min read
        </span>

        {/* mobile pane switch */}
        <div className="flex rounded-md border border-zinc-200 md:hidden dark:border-zinc-700">
          {['write', 'preview'].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setMobileView(v)}
              aria-pressed={mobileView === v}
              className={`px-2.5 py-1 text-xs font-medium capitalize ${
                mobileView === v ? 'bg-zinc-100 dark:bg-zinc-800' : 'text-zinc-500'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-2 md:divide-x md:divide-zinc-200 dark:md:divide-zinc-800">
        <div className={mobileView === 'write' ? '' : 'hidden md:block'}>
          <label htmlFor="md-source" className="sr-only">Markdown source</label>
          <textarea
            id="md-source"
            ref={taRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck="true"
            placeholder={'# Page title\n\nWrite the documentation here…'}
            className="thin-scrollbar h-[65vh] w-full resize-none bg-transparent p-4 font-mono text-sm
                       leading-relaxed outline-none placeholder:text-zinc-400"
          />
        </div>

        <div
          className={`thin-scrollbar h-[65vh] overflow-y-auto bg-zinc-50/60 p-5 dark:bg-zinc-950/40 ${
            mobileView === 'preview' ? '' : 'hidden md:block'
          }`}
          aria-label="Preview"
        >
          <div className="doc-prose prose-sm">
            <MarkdownRenderer content={value} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default MarkdownEditor;
