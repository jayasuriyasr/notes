import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient';
import { AuthProvider } from './hooks/useAuth';
import { ThemeProvider } from './hooks/useTheme';
import router from './routes';

/**
 * Provider order matters:
 *   Query  — the outermost data layer
 *   Auth   — signs in via Supabase and needs no other context
 *   Theme  — independent, but must wrap the router so every page can toggle
 *   Router — last, so every route has all three available
 */
export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ThemeProvider>
          <RouterProvider router={router} />
        </ThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
