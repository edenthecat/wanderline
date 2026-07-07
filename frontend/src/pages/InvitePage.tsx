import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  lookupInvitationToken,
  acceptInvitation,
  ApiError,
  type PublicInvitation,
} from '../api/client';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; invitation: PublicInvitation }
  | { kind: 'expired' }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setLoadState({ kind: 'not_found' });
      return;
    }
    (async () => {
      try {
        const { invitation } = await lookupInvitationToken(token);
        if (!cancelled) setLoadState({ kind: 'ok', invitation });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          if (err.status === 410) {
            setLoadState({ kind: 'expired' });
            return;
          }
          if (err.status === 404) {
            setLoadState({ kind: 'not_found' });
            return;
          }
        }
        setLoadState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to load invitation',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitError(null);
    if (password !== passwordConfirm) {
      setSubmitError('Passwords do not match.');
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setSubmitError('Password must be between 8 and 128 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const { user } = await acceptInvitation(token, displayName.trim(), password);
      setUser(user);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) {
        setLoadState({ kind: 'expired' });
        return;
      }
      setSubmitError(err instanceof Error ? err.message : 'Sign-up failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadState.kind === 'loading') {
    return <div className="page-loader">Loading invitation...</div>;
  }

  if (loadState.kind === 'expired') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Wanderline</h1>
          <p className="auth-subtitle">This invitation is no longer valid</p>
          <p className="text-muted">
            The link has expired, been revoked, or already been used. Ask your admin to send a fresh
            invitation.
          </p>
          <Link to="/login" className="btn btn-primary btn-full">
            Go to sign-in
          </Link>
        </div>
      </div>
    );
  }

  if (loadState.kind === 'not_found') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Wanderline</h1>
          <p className="auth-subtitle">Invitation not found</p>
          <p className="text-muted">
            We couldn&apos;t find that invitation. Double-check the link your admin sent you.
          </p>
          <Link to="/login" className="btn btn-primary btn-full">
            Go to sign-in
          </Link>
        </div>
      </div>
    );
  }

  if (loadState.kind === 'error') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Wanderline</h1>
          <p className="auth-subtitle">Something went wrong</p>
          <div className="alert alert-error">{loadState.message}</div>
          <Link to="/login" className="btn btn-ghost btn-full">
            Back to sign-in
          </Link>
        </div>
      </div>
    );
  }

  const { invitation } = loadState;

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Wanderline</h1>
        <p className="auth-subtitle">
          You&apos;ve been invited as <strong>{invitation.role}</strong>
        </p>

        <form onSubmit={handleSubmit} className="auth-form" data-testid="invite-accept-form">
          <div aria-live="polite" aria-atomic="true">
            {submitError && <div className="alert alert-error">{submitError}</div>}
          </div>

          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              value={invitation.email}
              readOnly
              aria-label="Email address (not editable)"
            />
          </label>

          <label className="field">
            <span className="field-label">Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              autoFocus
              // Mirrors users.display_name VARCHAR(255) so the server
              // doesn't 500 on oversized input from a hand-crafted form.
              maxLength={255}
              placeholder="Jane Smith"
            />
          </label>

          <label className="field">
            <span className="field-label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              maxLength={128}
              placeholder="8–128 characters"
              autoComplete="new-password"
            />
          </label>

          <label className="field">
            <span className="field-label">Confirm password</span>
            <input
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              required
              minLength={8}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={submitting || !displayName.trim()}
          >
            {submitting ? 'Creating account...' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
