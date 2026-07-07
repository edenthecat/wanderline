// dedicated panel for background music. The audio model
// already supports music as a category (story_data_builder pulls
// audio_files where category='music' into storyData.backgroundMusic,
// and the build pipeline copies them into the artifact) — what
// was missing was a clearer authoring surface. AudioTab still
// supports the same upload via the category dropdown; this tab
// just makes the music workflow first-class.
//
// Listed tracks play in alphabetical order (matching the build
// pipeline's sort). Future work could add explicit ordering or
// per-track loop / volume controls.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { fetchAudioFiles, uploadAudioFile, deleteAudioFile, type AudioFile } from '../api/client';

interface Props {
  projectId: string;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MusicTab({ projectId }: Props) {
  const [tracks, setTracks] = useState<AudioFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const { audioFiles } = await fetchAudioFiles(projectId);
      setTracks(
        audioFiles
          .filter((f) => f.category === 'music')
          .sort((a, b) => a.original_name.localeCompare(b.original_name)),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load music');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await uploadAudioFile(projectId, file, 'music');
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      // Clear the input in finally — if upload failed and we left
      // the same filename selected, the browser won't fire onChange
      // when the user picks it again to retry. AudioTab's upload
      // handler does the same.
      if (fileInputRef.current) fileInputRef.current.value = '';
      setUploading(false);
    }
  }

  async function handleDelete(track: AudioFile) {
    if (!window.confirm(`Remove "${track.original_name}" from background music?`)) return;
    setError(null);
    try {
      await deleteAudioFile(projectId, track.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <section className="tab-panel music-tab" data-testid="music-tab">
      <header>
        <h2>Background music</h2>
        <p className="text-muted">
          Tracks listed here play as background music in the generated game. They loop in the order
          they appear (alphabetical). To add ambience tied to a specific node, use the Audio tab and
          assign with type &ldquo;ambience&rdquo;.
        </p>
      </header>

      <div className="music-upload">
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          onChange={handleUpload}
          disabled={uploading}
          aria-label="Upload music"
          data-testid="music-upload-input"
        />
        {uploading && <span className="text-muted">Uploading…</span>}
      </div>

      {error && (
        <div className="alert alert-danger" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-muted">Loading…</p>
      ) : tracks.length === 0 ? (
        <p className="text-muted">No background music yet. Drop a track above to add one.</p>
      ) : (
        <ul className="music-list" data-testid="music-list">
          {tracks.map((track) => (
            <li key={track.id} className="music-item" data-testid="music-row">
              <div className="music-item-meta">
                <strong>{track.original_name}</strong>
                <span className="text-muted text-sm">{formatBytes(track.size_bytes)}</span>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => handleDelete(track)}
                data-testid="music-delete-btn"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
