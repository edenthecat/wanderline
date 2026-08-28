import { VOLUME_DEFAULTS } from '@wanderline/shared';
import { useProjectSettings } from '../hooks/useProjectSettings';

interface Props {
  projectId: string;
}

// Defaults the player applies when a setting is unset. These used to be
// literals repeated here; they now come from the same constant the
// player seeds its state from, so a slider can't claim one number while
// the listener hears another.
function defaultVolume(
  key: 'voiceoverVolume' | 'backgroundMusicVolume' | 'indicatorVolume',
): number {
  if (key === 'voiceoverVolume') return VOLUME_DEFAULTS.voiceover;
  if (key === 'backgroundMusicVolume') return VOLUME_DEFAULTS.backgroundMusic;
  return VOLUME_DEFAULTS.indicator;
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
