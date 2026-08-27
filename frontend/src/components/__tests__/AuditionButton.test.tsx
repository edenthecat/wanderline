import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AuditionButton from '../AuditionButton';

// The shared control every audio surface uses. Its whole job is to
// report state accurately to someone who can't see the audio.
describe('AuditionButton', () => {
  it('offers to play when nothing is playing', () => {
    render(
      <AuditionButton id="a" url="/a.mp3" label="Voiceover" playingId={null} toggle={vi.fn()} />,
    );
    expect(screen.getByLabelText('Play Voiceover')).toBeTruthy();
  });

  it('offers to stop only the row that is playing', () => {
    const { rerender } = render(
      <AuditionButton id="a" url="/a.mp3" label="Voiceover" playingId="a" toggle={vi.fn()} />,
    );
    expect(screen.getByLabelText('Stop Voiceover')).toBeTruthy();
    // A different row playing must not claim this row is.
    rerender(
      <AuditionButton id="a" url="/a.mp3" label="Voiceover" playingId="b" toggle={vi.fn()} />,
    );
    expect(screen.getByLabelText('Play Voiceover')).toBeTruthy();
  });

  it('toggles with its own id and url', () => {
    const toggle = vi.fn();
    render(
      <AuditionButton id="vo:7" url="/x/7.mp3" label="Cue" playingId={null} toggle={toggle} />,
    );
    fireEvent.click(screen.getByLabelText('Play Cue'));
    expect(toggle).toHaveBeenCalledWith('vo:7', '/x/7.mp3');
  });
});
