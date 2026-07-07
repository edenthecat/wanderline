import { useEffect, useState } from 'react';
import { fetchAudioFiles, type AudioFile } from '../api/client';
import { useProjectSettings } from '../hooks/useProjectSettings';

interface Props {
  projectId: string;
}

export default function SystemSoundsTab({ projectId }: Props) {
  const { settings, loading, error, updateOne } = useProjectSettings(projectId);
  const [indicatorAudio, setIndicatorAudio] = useState<AudioFile[]>([]);

  useEffect(() => {
    fetchAudioFiles(projectId)
      .then(({ audioFiles }) => {
        setIndicatorAudio(audioFiles.filter((f) => f.category === 'indicator'));
      })
      .catch(() => {});
  }, [projectId]);

  if (loading) return <div className="page-loader">Loading sounds...</div>;

  return (
    <div className="tab-panel">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-section">
        <h2>System sounds</h2>
        <p className="text-muted">
          Pick a default indicator beep for the generated app. The player uses this sound when
          presenting choices unless a node has its own choice audio assigned. Upload more options
          under <em>Voice &amp; sound → Audio</em> in the <code>indicator</code> category.
        </p>
        <div className="settings-row">
          <select
            className="select"
            value={settings?.defaultIndicatorAudioId ?? ''}
            onChange={(e) => updateOne('defaultIndicatorAudioId', e.target.value || null)}
            aria-label="Default indicator sound"
          >
            <option value="">(none — silent)</option>
            {indicatorAudio.map((f) => (
              <option key={f.id} value={f.id}>
                {f.original_name}
              </option>
            ))}
          </select>
          {indicatorAudio.length === 0 && (
            <span className="text-muted text-sm">No indicator-category audio uploaded yet.</span>
          )}
        </div>
      </section>
    </div>
  );
}
