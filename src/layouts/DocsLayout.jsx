import { useState, useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useNavTree } from '../hooks/useTopics';
import { useAuth } from '../hooks/useAuth';
import Sidebar from '../components/docs/Sidebar';
import SearchDialog from '../components/docs/SearchDialog';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { ErrorState } from '../components/ui/ErrorState';
import { SITE_NAME } from '../lib/config';

/**
 * Public shell: header, sidebar, content outlet.
 *
 * The navigation tree is fetched here, once, and shared with every page
 * below through React Query's cache. Nothing re-requests it on
 * navigation, which is what makes moving between pages cost a single
 * request for the page body and nothing else.
 */
export function DocsLayout() {
  const { tree, isLoading, error, refetch } = useNavTree();
  const { session, profile, isAdmin } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();

  const currentPath = location.pathname.replace(/^\//, '');

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  // Cmd/Ctrl+K opens search, / focuses it — the two conventions readers expect.
  useEffect(() => {
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50
                   focus:rounded-lg focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      {/* ---------------- header ---------------- */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="mx-auto flex h-14 max-w-8xl items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle navigation"
            aria-expanded={mobileOpen}
            className="-ml-1 rounded-md p-2 text-zinc-500 hover:bg-zinc-100 lg:hidden dark:hover:bg-zinc-800"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-5 w-5">
              <path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z" />
            </svg>
          </button>

          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
              D
            </span>
            <span className="hidden sm:inline">{SITE_NAME}</span>
          </Link>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm
                       text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700
                       dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:text-zinc-300"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4">
              <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.08 3.08a1 1 0 01-1.42 1.42l-3.08-3.08A7 7 0 012 9z" clipRule="evenodd" />
            </svg>
            <span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded border border-zinc-200 px-1.5 py-0.5 font-sans text-[10px] md:inline dark:border-zinc-700">
              ⌘K
            </kbd>
          </button>

          <ThemeToggle />

          {session ? (
            <Link
              to="/dashboard"
              className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600
                         hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-100 text-[10px]
                               font-bold uppercase text-brand-700 dark:bg-brand-500/20 dark:text-brand-300">
                {(profile?.display_name || profile?.username || '?').slice(0, 2)}
              </span>
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
          ) : (
            <div className="flex items-center gap-1">
              <Link
                to="/login"
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100
                           dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className="hidden rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white
                           hover:bg-brand-700 sm:block"
              >
                Register
              </Link>
            </div>
          )}
        </div>
      </header>

      <div className="mx-auto flex max-w-8xl px-4 sm:px-6">
        {/* ---------------- sidebar ---------------- */}
        <aside
          id="site-nav"
          className={`fixed inset-x-0 bottom-0 top-14 z-20 overflow-y-auto border-r border-zinc-200
                      bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950
                      lg:sticky lg:top-14 lg:block lg:h-[calc(100vh-3.5rem)] lg:w-64 lg:shrink-0 lg:bg-transparent lg:py-8 lg:pl-0 lg:pr-5
                      thin-scrollbar ${mobileOpen ? 'block' : 'hidden'}`}
        >
          {error ? (
            <ErrorState compact error={error} onRetry={refetch} />
          ) : (
            <Sidebar tree={tree} isLoading={isLoading} currentPath={currentPath} />
          )}
        </aside>

        {/* ---------------- content ---------------- */}
        <main id="main" className="min-w-0 flex-1 lg:pl-10">
          <Outlet context={{ tree }} />
        </main>
      </div>

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

export default DocsLayout;
