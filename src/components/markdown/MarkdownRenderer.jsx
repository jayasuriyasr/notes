import { memo, useMemo, useState, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import rehypeSanitize from 'rehype-sanitize';
import { Link } from 'react-router-dom';
import { sanitizeSchema, HEADING_ID_PREFIX } from './sanitizeSchema';

/**
 * Plugin order matters and is not arbitrary:
 *
 *   remarkGfm        tables, task lists, strikethrough, autolinks
 *   rehypeSlug       stable ids on headings (feeds the table of contents)
 *   rehypeHighlight  syntax colouring, only for fences with a language
 *   rehypeSanitize   LAST, so it vets everything above it
 *
 * These arrays are module-level constants. Defining them inline in JSX
 * would hand react-markdown a new array identity on every render and
 * force a full re-parse of the document each time.
 */
const remarkPlugins = [remarkGfm];
const rehypePlugins = [
  rehypeSlug,
  [rehypeHighlight, { detect: false, ignoreMissing: true, subset: false }],
  [rehypeSanitize, sanitizeSchema],
];

/** Collect the raw text of a hast subtree — used for "copy code". */
function nodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked (insecure context / permissions): stay silent */
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy code to clipboard'}
      className="absolute right-2 top-2 rounded-md border border-zinc-300 bg-white/90 px-2 py-1
                 text-xs font-medium text-zinc-600 opacity-0 shadow-sm transition
                 group-hover:opacity-100 focus-visible:opacity-100 hover:text-zinc-900
                 dark:border-zinc-700 dark:bg-zinc-800/90 dark:text-zinc-300 dark:hover:text-white"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const components = {
  /**
   * Internal links stay inside the SPA (no full page reload); external
   * links open in a new tab with rel="noopener noreferrer" — without
   * `noopener` the opened page can reach back through window.opener.
   *
   * Hash links get the clobber prefix applied so an author writing
   * `[see below](#token-bucket)` still lands on the right heading.
   */
  a({ node, href = '', children, ...props }) {
    if (href.startsWith('#')) {
      const id = href.slice(1);
      const target = id.startsWith(HEADING_ID_PREFIX) ? id : `${HEADING_ID_PREFIX}${id}`;
      return (
        <a href={`#${target}`} {...props}>
          {children}
        </a>
      );
    }

    const isInternal = href.startsWith('/') && !href.startsWith('//');
    if (isInternal) {
      return (
        <Link to={href} {...props}>
          {children}
        </Link>
      );
    }

    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...props}>
        {children}
        <span aria-hidden="true" className="ml-0.5 text-[0.8em] opacity-60">↗</span>
      </a>
    );
  },

  img({ node, ...props }) {
    // eslint-disable-next-line jsx-a11y/alt-text
    return <img loading="lazy" decoding="async" {...props} />;
  },

  /** Wide tables scroll in their own box rather than widening the page. */
  table({ node, children, ...props }) {
    return (
      <div className="table-scroll">
        <table {...props}>{children}</table>
      </div>
    );
  },

  pre({ node, children, ...props }) {
    return (
      <div className="group relative">
        <pre {...props}>{children}</pre>
        <CopyButton text={nodeText(node)} />
      </div>
    );
  },
};

/**
 * Memoised: re-parsing a long document on every parent render is the
 * single most expensive thing this page can do, and the editor's live
 * preview re-renders on every keystroke.
 */
function MarkdownRendererBase({ content = '' }) {
  const source = useMemo(() => content ?? '', [content]);

  if (!source.trim()) {
    return (
      <p className="italic text-zinc-500 dark:text-zinc-400">
        This page has no content yet.
      </p>
    );
  }

  return (
    <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {source}
    </Markdown>
  );
}

export const MarkdownRenderer = memo(MarkdownRendererBase);
export default MarkdownRenderer;
