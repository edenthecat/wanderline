import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  fetchProjectSettings,
  updateProjectSettings,
  deleteAllProjectAudio,
  deleteProject,
  fetchPublicPreview,
  enablePublicPreview,
  disablePublicPreview,
  type ProjectSettings,
  type PublicPreviewState,
} from '../api/client';

interface Props {
  projectId: string;
  /** Used by the "Delete this project" confirmation so the user has
   * to type the project's name verbatim — matches the GitHub pattern
   * and is stronger than a button-only confirm for a permanently
   * destructive action. */
  projectName: string;
  // Signals other tabs (AudioTab) to refetch when this tab nukes
  // project-level state — without this, AudioTab keeps its stale list
  // after "Delete all audio" and per-row deletes 404.
  onProjectDataInvalidated?: () => void;
}

// Slimmed-down Settings page: just access control + the destructive
// "delete all audio" action. Every other setting moved to its own
// workspace tool (Volumes, System sounds, Headphone controls,
// Player display) under the appropriate sidebar group.
export default function SettingsTab({ projectId, projectName, onProjectDataInvalidated }: Props) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Typed-name confirmation for permanently deleting the entire project.
  // We keep this gated separately from the audio-delete confirm because
  // it's an order-of-magnitude more destructive: there's no recovery
  // path for the story graph + characters + builds + audio + history.
  const [projectDeleteOpen, setProjectDeleteOpen] = useState(false);
  const [projectDeleteName, setProjectDeleteName] = useState('');
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState<string | null>(null);
  const [publicPreview, setPublicPreview] = useState<PublicPreviewState>({
    enabled: false,
    token: null,
    url: null,
  });
  const [publicPreviewSaving, setPublicPreviewSaving] = useState(false);
  const [publicPreviewError, setPublicPreviewError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  // Track the "Copied" affordance timer so we can clear it on
  // subsequent copies + on unmount. Without this, a fast re-click
  // or a route change during the 2s window can either double-schedule
  // the reset or fire setCopyState after unmount.
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setError(null);
    setConfirmDelete(false);
    setProjectDeleteOpen(false);
    setProjectDeleteName('');
    setProjectDeleteError(null);
    setPublicPreviewError(null);
    setCopyState('idle');
    // Reset before the fetch so switching projects doesn't briefly
    // render the previous project's link/toggle state while the
    // load is in flight (or forever if the load errors).
    setPublicPreview({ enabled: false, token: null, url: null });
    setLoading(true);
    loadSettings();
    loadPublicPreview();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear any pending copy-state reset on unmount to avoid the
  // React "setState on unmounted component" warning + stale-timer
  // races.
  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  async function loadPublicPreview() {
    // Set the same "saving" flag the toggle checks so the user
    // can't click before the initial fetch resolves — otherwise a
    // late GET response would clobber an already-in-flight
    // POST/DELETE the user had triggered mid-load.
    setPublicPreviewSaving(true);
    try {
      const state = await fetchPublicPreview(projectId);
      setPublicPreview(state);
    } catch (err) {
      // Non-fatal; the settings page still renders, the Share row
      // just shows an inline error.
      setPublicPreviewError(err instanceof Error ? err.message : 'Failed to load share state');
    } finally {
      setPublicPreviewSaving(false);
    }
  }

  async function handleTogglePublicPreview(next: boolean) {
    setPublicPreviewSaving(true);
    setPublicPreviewError(null);
    setCopyState('idle');
    try {
      if (next) {
        const state = await enablePublicPreview(projectId);
        setPublicPreview(state);
      } else {
        await disablePublicPreview(projectId);
        // Preserve the token client-side so the "off" state shows
        // the URL will resume on re-enable; server preserves it too.
        setPublicPreview((prev) => ({ ...prev, enabled: false }));
      }
    } catch (err) {
      setPublicPreviewError(err instanceof Error ? err.message : 'Failed to update public preview');
    } finally {
      setPublicPreviewSaving(false);
    }
  }

  async function handleCopyPublicPreview() {
    if (!publicPreview.url) return;
    const absoluteUrl = new URL(publicPreview.url, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopyState('copied');
      // Cancel any in-flight reset from a prior copy so we don't
      // race two timers ending on top of each other; unmount clears
      // the same ref via the effect above.
      if (copyResetTimerRef.current !== null) {
        clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = setTimeout(() => {
        copyResetTimerRef.current = null;
        setCopyState('idle');
      }, 2000);
    } catch {
      setPublicPreviewError('Clipboard permission denied. Copy the URL manually.');
    }
  }

  async function loadSettings() {
    try {
      const { settings: data } = await fetchProjectSettings(projectId);
      setSettings(data);
      setPassword(data.password || '');
      setError(null);
    } catch (err) {
      setSettings({});
      setPassword('');
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  async function handleSavePassword() {
    setSaving(true);
    setError(null);
    try {
      // Send the literal string (including '') so the server can clear
      // an existing password. Previously this sent `undefined`, which
      // JSON.stringify drops — clicking Save on an empty input was a
      // silent no-op even though the button was enabled.
      const { settings: updated } = await updateProjectSettings(projectId, { password });
      setSettings(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemovePassword() {
    setSaving(true);
    setError(null);
    try {
      const { settings: updated } = await updateProjectSettings(projectId, { password: '' });
      setSettings(updated);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove password');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAllAudio() {
    setDeleting(true);
    setError(null);
    try {
      await deleteAllProjectAudio(projectId);
      setConfirmDelete(false);
      onProjectDataInvalidated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete audio');
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteProject() {
    if (projectDeleteName !== projectName) return;
    setDeletingProject(true);
    setProjectDeleteError(null);
    try {
      await deleteProject(projectId);
      // The project is gone — there's no detail view to return to.
      // `replace: true` so the back button doesn't bring the user
      // back into a 404'd project route.
      navigate('/', { replace: true });
    } catch (err) {
      // If a peer (or another tab) deleted this project first the
      // server returns 404. The user typed the name correctly and
      // the project is genuinely gone — that's success, not an
      // error. Navigate home instead of leaving them on a stale
      // page that will 404 on their next interaction.
      if (err instanceof ApiError && err.status === 404) {
        navigate('/', { replace: true });
        return;
      }
      setProjectDeleteError(err instanceof Error ? err.message : 'Failed to delete project');
      setDeletingProject(false);
    }
  }

  if (loading) return <div className="page-loader">Loading settings...</div>;

  const hasPassword = !!settings?.password;

  return (
    <div className="tab-panel">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <section className="settings-section">
        <h2>Password protection</h2>
        <p className="text-muted">
          Set a password to protect the generated app. Users will need to enter this password before
          accessing the content.
        </p>
        <div className="settings-row">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            aria-label="Project password"
          />
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSavePassword}
            disabled={saving || password === (settings?.password ?? '')}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {hasPassword && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleRemovePassword}
              disabled={saving}
            >
              Remove
            </button>
          )}
        </div>
        {hasPassword && (
          <p className="text-sm text-muted" style={{ marginTop: 8 }}>
            Password is currently set.
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2>Share preview</h2>
        <p className="text-muted">
          Turn on a public link so anyone can hear the current draft in a browser without signing
          in. Toggle off any time to revoke access; the link keeps working across on/off cycles so
          you can share it once and re-enable later without re-sharing.
        </p>
        {publicPreviewError && (
          <div className="alert alert-error" role="alert" style={{ marginBottom: 8 }}>
            {publicPreviewError}
          </div>
        )}
        <div className="settings-row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={publicPreview.enabled}
              onChange={(e) => handleTogglePublicPreview(e.target.checked)}
              disabled={publicPreviewSaving}
              aria-label="Public preview link"
            />
            Public preview link
          </label>
        </div>
        {publicPreview.enabled && publicPreview.url && (
          <div className="settings-row" style={{ marginTop: 8 }}>
            <input
              type="text"
              readOnly
              value={new URL(publicPreview.url, window.location.origin).toString()}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Public preview URL"
              style={{ flex: 1, fontFamily: 'monospace' }}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={handleCopyPublicPreview}
              disabled={publicPreviewSaving}
            >
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>Nomenclature</h2>
        <p className="text-muted">
          Which terminology should the app use? By default, labels follow whichever format the
          project was imported from — Ink&apos;s knot / stitch / choice / divert, or Twee&apos;s
          passage / link. Override here if you&apos;d rather lock the vocabulary independent of
          source.
        </p>
        <div className="settings-row">
          {(['auto', 'ink', 'twee'] as const).map((option) => {
            // Validate rather than cast: hand-edited JSONB or a
            // earlier row can hold something outside the allowed
            // set. A bare type-cast would leave every radio unchecked
            // and confuse the user into thinking the setting is broken.
            const raw = settings?.nomenclature;
            const current: 'auto' | 'ink' | 'twee' =
              raw === 'ink' || raw === 'twee' || raw === 'auto' ? raw : 'auto';
            const label =
              option === 'auto'
                ? 'Match source language'
                : option === 'ink'
                  ? 'Always Ink'
                  : 'Always Twee';
            return (
              <label key={option} className="settings-radio">
                <input
                  type="radio"
                  name="nomenclature"
                  value={option}
                  checked={current === option}
                  disabled={saving}
                  onChange={async () => {
                    setSaving(true);
                    setError(null);
                    try {
                      const { settings: updated } = await updateProjectSettings(projectId, {
                        nomenclature: option,
                      });
                      setSettings(updated);
                      // Other tabs (StoryTab, GraphTab) read the vocab
                      // from project.settings.nomenclature via
                      // ProjectDetailPage. Without a parent-side
                      // refetch, the vocab in those tabs would stay
                      // stale until the next full page load.
                      onProjectDataInvalidated?.();
                    } catch (err) {
                      setError(
                        err instanceof Error ? err.message : 'Failed to update nomenclature',
                      );
                    } finally {
                      setSaving(false);
                    }
                  }}
                />
                {label}
              </label>
            );
          })}
        </div>
      </section>

      <section className="settings-section settings-danger">
        <h2>Danger zone</h2>
        <h3 className="settings-subhead">Delete all audio</h3>
        <p className="text-muted">
          Delete every audio file in this project (assignments cascade). Useful when starting over
          with a fresh recording session. The story graph is preserved.
        </p>
        {confirmDelete ? (
          <div className="settings-row">
            <span className="text-sm">Are you sure? This can&apos;t be undone.</span>
            <button
              className="btn btn-danger btn-sm"
              onClick={handleDeleteAllAudio}
              disabled={deleting}
            >
              {deleting ? 'Deleting…' : 'Yes, delete all audio'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
            Delete all audio
          </button>
        )}

        <hr className="settings-danger-divider" />

        <h3 className="settings-subhead">Delete this project</h3>
        <p className="text-muted">
          Permanently remove this project and everything in it: story, audio files, builds,
          characters, snapshots, transcripts, audio assignments. There is no recovery path.
        </p>
        {projectDeleteOpen ? (
          <div className="settings-project-delete">
            <label className="settings-project-delete-prompt">
              Type{' '}
              <code>
                <strong>{projectName}</strong>
              </code>{' '}
              to confirm:
              <input
                type="text"
                className="settings-project-delete-input"
                value={projectDeleteName}
                onChange={(e) => setProjectDeleteName(e.target.value)}
                placeholder={projectName}
                // No aria-label — the wrapping <label> carries the
                // project name verbatim, which is what the user needs
                // to type. An explicit aria-label would override that
                // and erase the name from the accessible name.
                autoFocus
                disabled={deletingProject}
                data-testid="settings-delete-project-input"
              />
            </label>
            <div className="settings-row">
              <button
                className="btn btn-danger btn-sm"
                onClick={handleDeleteProject}
                disabled={projectDeleteName !== projectName || deletingProject}
                data-testid="settings-delete-project-confirm"
              >
                {deletingProject ? 'Deleting…' : 'Delete project forever'}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setProjectDeleteOpen(false);
                  setProjectDeleteName('');
                  setProjectDeleteError(null);
                }}
                disabled={deletingProject}
              >
                Cancel
              </button>
            </div>
            {projectDeleteError && (
              <p className="text-sm text-danger" role="alert">
                {projectDeleteError}
              </p>
            )}
          </div>
        ) : (
          <button
            className="btn btn-danger btn-sm"
            onClick={() => setProjectDeleteOpen(true)}
            data-testid="settings-delete-project-open"
          >
            Delete this project
          </button>
        )}
      </section>
    </div>
  );
}
