import { useProjectSettings } from '../hooks/useProjectSettings';
import type { ProjectSettings } from '../api/client';

interface Props {
  projectId: string;
}

type Toggle = 'captionsDefault' | 'showProgressBar' | 'showChoiceList';

const TOGGLES: { key: Toggle; label: string; hint: string }[] = [
  {
    key: 'captionsDefault',
    label: 'Captions on by default',
    hint: 'Show transcript text while audio plays. Users can still toggle this themselves.',
  },
  {
    key: 'showProgressBar',
    label: 'Show progress bar',
    hint: 'Display the audio progress bar under each node.',
  },
  {
    key: 'showChoiceList',
    label: 'Show choice list',
    hint: 'Render branching choices on-screen. Off makes the experience headphone- / keyboard-only — useful for purely audio-driven stories.',
  },
];

export default function PlayerDisplayTab({ projectId }: Props) {
  const { settings, loading, error, updateOne } = useProjectSettings(projectId);
  if (loading) return <div className="page-loader">Loading display...</div>;

  // Defaults: every UI option is on when unset (mirrors player-app
  // resolution — see player-app/src/App.tsx).
  function read(key: Toggle): boolean {
    return (settings?.[key as keyof ProjectSettings] as boolean | undefined) !== false;
  }

  return (
    <div className="tab-panel">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-section">
        <h2>Player display</h2>
        <p className="text-muted">
          Control what UI elements appear in the generated app for this project.
        </p>
        <ul className="ui-options-list">
          {TOGGLES.map((row) => (
            <li key={row.key} className="ui-option">
              <label>
                <input
                  type="checkbox"
                  checked={read(row.key)}
                  onChange={(e) => updateOne(row.key, e.target.checked)}
                />
                <div>
                  <strong>{row.label}</strong>
                  <p className="text-sm text-muted">{row.hint}</p>
                </div>
              </label>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
