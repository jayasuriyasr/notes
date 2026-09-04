import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import DocsLayout from '../layouts/DocsLayout';
import HomePage from '../pages/HomePage';
import DocPage from '../pages/DocPage';
import RouteError from '../pages/RouteError';
import { Spinner } from '../components/ui/Spinner';

/**
 * The admin surface is code-split. A reader who never signs in should not
 * download the Markdown editor, the dialogs or the admin tree — together
 * the largest application chunk in the project. React.lazy defers all of
 * it until someone actually navigates to /admin or /login.
 */
const AdminLayout = lazy(() => import('../layouts/AdminLayout'));
const RequireAdmin = lazy(() =>
  import('../layouts/AdminLayout').then((m) => ({ default: m.RequireAdmin })),
);
const LoginPage = lazy(() => import('../pages/LoginPage'));
const AdminTopics = lazy(() => import('../pages/admin/AdminTopics'));
const AdminEditor = lazy(() => import('../pages/admin/AdminEditor'));

const deferred = (node) => (
  <Suspense
    fallback={
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    }
  >
    {node}
  </Suspense>
);

/**
 * ============================================================
 *  ROUTING
 * ============================================================
 * Two families of route, and one wildcard.
 *
 *   /login, /admin/*    — fixed, application-owned routes
 *   /*                  — everything else is a documentation path
 *
 * The wildcard is what makes URLs content-driven: `/a/b/c` arrives as a
 * single string, gets looked up by `path`, and renders. Publishing a new
 * page makes its URL live immediately — no route table to update, no
 * rebuild, no deploy.
 *
 * Route ranking, not declaration order, decides the winner: React Router
 * scores static segments above dynamic ones and dynamic above splats, so
 * `/login` can never be swallowed by `/*`. The reserved-slug CHECK
 * constraint in the database closes the other half of the problem — an
 * author cannot create a top-level page at `admin` and shadow the
 * dashboard.
 *
 * A path that matches no topic is NOT immediately a 404: DocPage first
 * consults topic_redirects, so a page that was renamed or moved forwards
 * to its new home instead of dead-ending.
 */
export const router = createBrowserRouter([
  {
    path: '/login',
    element: deferred(<LoginPage />),
    errorElement: <RouteError />,
  },
  {
    path: '/admin',
    element: deferred(
      <RequireAdmin>
        <AdminLayout />
      </RequireAdmin>,
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: deferred(<AdminTopics />) },
      { path: 'topics', element: <Navigate to="/admin" replace /> },
      { path: 'topics/new', element: deferred(<AdminEditor />) },
      { path: 'topics/:id', element: deferred(<AdminEditor />) },
    ],
  },
  {
    path: '/',
    element: <DocsLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      // The splat. Must be last within this branch.
      { path: '*', element: <DocPage /> },
    ],
  },
]);

export default router;
