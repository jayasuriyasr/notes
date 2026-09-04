import { Link, useOutletContext } from 'react-router-dom';
import { Seo } from '../components/ui/Seo';
import { SITE_NAME } from '../lib/config';
import { ArticleSkeleton } from '../components/ui/Spinner';

/**
 * Landing page: the top-level sections, each with its immediate children.
 *
 * Reads the navigation tree already in cache rather than issuing its own
 * query, so "/" costs nothing beyond the tree every page needs anyway.
 */
export function HomePage() {
  const { tree } = useOutletContext() ?? {};

  if (!tree) return <div className="py-14"><ArticleSkeleton /></div>;

  return (
    <>
      <Seo
        title={null}
        description={`${SITE_NAME} — browse technical documentation by topic.`}
        path=""
        type="website"
      />

      <div className="py-14">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            {SITE_NAME}
          </h1>
          <p className="mt-3 max-w-2xl text-lg text-zinc-600 dark:text-zinc-400">
            Browse by topic, or press{' '}
            <kbd className="rounded border border-zinc-300 px-1.5 py-0.5 text-xs dark:border-zinc-700">⌘K</kbd>{' '}
            to search everything.
          </p>
        </header>

        {tree.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
            <p className="font-medium text-zinc-700 dark:text-zinc-300">No published pages yet</p>
            <p className="mt-1 text-sm text-zinc-500">
              Sign in and create your first topic from the admin dashboard.
            </p>
            <Link
              to="/admin"
              className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Go to admin
            </Link>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {tree.map((section) => (
              <section
                key={section.id}
                className="rounded-xl border border-zinc-200 p-6 transition hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
              >
                <h2 className="text-lg font-semibold">
                  <Link
                    to={`/${section.path}`}
                    className="text-zinc-900 hover:text-brand-600 dark:text-zinc-100 dark:hover:text-brand-400"
                  >
                    {section.title}
                  </Link>
                </h2>

                {section.children.length > 0 && (
                  <ul className="mt-4 space-y-1.5">
                    {section.children.slice(0, 6).map((child) => (
                      <li key={child.id}>
                        <Link
                          to={`/${child.path}`}
                          className="text-sm text-zinc-600 hover:text-brand-600 dark:text-zinc-400 dark:hover:text-brand-400"
                        >
                          {child.title}
                          {child.children.length > 0 && (
                            <span className="ml-1.5 text-xs text-zinc-400">({child.children.length})</span>
                          )}
                        </Link>
                      </li>
                    ))}
                    {section.children.length > 6 && (
                      <li className="text-sm text-zinc-400">
                        + {section.children.length - 6} more
                      </li>
                    )}
                  </ul>
                )}
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default HomePage;
