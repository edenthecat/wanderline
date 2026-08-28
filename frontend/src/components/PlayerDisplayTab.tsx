import { useProjectSettings } from '../hooks/useProjectSettings';
import type { ProjectSettings } from '../api/client';

interface Props {
  projectId: string;
}

type Toggle = 'captionsDefault' | 'showProgressBar' | 'showChoiceList' | 'autoAdvance';

/** `defaultOn: false` for options that stay off unless asked for. */
const TOGGLES: { key: Toggle; label: string; hint: string; defaultOn?: boolean }[] = [
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
    key: 'autoAdvance',
    label: 'Advance automatically (default)',
    hint: 'Where each listener\u2019s own "Advance automatically" toggle starts. On, the story moves to the next passage once narration ends, but only where there is a single way forward — a passage that asks for a decision always waits. Off by default. A listener who changes it keeps their choice, and changing this later will not override them.',
    defaultOn: false,
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

  // Defaults mirror the player's own resolution (player-app/src/App.tsx).
  // Display options are on when unset; auto-advance is off unless the
  // author turns it on, so it can't be read with the same `!== false`.
  function read(row: (typeof TOGGLES)[number]): boolean {
    const value = settings?.[row.key as keyof ProjectSettings] as boolean | undefined;
    if (typeof value === 'boolean') return value;
    return row.defaultOn !== false;
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
                  checked={read(row)}
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
