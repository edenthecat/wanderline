// One consistent play/stop control for auditioning a clip.
//
// Every surface that names an audio file should let you hear it —
// choosing an indicator cue from a dropdown of filenames, or deciding
// whether an orphaned upload is safe to delete, is guesswork otherwise.
// The button is presentational: the caller owns a single useAudition
// instance per view, so only one clip plays at a time within that view
// and switching rows stops the previous one.

interface Props {
  /** Stable id for this row — what useAudition compares against. */
  id: string;
  /** Fully-resolved URL to play. */
  url: string;
  /** What's being played, for the accessible label ("Play Voiceover"). */
  label: string;
  /** The currently-playing id from useAudition, or null. */
  playingId: string | null;
  toggle: (id: string, url: string) => void;
  className?: string;
}

export default function AuditionButton({ id, url, label, playingId, toggle, className }: Props) {
  const playing = playingId === id;
  return (
    <button
      type="button"
      className={`btn btn-sm audition-btn${className ? ` ${className}` : ''}`}
      onClick={() => toggle(id, url)}
      aria-label={`${playing ? 'Stop' : 'Play'} ${label}`}
      title={`${playing ? 'Stop' : 'Play'} ${label}`}
    >
      {playing ? '■' : '▶'}
    </button>
  );
}
