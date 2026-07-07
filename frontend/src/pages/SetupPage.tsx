import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { initAdmin } from '../api/client';

export default function SetupPage() {
  const { setUser, clearSetup } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const { user, sessionFailed } = await initAdmin(email, password, displayName);
      clearSetup();
      if (sessionFailed) {
        navigate('/login');
      } else {
        setUser(user);
        navigate('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Welcome to Wanderline</h1>
        <p className="auth-subtitle">Create your admin account to get started.</p>

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}

          <label className="field">
            <span className="field-label">Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              autoFocus
              autoComplete="name"
              placeholder="Your name"
            />
          </label>

          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              inputMode="email"
              placeholder="admin@example.com"
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
              autoComplete="new-password"
              placeholder="At least 8 characters"
            />
          </label>

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? 'Creating account...' : 'Create admin account'}
          </button>
        </form>
      </div>
    </div>
  );
}
