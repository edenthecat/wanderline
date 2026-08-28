import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, fetchMe } from '../api/client';
import FlagNodeControl from './FlagNodeControl';

interface Props {
  projectId: string;
  hasStory: boolean;
  /** Passage the preview should open on, from a "Preview from here"
   * control elsewhere in the editor. null = the story's own start. */
  startNodeId?: string | null;
  /** Bumped by the parent on every "Preview from here" click. It is
   * the click, not the id, that means "go there now": asking for the
   * same passage twice — listen, fix the take, listen again — is the
   * review loop this whole feature exists for, and comparing ids alone
   * would make the second click do nothing. */
  startRequestNonce?: number;
}

/**
 * Embeds the player-app inside the editor via an iframe. The actual
 * player UI (audio playback, choices, navigation history, keyboard
 * shortcuts) all live in player-app/ — the editor just provides the
 * shell and a way to reset/pop out.
 */
export default function PreviewTab({
  projectId,
  hasStory,
  startNodeId = null,
  startRequestNonce = 0,
}: Props) {
  // Bumping this key forces React to recreate the iframe element, which
  // reloads the player from scratch — simplest possible "Restart" action.
  const [iframeKey, setIframeKey] = useState(0);

  // The passage this preview is pinned to. Seeded from the prop and
  // then owned here, so "Play from the beginning" can drop the pin
  // without having to reach back into the parent.
  const [pinnedNodeId, setPinnedNodeId] = useState<string | null>(startNodeId);
  // Set by "From the beginning". Dropping the pin is not enough on its
  // own: the player resumes its autosave when the URL asks for nothing,
  // and a preview that has been listened to HAS an autosave — so
  // clearing the pin alone lands the reviewer wherever they last got
  // to, under a button that promised the beginning. `?fresh=1` is the
  // player's "ignore saves this run" signal.
  const [forceFresh, setForceFresh] = useState(false);
  // Seeded with the incoming nonce rather than 0: the usual path into
  // this tab IS a "Preview from here" click, which mounts the component
  // with the request already in props. Starting at 0 would see a change
  // on first render and re-mount an iframe that had only just been
  // created.
  const seenNonceRef = useRef(startRequestNonce);
  useEffect(() => {
    if (startRequestNonce === seenNonceRef.current) return;
    seenNonceRef.current = startRequestNonce;
    setPinnedNodeId(startNodeId);
    setForceFresh(false);
    setIframeKey((k) => k + 1);
  }, [startRequestNonce, startNodeId]);

  // The passage currently on screen inside the preview, reported by
  // the player over postMessage. Drives the flag control: a reviewer
  // means "this one", and making them remember an id and go find it
  // afterwards is how a noticed problem becomes a forgotten one.
  const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Same-origin only. The preview is served from this app, so
      // anything from elsewhere has no business moving this state.
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; nodeId?: unknown } | null;
      if (!data || data.type !== 'wanderline:node') return;
      if (typeof data.nodeId === 'string') setPreviewNodeId(data.nodeId);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // A restart drops us back to the start; clear rather than let the
  // flag control keep naming the passage we were on before.
  useEffect(() => {
    setPreviewNodeId(null);
  }, [iframeKey]);
  // The player reads these off its own location, so they ride in on the
  // iframe src — and on "Open in new tab" too, or popping the preview
  // out would silently lose what the reviewer asked for. With neither
  // set the player behaves exactly as it always has, autosave included.
  const previewQuery = pinnedNodeId
    ? `?start=${encodeURIComponent(pinnedNodeId)}`
    : forceFresh
      ? '?fresh=1'
      : '';
  const previewUrl = `/api/projects/${projectId}/preview${previewQuery}`;

  // Session gate. The preview endpoint sits behind requireAuth,
  // and an expired session returns 401. Browsers render that 401
  // body inside the iframe as raw text with no indication of what
  // went wrong, so we pre-check auth on mount and show a "please
  // log in again" affordance instead.
  //
  // Kept separate from iframeKey on purpose: iframeKey re-mounts
  // the iframe (Restart button) and shouldn't spend a round-trip
  // re-checking auth we already know is good. authAttempt is bumped
  // only by the Retry button in the error state.
  const [authStatus, setAuthStatus] = useState<'checking' | 'ok' | 'expired' | 'error'>('checking');
  const [authAttempt, setAuthAttempt] = useState(0);
  useEffect(() => {
    // Skip the auth ping when the empty-state ("Upload a story
    // file") is going to render anyway. Saves an /api/auth/me
    // round trip for every visit to a fresh project.
    if (!hasStory) return;
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
  }, [projectId, authAttempt, hasStory]);

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
            <Link className="btn btn-primary btn-sm" to="/login">
              Log in again
            </Link>
          </p>
        </div>
      </div>
    );
  }

  if (authStatus === 'error') {
    // Catches network failures AND non-401 API errors (5xx, DNS,
    // timeouts). Wording covers both without pretending to know
    // which one hit.
    return (
      <div className="tab-panel">
        <div className="section-header">
          <h2>Preview</h2>
        </div>
        <div className="empty-state">
          <p>Something went wrong loading the preview. Retry, or try again in a minute.</p>
          <p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setAuthAttempt((n) => n + 1)}
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
          {/* Restart replays whatever this preview is set to — the
              pinned passage when there is one. That is the review loop:
              hear the problem, fix the take, hear it again. Getting
              dropped back at the top of a forty-minute story instead is
              exactly what made verifying a fix not worth doing. */}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setIframeKey((k) => k + 1)}
            aria-label={
              pinnedNodeId
                ? `Restart preview from ${pinnedNodeId}`
                : 'Restart preview from the start'
            }
          >
            Restart
          </button>
          {pinnedNodeId && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setPinnedNodeId(null);
                setForceFresh(true);
                setIframeKey((k) => k + 1);
              }}
              aria-label="Play the preview from the beginning of the story"
            >
              From the beginning
            </button>
          )}
          <FlagNodeControl projectId={projectId} nodeId={previewNodeId} />
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
      {pinnedNodeId && (
        <p className="text-sm preview-start-pin" role="status">
          Starting from <code>{pinnedNodeId}</code>
        </p>
      )}
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
