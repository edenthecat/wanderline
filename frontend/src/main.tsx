import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initSentry, isSentryEnabled, Sentry } from './sentry';
import './index.css';

initSentry();

// User-facing fallback. Show a Sentry event id (a random reference) so
// the user can quote it in a bug report — but never surface raw
// error messages, which can leak sensitive details.
function ErrorFallback({ eventId, resetError }: { eventId: string; resetError: () => void }) {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1>Something went wrong.</h1>
      <p>An unexpected error occurred. Please try again.</p>
      {eventId && (
        <p style={{ color: '#666' }}>
          Reference ID: <code>{eventId}</code>
        </p>
      )}
      <button type="button" onClick={resetError}>
        Try again
      </button>
    </div>
  );
}

// Only mount the Sentry ErrorBoundary when Sentry is actually enabled.
// In local dev / CI without a DSN we skip it so Vite's error overlay
// keeps working as expected.
const root = (
  <React.StrictMode>
    {isSentryEnabled ? (
      <Sentry.ErrorBoundary
        fallback={({ eventId, resetError }) => (
          <ErrorFallback eventId={eventId} resetError={resetError} />
        )}
      >
        <App />
      </Sentry.ErrorBoundary>
    ) : (
      <App />
    )}
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById('root')!).render(root);
