// Ink namespaces stitches under their knot, so `chapter1.intro` and
// `chapter2.intro` are different passages that share a bare name —
// idiomatic Ink, and the whole point of the feature.
//
// The match table registered bare stitch names with an unguarded
// `set`, which produced two silent mis-assignments: a stitch's bare
// name displaced a same-named KNOT's fully-qualified id, and two
// stitches sharing a name resolved to whichever was parsed last.

import { buildMatchTables, matchAudioFile } from '../audio-matcher.js';

type Nodes = Parameters<typeof buildMatchTables>[0];

const node = (over: Record<string, unknown> = {}) =>
  ({ choices: [], tags: [], ...over }) as unknown as Nodes[string];

describe('audio matching across ink stitches', () => {
  it('a fully-qualified id always beats a bare stitch name', () => {
    const tables = buildMatchTables({
      intro: node(),
      'chapter1.intro': node(),
    } as Nodes);
    // "intro.mp3" plainly means the knot, not a stitch that happens to
    // end in the same word.
    expect(matchAudioFile('intro.mp3', tables)?.nodeId).toBe('intro');
    // The stitch is still reachable by its real name.
    expect(matchAudioFile('chapter1.intro.mp3', tables)?.nodeId).toBe('chapter1.intro');
  });

  it('declaration order does not decide the winner', () => {
    const reversed = buildMatchTables({
      'chapter1.intro': node(),
      intro: node(),
    } as Nodes);
    expect(matchAudioFile('intro.mp3', reversed)?.nodeId).toBe('intro');
  });

  // Unassigned is the honest outcome: an author who sees audio go
  // unmatched investigates, one whose audio silently landed on a
  // plausible-but-wrong passage may never find out.
  it('refuses an ambiguous bare name rather than guessing', () => {
    const tables = buildMatchTables({
      'chapter1.start': node(),
      'chapter2.start': node(),
    } as Nodes);
    expect(matchAudioFile('start.mp3', tables)).toBeNull();
  });

  it('still matches each ambiguous stitch by its qualified name', () => {
    const tables = buildMatchTables({
      'chapter1.start': node(),
      'chapter2.start': node(),
    } as Nodes);
    expect(matchAudioFile('chapter1.start.mp3', tables)?.nodeId).toBe('chapter1.start');
    expect(matchAudioFile('chapter2_start.mp3', tables)?.nodeId).toBe('chapter2.start');
  });

  it('keeps the bare-name shortcut when it is unambiguous', () => {
    const tables = buildMatchTables({
      'chapter1.hallway': node(),
      'chapter2.kitchen': node(),
    } as Nodes);
    expect(matchAudioFile('hallway.mp3', tables)?.nodeId).toBe('chapter1.hallway');
    expect(matchAudioFile('kitchen.mp3', tables)?.nodeId).toBe('chapter2.kitchen');
  });

  it('a tag cannot displace a qualified id', () => {
    const tables = buildMatchTables({
      'chapter1.intro': node(),
      elsewhere: node({ tags: ['chapter1.intro'] }),
    } as Nodes);
    expect(matchAudioFile('chapter1.intro.mp3', tables)?.nodeId).toBe('chapter1.intro');
  });

  // A tag pointing at one candidate would reintroduce exactly the
  // guesswork the ambiguity check exists to prevent.
  it('a tag cannot resolve a name we refused as ambiguous', () => {
    const tables = buildMatchTables({
      'chapter1.start': node(),
      'chapter2.start': node(),
      narrator: node({ tags: ['start'] }),
    } as Nodes);
    expect(matchAudioFile('start.mp3', tables)).toBeNull();
  });
});
