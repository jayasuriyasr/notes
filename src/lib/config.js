/**
 * Environment configuration, read once and validated loudly.
 *
 * Vite replaces `import.meta.env.VITE_*` at build time, so these values
 * are baked into the bundle. That is why only PUBLIC values live here.
 */
const required = (name) => {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill in your Supabase project values.`,
    );
  }
  return value;
};

export const SUPABASE_URL = required('VITE_SUPABASE_URL');
export const SUPABASE_ANON_KEY = required('VITE_SUPABASE_ANON_KEY');

export const SITE_URL = (import.meta.env.VITE_SITE_URL || window.location.origin).replace(/\/$/, '');
export const SITE_NAME = import.meta.env.VITE_SITE_NAME || 'Documentation';
