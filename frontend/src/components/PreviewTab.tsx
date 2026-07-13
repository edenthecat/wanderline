import { useState } from 'react';

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
          // Permissions-Policy delegation. Without an explicit `allow`
          // attribute, Chromium-family browsers intermittently block
          // the child frame's autoplay + Media Session bindings —
          // which is one of the plausible triggers for the
          // "occasionally doesn't play when not focused" report.
          allow="autoplay; encrypted-media"
        />
      </div>
    </div>
  );
}
