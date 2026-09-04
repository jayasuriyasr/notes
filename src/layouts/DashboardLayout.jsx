import { Link, NavLink, Outlet, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { Spinner } from '../components/ui/Spinner';
import { Seo } from '../components/ui/Seo';

/**
 * Route guard.
 *
 * To be explicit about what this is and is not: it controls RENDERING.
 * It is a courtesy so that a signed-out visitor sees a sign-in page
 * rather than a dashboard shell full of failing requests.
 *
 * It is NOT the security boundary. Someone who bypasses it — by editing
 * the bundle, calling the router directly, or hitting PostgREST with
 * curl — reaches a database where every policy still evaluates
 * is_active() and is_admin() against their JWT. They see non-private
 * pages and their own, and every write they attempt is refused. The
 * guard being trivially removable is exactly why authorisation does not
 * live here.
 *
 * A SUSPENDED member is deliberately let through. Locking them out of
 * the dashboard entirely would hide their own pages from them and give
 * no explanation; letting them in, with a banner and no working write
 * controls, tells them what happened. The database enforces the rest.
 */
export function RequireMember({ adminOnly = false, children }) {
  const { loading, session, isAdmin } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (adminOnly && !isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

const tab = ({ isActive }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
    isActive
      ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
      : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200'
  }`;

export function DashboardLayout() {
  const { profile, isAdmin, isSuspended, signOut } = useAuth();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Seo title="Dashboard" path="dashboard" noindex />

      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:px-6">
          <Link to="/dashboard" className="mr-2 flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
              D
            </span>
            <span className="hidden sm:inline">Dashboard</span>
          </Link>

          <nav className="flex items-center gap-1" aria-label="Dashboard sections">
            <NavLink to="/dashboard" end className={tab}>My pages</NavLink>
            {isAdmin && <NavLink to="/dashboard/all" className={tab}>All pages</NavLink>}
            {isAdmin && <NavLink to="/dashboard/people" className={tab}>People</NavLink>}
          </nav>

          <div className="flex-1" />

          <Link
            to="/"
            className="hidden text-sm text-zinc-500 hover:text-zinc-900 sm:block dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            View site ↗
          </Link>
          <ThemeToggle />

          <div className="hidden items-center gap-2 md:flex">
            <span className="text-sm text-zinc-500">@{profile?.username}</span>
            {isAdmin && (
              <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase
                               tracking-wide text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
                Admin
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={signOut}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700
                       hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Sign out
          </button>
        </div>
      </header>

      {isSuspended && (
        <div role="alert" className="border-b border-amber-300 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-500/10">
          <div className="mx-auto max-w-7xl px-4 py-3 text-sm text-amber-900 sm:px-6 dark:text-amber-200">
            <strong>Your account is suspended.</strong> Your pages are all still here and still published
            exactly as they were — but you cannot create or change anything until an administrator
            reactivates the account.
          </div>
        </div>
      )}

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}

export default DashboardLayout;
