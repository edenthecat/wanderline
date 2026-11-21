import { StoryDataError, resolveStoryTitle, collectNodeAudio } from '../story-data-builder.js';

describe('StoryDataError', () => {
  it('should create error with message and status code', () => {
    const error = new StoryDataError('Not found', 404);
    expect(error.message).toBe('Not found');
    expect(error.statusCode).toBe(404);
    expect(error.name).toBe('StoryDataError');
  });

  it('should be an instance of Error', () => {
    const error = new StoryDataError('Bad request', 400);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(StoryDataError);
  });

  it('should work with try/catch', () => {
    try {
      throw new StoryDataError('Project has no story', 400);
    } catch (e) {
      expect(e).toBeInstanceOf(StoryDataError);
      if (e instanceof StoryDataError) {
        expect(e.statusCode).toBe(400);
        expect(e.message).toBe('Project has no story');
      }
    }
  });
});

describe('resolveStoryTitle', () => {
  it("returns the story-graph title when it doesn't look like a parser default", () => {
    expect(resolveStoryTitle('Dear Anna', 'Wanderline Project')).toBe('Dear Anna');
  });

  it('falls back to the project name when the graph title is "Untitled"', () => {
    // The Twee parser sets `title: 'Untitled'` when no StoryTitle
    // passage is present. Everyone would rather see the project name
    // in that case.
    expect(resolveStoryTitle('Untitled', 'Dear Anna')).toBe('Dear Anna');
  });

  it('falls back to the project name when the graph title is "Untitled Story"', () => {
    // The Ink parser uses a different literal.
    expect(resolveStoryTitle('Untitled Story', 'My Project')).toBe('My Project');
  });

  it('falls back to the project name when the graph title is empty', () => {
    expect(resolveStoryTitle('', 'Backup Name')).toBe('Backup Name');
  });

  it('trims whitespace from the fallback project name', () => {
    expect(resolveStoryTitle('Untitled', '   Trimmed   ')).toBe('Trimmed');
  });

  it('keeps the parser-default title when the project name is unusable', () => {
    // If the project name is missing / blank we can't do better than
    // "Untitled"; return whatever the graph had rather than an empty
    // string so the player's `<h1>` still has content.
    expect(resolveStoryTitle('Untitled', '')).toBe('Untitled');
    expect(resolveStoryTitle('Untitled', '   ')).toBe('Untitled');
    expect(resolveStoryTitle('Untitled Story', null as unknown as string)).toBe('Untitled Story');
  });

  it('coerces non-string inputs to reasonable defaults', () => {
    expect(resolveStoryTitle(null, 'Backup')).toBe('Backup');
    expect(resolveStoryTitle(undefined, 'Backup')).toBe('Backup');
    expect(resolveStoryTitle(42, 'Backup')).toBe('Backup');
  });
});

describe('collectNodeAudio', () => {
  const fileMap = { f1: 'vo.mp3', f2: 'rain.mp3', f3: 'door.mp3', f4: 'bell.mp3', f5: 'wind.mp3' };

  it('resolves the single slots to filenames', () => {
    const audio = collectNodeAudio(
      [
        { node_id: 'a', audio_type: 'voiceover', audio_file_id: 'f1' },
        { node_id: 'a', audio_type: 'ambience', audio_file_id: 'f2' },
      ],
      fileMap,
    );
    expect(audio).toEqual({
      a: { voiceover: [{ file: 'vo.mp3' }], ambience: [{ file: 'rain.mp3' }] },
    });
  });

  // SFX were assignable in the editor but never made it past this point,
  // so no preview or build ever played one.
  it('includes sound effects, with an offset only when one was set', () => {
    const audio = collectNodeAudio(
      [
        { node_id: 'a', audio_type: 'sfx', audio_file_id: 'f3', offset_ms: 1200 },
        { node_id: 'a', audio_type: 'sfx', audio_file_id: 'f4', offset_ms: null },
      ],
      fileMap,
    );
    expect(audio.a.sfx).toEqual([{ file: 'bell.mp3' }, { file: 'door.mp3', offsetMs: 1200 }]);
  });

  it('orders sound effects stably: unset first, then by offset, then by filename', () => {
    const audio = collectNodeAudio(
      [
        { node_id: 'a', audio_type: 'sfx', audio_file_id: 'f5', offset_ms: 500 },
        { node_id: 'a', audio_type: 'sfx', audio_file_id: 'f3', offset_ms: 500 },
        { node_id: 'a', audio_type: 'sfx', audio_file_id: 'f4' },
      ],
      fileMap,
    );
    expect(audio.a.sfx!.map((fx) => fx.file)).toEqual(['bell.mp3', 'door.mp3', 'wind.mp3']);
  });

  it('leaves out assignments whose file no longer exists', () => {
    const audio = collectNodeAudio(
      [
        { node_id: 'a', audio_type: 'voiceover', audio_file_id: 'gone' },
        { node_id: 'a', audio_type: 'sfx', audio_file_id: 'gone' },
        { node_id: 'b', audio_type: 'ambience', audio_file_id: 'f2' },
      ],
      fileMap,
    );
    expect(audio).toEqual({ b: { ambience: [{ file: 'rain.mp3' }] } });
  });

  it('ignores a negative or non-finite offset rather than emitting it', () => {
    const audio = collectNodeAudio(
      [{ node_id: 'a', audio_type: 'sfx', audio_file_id: 'f3', offset_ms: -5 }],
      fileMap,
    );
    expect(audio.a.sfx).toEqual([{ file: 'door.mp3' }]);
  });

  describe('variable-conditioned variants', () => {
    it('orders a conditioned candidate before the unconditioned default', () => {
      const audio = collectNodeAudio(
        [
          { node_id: 'a', audio_type: 'voiceover', audio_file_id: 'f1', created_at: '2026-01-01' },
          {
            node_id: 'a',
            audio_type: 'voiceover',
            audio_file_id: 'f2',
            condition: { variable: 'mood', operator: '==', value: 'angry' },
            created_at: '2026-01-02',
          },
        ],
        fileMap,
      );
      expect(audio.a.voiceover).toEqual([
        { file: 'rain.mp3', condition: { variable: 'mood', operator: '==', value: 'angry' } },
        { file: 'vo.mp3' },
      ]);
    });

    it('orders multiple conditioned candidates by created_at, regardless of row order', () => {
      const audio = collectNodeAudio(
        [
          {
            node_id: 'a',
            audio_type: 'voiceover',
            audio_file_id: 'f2',
            condition: { variable: 'mood', operator: '==', value: 'angry' },
            created_at: '2026-01-05',
          },
          {
            node_id: 'a',
            audio_type: 'voiceover',
            audio_file_id: 'f3',
            condition: { variable: 'mood', operator: '==', value: 'sad' },
            created_at: '2026-01-02',
          },
        ],
        fileMap,
      );
      expect(audio.a.voiceover?.map((v) => v.file)).toEqual(['door.mp3', 'rain.mp3']);
    });

    it('leaves out a conditioned candidate whose file no longer resolves, same as the default case', () => {
      const audio = collectNodeAudio(
        [
          {
            node_id: 'a',
            audio_type: 'voiceover',
            audio_file_id: 'gone',
            condition: { variable: 'mood', operator: '==', value: 'angry' },
          },
          { node_id: 'a', audio_type: 'voiceover', audio_file_id: 'f1' },
        ],
        fileMap,
      );
      expect(audio.a.voiceover).toEqual([{ file: 'vo.mp3' }]);
    });

    it('does not let a condition affect sfx ordering — sfx entries are independent, not mutually exclusive', () => {
      const audio = collectNodeAudio(
        [
          {
            node_id: 'a',
            audio_type: 'sfx',
            audio_file_id: 'f3',
            offset_ms: 500,
            condition: { variable: 'scary', operator: '==', value: true },
          },
          { node_id: 'a', audio_type: 'sfx', audio_file_id: 'f1', offset_ms: 100 },
        ],
        fileMap,
      );
      expect(audio.a.sfx).toEqual([
        { file: 'vo.mp3', offsetMs: 100 },
        {
          file: 'door.mp3',
          offsetMs: 500,
          condition: { variable: 'scary', operator: '==', value: true },
        },
      ]);
    });
  });
});
