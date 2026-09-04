import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

/**
 * The one and only Supabase client.
 *
 * ARCHITECTURAL NOTE - why the browser talks to Supabase directly
 * ---------------------------------------------------------------
 * Three options were on the table (§12):
 *
 *   1. Direct from the browser  <- chosen
 *   2. Supabase Edge Functions
 *   3. A separate backend API
 *
 * A backend API would exist only to re-implement, in application code,
 * the authorization rules that RLS already enforces in the database -
 * and it would enforce them one layer further from the data, where they
 * can drift. It also adds a deployment, a cold start and a hop of
 * latency to every read.
 *
 * Edge Functions are the right tool when you need a secret the browser
 * must not see (a Stripe key, an outbound webhook) or logic that must
 * run even if the client lies. This application has neither: every
 * operation is expressible as a row the caller is or is not allowed to
 * touch, which is precisely what RLS decides.
 *
 * So: direct access, with the database as the sole security boundary.
 * The moment a requirement appears that RLS genuinely cannot express -
 * sending invitation emails, say, or importing from GitHub - that one
 * operation becomes an Edge Function, and the rest stays as it is.
 */
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'docs-auth',
  },
  global: {
    headers: { 'x-client-info': 'md-docs-platform' },
  },
});
