import { useRouteError, isRouteErrorResponse } from 'react-router-dom';
import { ErrorState } from '../components/ui/ErrorState';
import { normalizeError } from '../lib/errors';

/**
 * Last-resort boundary for anything a route threw — including a render
 * crash. Without it React Router shows its own developer stack trace,
 * which is not something a reader should ever see.
 */
export function RouteError() {
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 404) {
    return <ErrorState kind="not_found" />;
  }

  return (
    <div className="mx-auto max-w-3xl px-4">
      <ErrorState
        error={normalizeError(error)}
        title="This page could not be displayed"
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}

export default RouteError;
