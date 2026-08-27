import { useEffect, useState } from 'react';
import {
  audioFileUrl,
  fetchAudioFiles,
  type AudioFile,
  type ChoiceIndicatorAudio,
} from '../api/client';
import { useAudition } from '../hooks/useAudition';
import AuditionButton from './AuditionButton';
import { useProjectSettings } from '../hooks/useProjectSettings';

interface Props {
  projectId: string;
}

/**
 * One indicator-sound dropdown.
 *
 * Shared by the default cue and the two per-choice overrides so the
 * option list, the empty state and the fallback wording cannot drift
 * apart between them.
 */
function IndicatorPicker({
  label,
  value,
  options,
  emptyLabel,
  onChange,
  projectId,
  playingId,
  toggle,
}: {
  label: string;
  value: string;
  options: AudioFile[];
  emptyLabel: string;
  onChange: (next: string | null) => void;
  projectId: string;
  playingId: string | null;
  toggle: (id: string, url: string) => void;
}) {
  return (
    <div className="settings-row">
      <label className="bluetooth-option">
        <span>
          <strong>{label}</strong>
        </span>
        <select
          className="select"
          value={value}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label={label}
        >
          <option value="">{emptyLabel}</option>
          {options.map((f) => (
            <option key={f.id} value={f.id}>
              {f.original_name}
            </option>
          ))}
        </select>
      </label>
      {/* Picking a cue from a list of filenames is guesswork without
          this — the whole point of an indicator sound is how it sounds. */}
      {value && (
        <AuditionButton
          id={`${label}:${value}`}
          url={audioFileUrl(projectId, value)}
          label={label}
          playingId={playingId}
          toggle={toggle}
        />
      )}
    </div>
  );
}

export default function SystemSoundsTab({ projectId }: Props) {
  const { settings, loading, error, updateOne } = useProjectSettings(projectId);
  const [indicatorAudio, setIndicatorAudio] = useState<AudioFile[]>([]);
  const { playingId, toggle } = useAudition();

  useEffect(() => {
    fetchAudioFiles(projectId)
      .then(({ audioFiles }) => {
        setIndicatorAudio(audioFiles.filter((f) => f.category === 'indicator'));
      })
      .catch(() => {});
  }, [projectId]);

  /**
   * Patch one side of choiceIndicatorAudio.
   *
   * Sends only the changed key. The settings endpoint merges this
   * object key-by-key, so setting choice 1 leaves choice 2 alone;
   * sending the whole object would clear the other side on every edit.
   */
  function updateChoiceIndicator(key: keyof ChoiceIndicatorAudio, next: string | null) {
    // Declared up front and assigned into, rather than built as an
    // object literal with a computed key. A computed key widens to an
    // index signature, and casting that back to this type silences the
    // write site: change a field's type and the cast still compiles
    // while the assignment below would not.
    const patch: ChoiceIndicatorAudio = {};
    patch[key] = next;
    return updateOne('choiceIndicatorAudio', patch);
  }

  if (loading) return <div className="page-loader">Loading sounds...</div>;

  const noIndicators = indicatorAudio.length === 0;

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
        <IndicatorPicker
          label="Default indicator sound"
          projectId={projectId}
          playingId={playingId}
          toggle={toggle}
          value={settings?.defaultIndicatorAudioId ?? ''}
          options={indicatorAudio}
          emptyLabel="(none — silent)"
          onChange={(next) => updateOne('defaultIndicatorAudioId', next)}
        />
        {noIndicators && (
          <span className="text-muted text-sm">No indicator-category audio uploaded yet.</span>
        )}
      </section>

      <section className="settings-section" data-testid="per-choice-indicators">
        <h2>Per-choice sounds</h2>
        <p className="text-muted">
          Give the first and second choice their own cue so a listener can tell them apart before
          the words arrive. Leave either on <em>same as default</em> to use the sound above. Audio
          assigned to a specific node still wins over both.
        </p>
        <IndicatorPicker
          label="Choice 1 sound"
          projectId={projectId}
          playingId={playingId}
          toggle={toggle}
          value={settings?.choiceIndicatorAudio?.choice1FileId ?? ''}
          options={indicatorAudio}
          emptyLabel="(same as default)"
          onChange={(next) => updateChoiceIndicator('choice1FileId', next)}
        />
        <IndicatorPicker
          label="Choice 2 sound"
          projectId={projectId}
          playingId={playingId}
          toggle={toggle}
          value={settings?.choiceIndicatorAudio?.choice2FileId ?? ''}
          options={indicatorAudio}
          emptyLabel="(same as default)"
          onChange={(next) => updateChoiceIndicator('choice2FileId', next)}
        />
        {noIndicators && (
          <span className="text-muted text-sm">
            Upload audio in the <code>indicator</code> category to use these.
          </span>
        )}
      </section>
    </div>
  );
}
