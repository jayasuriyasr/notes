import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

/**
 * A missing or malformed .env is by far the most common first-run
 * failure, and the default outcome is a blank white page with an
 * exception only in the console. Catching it here turns that into an
 * instruction.
 */
function boot() {
  const root = createRoot(document.getElementById('root'));
  try {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  } catch (error) {
    root.render(
      <div style={{ padding: '3rem', fontFamily: 'system-ui', maxWidth: '42rem', margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Configuration error</h1>
        <p style={{ marginTop: '0.75rem', color: '#52525b' }}>{String(error?.message ?? error)}</p>
        <p style={{ marginTop: '0.75rem', color: '#52525b' }}>
          Copy <code>.env.example</code> to <code>.env</code>, fill in your Supabase project URL and anon
          key, then restart the dev server.
        </p>
      </div>,
    );
  }
}

boot();
