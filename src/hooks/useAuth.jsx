import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { normalizeError, AppError, ERROR_KIND } from '../lib/errors';

const AuthContext = createContext(null);

/**
 * Session + profile state.
 *
 * WHAT THESE FLAGS ARE FOR
 * `isAdmin` and `canWrite` decide what the UI *renders*. They decide
 * nothing about what the database *permits*. A user who flips either one
 * in DevTools sees more buttons appear and then watches every request
 * they make come back empty or refused, because RLS evaluates
 * public.is_admin() and public.is_active() server-side against their JWT.
 * The flags exist so that people are not shown controls that cannot work.
 */
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const loadProfile = async (userId) => {
      if (!userId) return null;
      const { data, error } = await supabase
        .from('profiles')
        .select('id,email,username,display_name,role,status')
        .eq('id', userId)
        .limit(1);
      if (error) return null;
      return data?.[0] ?? null;
    };

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session ?? null);
      setProfile(await loadProfile(data.session?.user?.id));
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      if (!active) return;
      setSession(next ?? null);
      setProfile(next?.user?.id ? await loadProfile(next.user.id) : null);
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw normalizeError(error);
    return data;
  }, []);

  /**
   * Registration.
   *
   * Note what is NOT sent: a role. The signup trigger writes
   * ('member','active') unconditionally and never reads the payload, so
   * posting {"role":"admin"} to this endpoint achieves precisely nothing.
   *
   * Returns { needsConfirmation } so the caller can tell the two normal
   * outcomes apart: with email confirmation switched on, Supabase returns
   * a user but no session, and the person must click a link before they
   * can sign in. Silently doing nothing in that case is the single most
   * confusing thing a signup form can do.
   */
  const signUp = useCallback(async (email, password, displayName) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: displayName ? { display_name: displayName } : {} },
    });
    if (error) throw normalizeError(error);

    // Supabase returns an existing-but-unconfirmed user with an empty
    // identities array rather than an error, to avoid leaking which
    // addresses are registered.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new AppError(
        ERROR_KIND.CONFLICT,
        'An account already exists for that email address. Try signing in, or reset your password.',
      );
    }

    return { needsConfirmation: !data.session, user: data.user };
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw normalizeError(error);
  }, []);

  const value = useMemo(() => {
    const isAdmin = profile?.role === 'admin' && profile?.status === 'active';
    return {
      session,
      user: session?.user ?? null,
      profile,
      loading,
      isAdmin,
      // A suspended account keeps its pages and can still read the site.
      // It simply stops being able to change anything — which is exactly
      // what is_active() enforces in every write policy.
      isSuspended: profile?.status === 'suspended',
      canWrite: Boolean(profile) && profile.status === 'active',
      signIn,
      signUp,
      signOut,
    };
  }, [session, profile, loading, signIn, signUp, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
