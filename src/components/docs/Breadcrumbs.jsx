import { Link } from 'react-router-dom';

/**
 * Breadcrumb trail with BreadcrumbList structured data.
 *
 * The JSON-LD is what puts the "Docs › System Design › Rate Limiter"
 * trail into a Google result instead of a bare URL. It is emitted as a
 * script tag with a non-executable type, and the JSON is produced by
 * JSON.stringify — never by string concatenation of page content.
 */
export function Breadcrumbs({ items = [], siteUrl }) {
  if (!items.length) return null;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.title,
      item: `${siteUrl}/${item.path}`,
    })),
  };

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-6">
        <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
          <li>
            <Link to="/" className="hover:text-zinc-900 dark:hover:text-zinc-200">
              Docs
            </Link>
          </li>
          {items.map((item, i) => {
            const isLast = i === items.length - 1;
            return (
              <li key={item.path} className="flex items-center gap-x-1.5">
                <span aria-hidden="true" className="text-zinc-300 dark:text-zinc-700">/</span>
                {isLast ? (
                  <span aria-current="page" className="font-medium text-zinc-700 dark:text-zinc-300">
                    {item.title}
                  </span>
                ) : (
                  <Link to={`/${item.path}`} className="hover:text-zinc-900 dark:hover:text-zinc-200">
                    {item.title}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  );
}

export default Breadcrumbs;
