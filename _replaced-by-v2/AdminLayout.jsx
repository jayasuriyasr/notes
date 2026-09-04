import { Link, Outlet, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ThemeToggle } from '../components/ui/ThemeToggle';
import { Spinner } from '../components/ui/Spinner';
import { ErrorState } from '../components/ui/ErrorState';
import { Seo } from '../components/ui/Seo';

/**
 * Route guard.
 *
 * To be explicit about what this is and is not: this component controls
 * RENDERING. It is a courtesy so that a signed-out visitor sees a sign-in
 * page instead of an admin shell full of failing requests.
 *
 * It is NOT the security boundary. Someone who bypasses it — by editing
 * the bundle, calling the router directly, or hitting PostgREST with
 * curl — reaches a database where every policy still evaluates
 * public.is_admin() against their JWT. They see published rows and
 * nothing else, and every write is rejected. The guard being removable is
 * exactly why authorization does not live here.
 */
export function RequireAdmin({ children }) {
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

  if (!isAdmin) {
    return (
      <ErrorState
        kind="forbidden"
        title="Administrator access required"
        message="You are signed in, but your account has the 'viewer' role. The Supabase project owner grants admin access."
      />
    );
  }

  return children;
}

export function AdminLayout() {
  const { profile, signOut } = useAuth();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <Seo title="Admin" path="admin" noindex />

      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <Link to="/admin" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-zinc-900 text-sm font-bold text-white dark:bg-white dark:text-zinc-900">
              A
            </span>
            Admin
          </Link>

          <div className="flex-1" />

          <Link
            to="/"
            className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            View site ↗
          </Link>
          <ThemeToggle />
          <div className="hidden text-sm text-zinc-500 sm:block">{profile?.email}</div>
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

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}

export default AdminLayout;
