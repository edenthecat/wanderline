import {
  type BluetoothControls,
  type BluetoothNextAction,
  type BluetoothPrevAction,
} from '../api/client';
import { useProjectSettings } from '../hooks/useProjectSettings';

interface Props {
  projectId: string;
}

export default function HeadphoneControlsTab({ projectId }: Props) {
  const { settings, loading, error, updateOne } = useProjectSettings(projectId);

  if (loading) return <div className="page-loader">Loading controls...</div>;

  const nextAction: BluetoothNextAction = settings?.bluetoothControls?.nextTrack ?? 'choice1';
  const prevAction: BluetoothPrevAction = settings?.bluetoothControls?.previousTrack ?? 'choice2';

  function update(key: 'nextTrack' | 'previousTrack', value: string) {
    const next: BluetoothControls = { ...(settings?.bluetoothControls ?? {}) };
    if (key === 'nextTrack') next.nextTrack = value as BluetoothNextAction;
    else next.previousTrack = value as BluetoothPrevAction;
    void updateOne('bluetoothControls', next);
  }

  return (
    <div className="tab-panel">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      <section className="settings-section">
        <h2>Headphone controls</h2>
        <p className="text-muted">
          The generated app maps Bluetooth headphone buttons to story actions via the browser&apos;s
          MediaSession API. Play / pause and click gestures are fixed; the track buttons are
          configurable so authors can match their audience&apos;s expected mental model.
        </p>
        <ul className="ui-options-list">
          <li className="ui-option">
            <label className="bluetooth-option">
              <span>
                <strong>When Next Track is pressed</strong>
                <p className="text-sm text-muted">
                  How the device should interpret the &ldquo;forward&rdquo; button.
                </p>
              </span>
              <select
                value={nextAction}
                onChange={(e) => update('nextTrack', e.target.value)}
                className="select"
              >
                <option value="choice1">Pick choice 1 directly</option>
                <option value="cycle_choices">Move highlight to the next choice</option>
                <option value="confirm">Confirm currently-highlighted choice</option>
                <option value="divert">Follow the node&apos;s divert (no choices)</option>
              </select>
            </label>
          </li>
          <li className="ui-option">
            <label className="bluetooth-option">
              <span>
                <strong>When Previous Track is pressed</strong>
                <p className="text-sm text-muted">
                  How the device should interpret the &ldquo;back&rdquo; button.
                </p>
              </span>
              <select
                value={prevAction}
                onChange={(e) => update('previousTrack', e.target.value)}
                className="select"
              >
                <option value="choice2">Pick choice 2 directly</option>
                <option value="cycle_choices">Move highlight to the previous choice</option>
                <option value="go_back">Navigate back in history</option>
              </select>
            </label>
          </li>
        </ul>
        <p className="text-muted" style={{ marginTop: 12 }}>
          Fixed mappings: <strong>Play / Pause</strong> toggles audio, <strong>double-press</strong>{' '}
          the play button picks choice 1, <strong>triple-press</strong> picks choice 2.
        </p>
      </section>
    </div>
  );
}
