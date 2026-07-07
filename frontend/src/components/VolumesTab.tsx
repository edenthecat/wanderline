import { useProjectSettings } from '../hooks/useProjectSettings';

interface Props {
  projectId: string;
}

// Defaults the player applies when a setting is unset. Kept in sync
// with player-app/src/App.tsx's `?? <value>` fallbacks so the slider
// reflects the same number the listener experiences before any
// override.
function defaultVolume(
  key: 'voiceoverVolume' | 'backgroundMusicVolume' | 'indicatorVolume',
): number {
  if (key === 'voiceoverVolume') return 100;
  if (key === 'backgroundMusicVolume') return 30;
  return 50;
}

const ROWS = [
  {
    key: 'voiceoverVolume' as const,
    label: 'Voiceover',
    hint: 'Narration playback.',
  },
  {
    key: 'backgroundMusicVolume' as const,
    label: 'Background music',
    hint: 'Looped ambient tracks (no-op if no music is uploaded).',
  },
  {
    key: 'indicatorVolume' as const,
    label: 'Choice & UI sounds',
    hint: 'Indicator and selection beeps.',
  },
];

export default function VolumesTab({ projectId }: Props) {
  const { settings, loading, error, updateDebounced } = useProjectSettings(projectId);
  if (loading) return <div className="page-loader">Loading volumes...</div>;

  return (
    <div className="tab-panel">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-section">
        <h2>Default volumes</h2>
        <p className="text-muted">
          Starting volumes for the generated app. Listeners can adjust at runtime from the
          player&apos;s settings panel.
        </p>
        <ul className="ui-options-list">
          {ROWS.map((row) => {
            const value = (settings?.[row.key] as number | undefined) ?? defaultVolume(row.key);
            return (
              <li key={row.key} className="ui-option settings-volume-row">
                <div className="settings-volume-meta">
                  <strong>{row.label}</strong>
                  <p className="text-sm text-muted">{row.hint}</p>
                </div>
                <div className="settings-volume-control">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={value}
                    onChange={(e) => updateDebounced(row.key, Number(e.target.value))}
                    aria-label={`${row.label} default volume`}
                    aria-valuetext={`${value} percent`}
                  />
                  <span className="settings-volume-value" aria-hidden="true">
                    {value}%
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
