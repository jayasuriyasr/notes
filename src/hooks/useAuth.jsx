import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { normalizeError } from '../lib/errors';

const AuthContext = createContext(null);

/**
 * Session + profile state.
 *
 * IMPORTANT: `isAdmin` here decides what the UI *renders*. It decides
 * nothing about what the database *permits*. A user who flips this flag
 * in React DevTools sees the admin dashboard render and then watches
 * every request it makes come back empty, because RLS evaluates
 * public.is_admin() server-side against their JWT. The frontend check
 * exists so that non-admins are not shown buttons that cannot work.
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
        .select('id,email,display_name,role')
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

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw normalizeError(error);
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      isAdmin: profile?.role === 'admin',
      loading,
      signIn,
      signOut,
    }),
    [session, profile, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
