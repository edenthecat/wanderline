import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
  fetchUsers,
  createUser,
  updateUser,
  fetchInvitations,
  createInvitation,
  revokeInvitation,
  type ManagedUser,
  type UserRole,
  type PendingInvitation,
} from '../api/client';

export default function UserManagementPage() {
  const { user: currentUser } = useAuth();

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add user form
  const [showForm, setShowForm] = useState(false);
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<UserRole>('editor');
  const [creating, setCreating] = useState(false);

  // Track in-flight updates per user to disable controls
  const [updatingUsers, setUpdatingUsers] = useState<Set<string>>(new Set());

  // invitation panel state
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<UserRole>('editor');
  const [creatingInvite, setCreatingInvite] = useState(false);
  // Most recently generated magic link — shown ONCE per the backend's
  // "raw token returned once" contract. Dismissing this state removes
  // the link forever; the admin must regenerate to get a new one.
  const [latestMagicLink, setLatestMagicLink] = useState<{
    url: string;
    email: string;
  } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [revokingInvites, setRevokingInvites] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadUsers();
    loadInvitations();
  }, []);

  async function loadInvitations() {
    try {
      const { invitations: data } = await fetchInvitations();
      setInvitations(data);
    } catch (err) {
      // Surface in the same error region; not fatal — users can still load.
      setError(err instanceof Error ? err.message : 'Failed to load invitations');
    }
  }

  async function handleCreateInvitation(e: FormEvent) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setCreatingInvite(true);
    setError(null);
    try {
      const { magicLinkUrl, invitation } = await createInvitation(inviteEmail.trim(), inviteRole);
      setLatestMagicLink({ url: magicLinkUrl, email: invitation.email });
      setLinkCopied(false);
      setInviteEmail('');
      setInviteRole('editor');
      setShowInviteForm(false);
      await loadInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invitation');
    } finally {
      setCreatingInvite(false);
    }
  }

  async function handleRevokeInvitation(id: string) {
    setRevokingInvites((prev) => new Set(prev).add(id));
    setError(null);
    try {
      await revokeInvitation(id);
      await loadInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke invitation');
    } finally {
      setRevokingInvites((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleCopyMagicLink() {
    if (!latestMagicLink) return;
    try {
      await navigator.clipboard.writeText(latestMagicLink.url);
      setLinkCopied(true);
    } catch {
      // navigator.clipboard can fail in non-secure contexts — fall
      // back to keeping the text selectable so the admin can copy by
      // hand.
      setLinkCopied(false);
    }
  }

  async function loadUsers() {
    try {
      const { users: data } = await fetchUsers();
      setUsers(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!formDisplayName.trim() || !formEmail.trim() || !formPassword) return;
    setCreating(true);
    setError(null);

    try {
      await createUser(formEmail, formPassword, formDisplayName, formRole);
      setFormDisplayName('');
      setFormEmail('');
      setFormPassword('');
      setFormRole('editor');
      setShowForm(false);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(targetUser: ManagedUser) {
    setUpdatingUsers((prev) => new Set(prev).add(targetUser.id));
    setError(null);

    try {
      await updateUser(targetUser.id, { isActive: !targetUser.isActive });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setUpdatingUsers((prev) => {
        const next = new Set(prev);
        next.delete(targetUser.id);
        return next;
      });
    }
  }

  async function handleRoleChange(targetUser: ManagedUser, newRole: UserRole) {
    if (newRole === targetUser.role) return;
    setUpdatingUsers((prev) => new Set(prev).add(targetUser.id));
    setError(null);

    try {
      await updateUser(targetUser.id, { role: newRole });
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    } finally {
      setUpdatingUsers((prev) => {
        const next = new Set(prev);
        next.delete(targetUser.id);
        return next;
      });
    }
  }

  if (loading) return <div className="page-loader">Loading users...</div>;

  const isSelf = (u: ManagedUser) => u.id === currentUser?.id;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Users</h1>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'Add user'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {showForm && (
        <form onSubmit={handleCreate} className="card create-form">
          <label className="field">
            <span className="field-label">Display name</span>
            <input
              type="text"
              value={formDisplayName}
              onChange={(e) => setFormDisplayName(e.target.value)}
              required
              autoFocus
              placeholder="Jane Smith"
            />
          </label>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              value={formEmail}
              onChange={(e) => setFormEmail(e.target.value)}
              required
              placeholder="jane@example.com"
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              type="password"
              value={formPassword}
              onChange={(e) => setFormPassword(e.target.value)}
              required
              minLength={8}
              maxLength={128}
              placeholder="8–128 characters"
            />
          </label>
          <label className="field">
            <span className="field-label">Role</span>
            <select
              className="select"
              value={formRole}
              onChange={(e) => setFormRole(e.target.value as UserRole)}
            >
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Creating...' : 'Create user'}
          </button>
        </form>
      )}

      <section className="card" style={{ marginBottom: 24 }} data-testid="invitations-section">
        <div className="page-header" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Pending invitations</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowInviteForm((v) => !v)}>
            {showInviteForm ? 'Cancel invite' : 'Invite user'}
          </button>
        </div>
        <p className="text-muted text-sm">
          Generate a one-time magic link, then share it with the recipient through any channel.
          They&apos;ll pick their own password when they accept.
        </p>

        {showInviteForm && (
          <form onSubmit={handleCreateInvitation} className="create-form" data-testid="invite-form">
            <label className="field">
              <span className="field-label">Email</span>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
                autoFocus
                placeholder="recipient@example.com"
              />
            </label>
            <label className="field">
              <span className="field-label">Role</span>
              <select
                className="select"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as UserRole)}
              >
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary" disabled={creatingInvite}>
              {creatingInvite ? 'Generating...' : 'Generate magic link'}
            </button>
          </form>
        )}

        {latestMagicLink && (
          <div
            className="alert"
            data-testid="invite-magic-link"
            style={{
              background: 'var(--color-success-bg, #ecfdf5)',
              borderColor: 'var(--color-success, #10b981)',
              color: 'var(--color-success-text, #065f46)',
              marginTop: 12,
            }}
          >
            <div style={{ marginBottom: 8 }}>
              <strong>Magic link for {latestMagicLink.email}</strong>
              <p className="text-sm" style={{ margin: '4px 0 0' }}>
                This link is shown <strong>once</strong>. Copy it now — re-fetching the invitation
                list won&apos;t bring it back.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={latestMagicLink.url}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                aria-label="Magic link URL"
              />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={handleCopyMagicLink}
              >
                {linkCopied ? 'Copied!' : 'Copy'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setLatestMagicLink(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {invitations.length === 0 ? (
          <p className="text-muted text-sm" style={{ marginTop: 12 }}>
            No pending invitations.
          </p>
        ) : (
          <div className="table-scroll" style={{ marginTop: 12 }}>
            <table className="table">
              <caption>Pending invitations</caption>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Expires</th>
                  <th>Created</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => {
                  const busy = revokingInvites.has(inv.id);
                  return (
                    <tr key={inv.id} data-testid="invitation-row">
                      <td>{inv.email}</td>
                      <td>{inv.role}</td>
                      <td className="text-muted text-sm">
                        <time dateTime={inv.expiresAt}>
                          {new Date(inv.expiresAt).toLocaleString()}
                        </time>
                      </td>
                      <td className="text-muted text-sm">
                        <time dateTime={inv.createdAt}>
                          {new Date(inv.createdAt).toLocaleDateString()}
                        </time>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => handleRevokeInvitation(inv.id)}
                          disabled={busy}
                          aria-label={`Revoke invitation for ${inv.email}`}
                        >
                          {busy ? 'Revoking...' : 'Revoke'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {users.length === 0 && !error ? (
        <div className="empty-state">
          <p>No users found.</p>
        </div>
      ) : users.length > 0 ? (
        <div className="card table-scroll" style={{ padding: 0 }}>
          <table className="table">
            <caption>Users</caption>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const busy = updatingUsers.has(u.id);
                return (
                  <tr key={u.id}>
                    <td>
                      {u.displayName}
                      {isSelf(u) && <span className="text-muted text-sm"> (you)</span>}
                    </td>
                    <td>{u.email}</td>
                    <td>
                      <select
                        className="select"
                        value={u.role}
                        onChange={(e) => handleRoleChange(u, e.target.value as UserRole)}
                        disabled={busy || isSelf(u)}
                        aria-label={`Role for ${u.displayName}`}
                      >
                        <option value="editor">Editor</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td>
                      <span className={u.isActive ? 'badge badge-green' : 'badge badge-gray'}>
                        {u.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="text-muted text-sm">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td>
                      <button
                        className={`btn btn-sm ${u.isActive ? 'btn-danger' : 'btn-ghost'}`}
                        onClick={() => handleToggleActive(u)}
                        disabled={busy || isSelf(u)}
                        aria-label={`${u.isActive ? 'Deactivate' : 'Activate'} ${u.displayName}`}
                      >
                        {u.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
