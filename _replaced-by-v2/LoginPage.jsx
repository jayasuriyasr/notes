import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { normalizeError } from '../lib/errors';
import { ErrorState } from '../components/ui/ErrorState';
import { Spinner } from '../components/ui/Spinner';
import { Seo } from '../components/ui/Seo';
import { SITE_NAME } from '../lib/config';

export function LoginPage() {
  const { signIn, session, isAdmin, loading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from ?? '/admin';

  useEffect(() => {
    if (!loading && session && isAdmin) navigate(from, { replace: true });
  }, [loading, session, isAdmin, from, navigate]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email, password);
      // Navigation happens in the effect above, once the profile (and
      // therefore the role) has loaded.
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const signedInButNotAdmin = !loading && session && !isAdmin;

  return (
    <>
      <Seo title="Sign in" path="login" noindex />

      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center justify-center gap-2 font-semibold">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
              D
            </span>
            {SITE_NAME}
          </Link>

          <div className="rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Administrator sign in</h1>
            <p className="mt-1 text-sm text-zinc-500">
              Reading the documentation does not require an account.
            </p>

            {signedInButNotAdmin && (
              <div className="mt-4">
                <ErrorState
                  compact
                  kind="forbidden"
                  title="Signed in, but not an administrator"
                  message="Your account exists but has the 'viewer' role. The project owner grants admin access."
                />
              </div>
            )}

            {error && (
              <div className="mt-4">
                <ErrorState compact error={error} />
              </div>
            )}

            <form onSubmit={onSubmit} className="mt-5 space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm
                             focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm
                             focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5
                           text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
              >
                {submitting && <Spinner className="h-4 w-4 text-white" />}
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-sm">
            <Link to="/" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300">
              ← Back to documentation
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}

export default LoginPage;
