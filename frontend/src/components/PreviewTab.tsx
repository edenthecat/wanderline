import { useEffect, useState } from 'react';
import { ApiError, fetchMe } from '../api/client';

interface Props {
  projectId: string;
  hasStory: boolean;
}

/**
 * Embeds the player-app inside the editor via an iframe. The actual
 * player UI (audio playback, choices, navigation history, keyboard
 * shortcuts) all live in player-app/ — the editor just provides the
 * shell and a way to reset/pop out.
 */
export default function PreviewTab({ projectId, hasStory }: Props) {
  // Bumping this key forces React to recreate the iframe element, which
  // reloads the player from scratch — simplest possible "Restart" action.
  const [iframeKey, setIframeKey] = useState(0);
  const previewUrl = `/api/projects/${projectId}/preview`;

  // Session gate. The preview endpoint sits behind requireAuth, and
  // an expired session returns 401. Browsers render that 401 body
  // inside the iframe as raw text with no indication of what went
  // wrong, so we pre-check auth on mount and show a "please log in
  // again" affordance instead. See DEV-174.
  const [authStatus, setAuthStatus] = useState<'checking' | 'ok' | 'expired' | 'error'>('checking');
  useEffect(() => {
    let cancelled = false;
    setAuthStatus('checking');
    fetchMe()
      .then(() => {
        if (!cancelled) setAuthStatus('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setAuthStatus('expired');
        } else {
          setAuthStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, iframeKey]);

  if (!hasStory) {
    return (
      <div className="tab-panel">
        <div className="section-header">
          <h2>Preview</h2>
        </div>
        <div className="empty-state">
          <p>Upload a story file before previewing.</p>
        </div>
      </div>
    );
  }

  if (authStatus === 'expired') {
    return (
      <div className="tab-panel">
        <div className="section-header">
          <h2>Preview</h2>
        </div>
        <div className="empty-state">
          <p>Your session has expired. Please log in again to load the preview.</p>
          <p>
            <a className="btn btn-primary btn-sm" href="/login">
              Log in again
            </a>
          </p>
        </div>
      </div>
    );
  }

  if (authStatus === 'error') {
    return (
      <div className="tab-panel">
        <div className="section-header">
          <h2>Preview</h2>
        </div>
        <div className="empty-state">
          <p>Couldn&apos;t reach the server. Retry once you have a connection.</p>
          <p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setIframeKey((k) => k + 1)}
            >
              Retry
            </button>
          </p>
        </div>
      </div>
    );
  }

  if (authStatus === 'checking') {
    return (
      <div className="tab-panel">
        <div className="section-header">
          <h2>Preview</h2>
        </div>
        <div className="empty-state">
          <p>Loading preview...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-panel preview-tab">
      <div className="section-header preview-header">
        <h2>Preview</h2>
        <div className="preview-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setIframeKey((k) => k + 1)}
            aria-label="Restart preview from the start"
          >
            Restart
          </button>
          <a
            className="btn btn-ghost btn-sm"
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in new tab
          </a>
        </div>
      </div>
      <p className="text-muted text-sm preview-shortcuts-hint">
        Keyboard: <kbd>Space</kbd> play/pause · <kbd>↑</kbd>/<kbd>↓</kbd> choose · <kbd>Enter</kbd>{' '}
        select · <kbd>Backspace</kbd> back · <kbd>R</kbd> restart · <kbd>Esc</kbd> dismiss errors
      </p>
      <div className="preview-frame-wrap">
        <iframe
          key={iframeKey}
          src={previewUrl}
          title="Story preview"
          className="preview-frame"
          // sandbox keeps the iframe from navigating away or popping cookies
          // while still allowing scripts (the player needs them) and media.
          sandbox="allow-scripts allow-same-origin allow-popups"
          // Permissions-Policy delegation. Without an explicit
          // `allow="autoplay"`, Chromium-family browsers
          // intermittently block the child frame's autoplay + Media
          // Session bindings — one of the plausible triggers for
          // the "occasionally doesn't play when not focused" report.
          // Deliberately narrow: the player has no EME / DRM code,
          // so we don't delegate encrypted-media.
          allow="autoplay"
        />
      </div>
    </div>
  );
}
