import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import DocsLayout from '../layouts/DocsLayout';
import HomePage from '../pages/HomePage';
import DocPage from '../pages/DocPage';
import RouteError from '../pages/RouteError';
import { Spinner } from '../components/ui/Spinner';

/**
 * The authoring surface is code-split. Someone who only ever reads the
 * documentation should not download the Markdown editor, the dialogs,
 * the tree manager or the people table — together the largest
 * application chunk in the project.
 */
const DashboardLayout = lazy(() => import('../layouts/DashboardLayout'));
const RequireMember = lazy(() =>
  import('../layouts/DashboardLayout').then((m) => ({ default: m.RequireMember })),
);
const AuthPage = lazy(() => import('../pages/AuthPage'));
const MyPages = lazy(() => import('../pages/dashboard/MyPages'));
const AllPages = lazy(() => import('../pages/dashboard/AllPages'));
const People = lazy(() => import('../pages/dashboard/People'));
const Editor = lazy(() => import('../pages/dashboard/Editor'));

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
 * Three families of route, and one wildcard.
 *
 *   /login, /register   authentication
 *   /dashboard/*        authoring, for any signed-in member
 *   /*                  everything else is a documentation path
 *
 * The wildcard is what makes URLs content-driven: `/a/b/c` arrives as a
 * single string, becomes one indexed lookup on `path`, and renders.
 * Publishing a page makes its URL live immediately — no route table to
 * update, no rebuild, no deploy.
 *
 * Route RANKING, not declaration order, decides the winner: React Router
 * scores static segments above dynamic and dynamic above splats, so
 * /login can never be swallowed by /*. The reserved-slug CHECK
 * constraint closes the other half of the problem — now that any member
 * can create a top-level page, someone would otherwise be able to claim
 * `dashboard` or `register` and shadow the application.
 *
 * A path that matches no page is NOT immediately a 404: DocPage consults
 * topic_redirects first, so a page that was renamed or moved forwards to
 * its new home.
 */
export const router = createBrowserRouter([
  { path: '/login',    element: deferred(<AuthPage mode="login" />),    errorElement: <RouteError /> },
  { path: '/register', element: deferred(<AuthPage mode="register" />), errorElement: <RouteError /> },

  {
    path: '/dashboard',
    element: deferred(
      <RequireMember>
        <DashboardLayout />
      </RequireMember>,
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: deferred(<MyPages />) },
      { path: 'pages/new', element: deferred(<Editor />) },
      { path: 'pages/:id', element: deferred(<Editor />) },
      {
        path: 'all',
        element: deferred(<RequireMember adminOnly><AllPages /></RequireMember>),
      },
      {
        path: 'people',
        element: deferred(<RequireMember adminOnly><People /></RequireMember>),
      },
    ],
  },

  // The dashboard used to live at /admin. Kept so older links and
  // bookmarks land somewhere useful instead of resolving as a page.
  { path: '/admin', element: <Navigate to="/dashboard" replace /> },
  { path: '/admin/*', element: <Navigate to="/dashboard" replace /> },

  {
    path: '/',
    element: <DocsLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePage /> },
      { path: '*', element: <DocPage /> },   // the splat; must be last
    ],
  },
]);

export default router;
