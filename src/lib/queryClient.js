import { QueryClient } from '@tanstack/react-query';
import { ERROR_KIND } from './errors';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Documentation changes a few times a day, not a few times a second.
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      // Retrying a 403 or a 404 just wastes a round trip and delays the
      // error the user needs to see. Only transient failures are retried.
      retry: (count, error) =>
        error?.kind === ERROR_KIND.NETWORK || error?.kind === ERROR_KIND.SERVER ? count < 2 : false,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
    mutations: { retry: false },
  },
});
