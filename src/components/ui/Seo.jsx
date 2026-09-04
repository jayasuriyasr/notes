import { useEffect } from 'react';
import { SITE_NAME, SITE_URL } from '../../lib/config';

/**
 * ============================================================
 *  SEO — and an honest account of its limits in this stack
 * ============================================================
 * React 19 hoists <title>, <meta> and <link> rendered anywhere in the
 * tree into document.head, so no helmet library is needed. Googlebot
 * renders JavaScript, so it does see these tags and indexes the pages.
 *
 * What this CANNOT fix, because it is a client-rendered SPA:
 *
 *   Social crawlers (Slack, Twitter/X, LinkedIn, Discord, iMessage) do
 *   NOT execute JavaScript. They read the raw index.html, so every
 *   shared link previews with the same generic title and description
 *   regardless of which page was shared.
 *
 * That limitation is inherent to the architecture, not to this code, and
 * it is the concrete cost of choosing a pure React SPA over a
 * server-rendered framework. See ARCHITECTURE.md §17 for the full
 * trade-off and the two ways out (a prerender step, or Next.js).
 */
export function Seo({ title, description, path, noindex = false, type = 'article' }) {
  /**
   * React 19 PREPENDS hoisted tags rather than replacing what index.html
   * already declares, so without this the document ends up with two
   * <title> elements and two descriptions. document.title happens to
   * resolve to the right one, but leaving duplicate metadata for a
   * crawler to choose between is not something to rely on. The static
   * tags are marked data-default and removed the first time any page
   * renders, which keeps them available to non-JS clients (they are in
   * the served HTML) while leaving a clean head once React takes over.
   */
  useEffect(() => {
    document.head.querySelectorAll('[data-default]').forEach((el) => el.remove());
  }, []);

  const fullTitle = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
  const canonical = path !== undefined ? `${SITE_URL}/${String(path).replace(/^\//, '')}` : SITE_URL;

  return (
    <>
      <title>{fullTitle}</title>
      {description && <meta name="description" content={description} />}
      <link rel="canonical" href={canonical} />
      {noindex && <meta name="robots" content="noindex, nofollow" />}

      <meta property="og:type" content={type} />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={fullTitle} />
      {description && <meta property="og:description" content={description} />}
      <meta property="og:url" content={canonical} />

      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={fullTitle} />
      {description && <meta name="twitter:description" content={description} />}
    </>
  );
}
