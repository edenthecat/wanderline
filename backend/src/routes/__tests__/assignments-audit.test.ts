// The audit exists because /rematch skips any file that already has an
// assignment. A project populated under older matching logic therefore
// never gets re-examined, so a matcher BUG leaves silently wrong
// assignments that nothing revisits — which is exactly what happened
// with ink stitch names.
//
// Pins the classification, which is where the value is: a report that
// flags everything is as useless as no report.

import { buildMatchTables, matchAudioFile } from '../../services/audio-matcher.js';

type Nodes = Parameters<typeof buildMatchTables>[0];
const node = () => ({ choices: [], tags: [] }) as unknown as Nodes[string];

/** Mirrors the endpoint's per-row decision. */
function classify(
  filename: string,
  currentNodeId: string,
  currentAudioType: string,
  tables: ReturnType<typeof buildMatchTables>,
) {
  const match = matchAudioFile(filename, tables);
  if (!match?.nodeId) return null;
  if (match.nodeId === currentNodeId && match.audioType === currentAudioType) return null;
  return {
    suggestedNodeId: match.nodeId,
    reason: match.nodeId !== currentNodeId ? 'different-node' : 'different-type',
  };
}

describe('audio assignment audit', () => {
  const tables = buildMatchTables({
    intro: node(),
    'chapter1.intro': node(),
    'chapter1.hallway': node(),
    'chapter2.start': node(),
    'chapter1.start': node(),
  } as Nodes);

  // The exact shape of the stitch bug: audio named for a knot that the
  // old matcher attached to a same-named stitch.
  it('flags a file sitting on the wrong node', () => {
    expect(classify('intro.mp3', 'chapter1.intro', 'voiceover', tables)).toEqual({
      suggestedNodeId: 'intro',
      reason: 'different-node',
    });
  });

  it('stays quiet when the assignment agrees with the matcher', () => {
    expect(classify('hallway.mp3', 'chapter1.hallway', 'voiceover', tables)).toBeNull();
    expect(classify('chapter1.intro.mp3', 'chapter1.intro', 'voiceover', tables)).toBeNull();
  });

  // Plenty of clips are named in ways the matcher was never meant to
  // read. Flagging those would bury the real signal.
  it('stays quiet when the filename matches nothing', () => {
    expect(classify('take-07-FINAL-v2.mp3', 'chapter1.intro', 'voiceover', tables)).toBeNull();
  });

  // An ambiguous bare name resolves to nothing after the matcher fix,
  // so it must not be reported as a disagreement either.
  it('stays quiet on a name the matcher deliberately refuses', () => {
    expect(classify('start.mp3', 'chapter1.start', 'voiceover', tables)).toBeNull();
  });

  it('reports the destination so the list is actionable', () => {
    const result = classify('intro.mp3', 'chapter1.intro', 'voiceover', tables);
    expect(result?.suggestedNodeId).toBe('intro');
  });
});
