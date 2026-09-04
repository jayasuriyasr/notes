import { useEffect, useMemo } from 'react';
import { useParams, useNavigate, useOutletContext, Link } from 'react-router-dom';
import { usePage, useRedirect } from '../hooks/useTopics';
import { MarkdownRenderer } from '../components/markdown/MarkdownRenderer';
import Breadcrumbs from '../components/docs/Breadcrumbs';
import PrevNext from '../components/docs/PrevNext';
import TableOfContents from '../components/docs/TableOfContents';
import { ArticleSkeleton } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/ErrorState';
import { Seo } from '../components/ui/Seo';
import { getPrevNext } from '../utils/tree';
import { extractHeadings, deriveExcerpt } from '../utils/markdown';
import { normalizePath } from '../utils/slug';
import { SITE_URL } from '../lib/config';

/**
 * One page, resolved entirely from the URL.
 *
 * The route is a splat (`/*`), so `system-design/rate-limiter/token-bucket`
 * arrives here as a single string and becomes one indexed lookup. There
 * is no per-segment resolution and no route configuration to keep in sync
 * with the content tree — adding a page in the admin UI makes its URL work
 * immediately, with no deploy.
 *
 * MISS HANDLING (§11, §18): a lookup that returns nothing is not
 * immediately a 404. We first ask topic_redirects whether this URL used to
 * belong to a page that has since been renamed or moved, and if so replace
 * the history entry with the current URL. Only a genuine miss renders 404.
 */
export function DocPage() {
  const params = useParams();
  const navigate = useNavigate();
  const { tree = [] } = useOutletContext() ?? {};

  const path = normalizePath(params['*'] ?? '');
  const { data, isLoading, isError, error, refetch, isFetched } = usePage(path);

  // Only consult the redirect table once the page lookup has definitively missed.
  const missed = isFetched && !isError && !data;
  const { data: redirectTo, isFetched: redirectChecked } = useRedirect(path, missed);

  useEffect(() => {
    if (redirectTo && redirectTo !== path) {
      // `replace` so the browser Back button does not bounce the reader
      // between the dead URL and the live one.
      navigate(`/${redirectTo}`, { replace: true });
    }
  }, [redirectTo, path, navigate]);

  const topic = data?.topic;

  const headings = useMemo(() => extractHeadings(topic?.content ?? ''), [topic?.content]);
  const { prev, next } = useMemo(() => getPrevNext(tree, path), [tree, path]);
  const description = useMemo(
    () => topic?.excerpt || deriveExcerpt(topic?.content ?? ''),
    [topic?.excerpt, topic?.content],
  );

  if (isLoading) {
    return (
      <div className="py-10 lg:py-14">
        <ArticleSkeleton />
      </div>
    );
  }

  if (isError) {
    return <ErrorState error={error} onRetry={refetch} />;
  }

  if (missed) {
    // Hold the 404 until the redirect lookup has answered, otherwise a
    // moved page flashes "not found" before it forwards.
    if (!redirectChecked || redirectTo) {
      return (
        <div className="py-10 lg:py-14">
          <ArticleSkeleton />
        </div>
      );
    }
    return (
      <>
        <Seo title="Page not found" path={path} noindex />
        <ErrorState
          kind="not_found"
          message={
            <>
              Nothing is published at <code className="font-mono text-sm">/{path}</code>.
            </>
          }
        />
      </>
    );
  }

  return (
    <>
      <Seo title={topic.title} description={description} path={topic.path} />

      <div className="flex gap-10 py-10 lg:py-14">
        <article className="min-w-0 flex-1">
          <Breadcrumbs items={data.breadcrumbs} siteUrl={SITE_URL} />

          <div className="doc-prose">
            <MarkdownRenderer content={topic.content} />
          </div>

          {/* A section page with children lists them as cards, so a parent
              page is useful even when its own body is short. */}
          {data.children?.length > 0 && (
            <section className="mt-14" aria-labelledby="subpages">
              <h2 id="subpages" className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                In this section
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {data.children.map((child) => (
                  <Link
                    key={child.id}
                    to={`/${child.path}`}
                    className="group rounded-xl border border-zinc-200 p-4 transition hover:border-brand-400
                               hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-brand-500/60 dark:hover:bg-zinc-900/50"
                  >
                    <p className="font-medium text-zinc-900 group-hover:text-brand-600 dark:text-zinc-100 dark:group-hover:text-brand-400">
                      {child.title}
                    </p>
                    {child.excerpt && (
                      <p className="mt-1 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">{child.excerpt}</p>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          )}

          <PrevNext prev={prev} next={next} />

          <p className="mt-10 text-xs text-zinc-400">
            Last updated{' '}
            <time dateTime={topic.updated_at}>
              {new Date(topic.updated_at).toLocaleDateString(undefined, {
                year: 'numeric', month: 'long', day: 'numeric',
              })}
            </time>
          </p>
        </article>

        <aside className="hidden w-56 shrink-0 xl:block">
          <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto thin-scrollbar">
            <TableOfContents headings={headings} />
          </div>
        </aside>
      </div>
    </>
  );
}

export default DocPage;
