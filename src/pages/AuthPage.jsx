import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { normalizeError } from '../lib/errors';
import { ErrorState } from '../components/ui/ErrorState';
import { Spinner } from '../components/ui/Spinner';
import { Seo } from '../components/ui/Seo';
import { SITE_NAME } from '../lib/config';

/**
 * Sign in and register, one component.
 *
 * They share a layout, a field set and every error path, so splitting
 * them into two files would mean maintaining the same form twice. `mode`
 * comes from the route, so /login and /register are still real,
 * linkable, bookmarkable URLs rather than a tab in someone's state.
 */
export function AuthPage({ mode = 'login' }) {
  const isRegister = mode === 'register';
  const { signIn, signUp, session, loading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from ?? '/dashboard';

  useEffect(() => {
    if (!loading && session) navigate(from, { replace: true });
  }, [loading, session, from, navigate]);

  useEffect(() => {
    setError(null);
    setConfirmSent(false);
  }, [mode]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (isRegister) {
        const { needsConfirmation } = await signUp(email, password, displayName.trim());
        // With email confirmation switched on in Supabase, signUp returns
        // a user but no session. Saying nothing here is the single most
        // confusing thing a signup form can do.
        if (needsConfirmation) setConfirmSent(true);
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      setError(normalizeError(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (confirmSent) {
    return (
      <Shell title="Check your email">
        <Seo title="Confirm your email" path="register" noindex />
        <div className="rounded-xl border border-zinc-200 p-6 text-center dark:border-zinc-800">
          <p className="text-3xl" aria-hidden="true">✉</p>
          <h1 className="mt-3 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Confirm your email
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            We sent a link to <strong className="text-zinc-900 dark:text-zinc-200">{email}</strong>. Open it
            to finish creating your account, then sign in.
          </p>
          <Link
            to="/login"
            className="mt-5 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            Go to sign in
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={isRegister ? 'Create an account' : 'Sign in'}>
      <Seo
        title={isRegister ? 'Create an account' : 'Sign in'}
        path={isRegister ? 'register' : 'login'}
        noindex
      />

      <div className="rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
        <div className="mb-5 flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
          <TabLink to="/login" active={!isRegister}>Sign in</TabLink>
          <TabLink to="/register" active={isRegister}>Register</TabLink>
        </div>

        <p className="mb-5 text-sm text-zinc-500">
          {isRegister
            ? 'An account lets you write pages and choose who can see them. Reading the documentation never requires one.'
            : 'Reading the documentation does not require an account.'}
        </p>

        {error && (
          <div className="mb-4">
            <ErrorState compact error={error} />
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          {isRegister && (
            <Field
              id="displayName"
              label="Display name"
              hint="Optional. Shown on the pages you write."
              value={displayName}
              onChange={setDisplayName}
              autoComplete="name"
              required={false}
            />
          )}

          <Field
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />

          <Field
            id="password"
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            hint={isRegister ? 'At least 6 characters.' : undefined}
            minLength={isRegister ? 6 : undefined}
          />

          <button
            type="submit"
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5
                       text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {submitting && <Spinner className="h-4 w-4 text-white" />}
            {submitting
              ? isRegister ? 'Creating account…' : 'Signing in…'
              : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>

      <p className="mt-6 text-center text-sm">
        <Link to="/" className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300">
          ← Back to documentation
        </Link>
      </p>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2 font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">
            D
          </span>
          {SITE_NAME}
        </Link>
        {children}
      </div>
    </div>
  );
}

function TabLink({ to, active, children }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`flex-1 rounded-md px-3 py-1.5 text-center text-sm font-medium transition ${
        active
          ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300'
      }`}
    >
      {children}
    </Link>
  );
}

function Field({ id, label, hint, value, onChange, type = 'text', required = true, ...rest }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </label>
      <input
        id={id}
        type={type}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm
                   focus:border-brand-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900"
        {...rest}
      />
      {hint && <p className="mt-1 text-xs text-zinc-400">{hint}</p>}
    </div>
  );
}

export default AuthPage;
