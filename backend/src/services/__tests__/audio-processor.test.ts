import { collectUsedAudioFilenames } from '../audio-processor.js';
import type { StoryData } from '../story-data-builder.js';

function makeStoryData(overrides: Partial<StoryData> = {}): StoryData {
  return {
    id: 'test',
    title: 'Test Story',
    audioBaseUrl: './audio/',
    startNode: 'start',
    nodes: {},
    indicatorAudio: {},
    ...overrides,
  };
}

describe('collectUsedAudioFilenames', () => {
  it('should collect voiceover filenames from nodes', () => {
    const storyData = makeStoryData({
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [],
          choices: [],
          divert: null,
          tags: [],
          audio: { voiceover: 'vo1.mp3' },
        },
        next: {
          id: 'next',
          type: 'knot',
          content: [],
          choices: [],
          divert: null,
          tags: [],
          audio: { voiceover: 'vo2.mp3', ambience: 'amb1.mp3' },
        },
      },
    });

    const result = collectUsedAudioFilenames(storyData, {}, {}, []);
    expect(result).toEqual(new Set(['vo1.mp3', 'vo2.mp3', 'amb1.mp3']));
  });

  it('should collect choice audio filenames', () => {
    const storyData = makeStoryData({
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [],
          choices: [],
          divert: null,
          tags: [],
          audio: { choice1: 'c1.mp3', choice2: 'c2.mp3' },
        },
      },
    });

    const result = collectUsedAudioFilenames(storyData, {}, {}, []);
    expect(result).toEqual(new Set(['c1.mp3', 'c2.mp3']));
  });

  it('should collect indicator audio from settings', () => {
    const storyData = makeStoryData();
    const settings = {
      choiceIndicatorAudio: {
        choice1FileId: 'file-1',
        choice2FileId: 'file-2',
      },
    };
    const fileMap = {
      'file-1': 'indicator1.mp3',
      'file-2': 'indicator2.mp3',
    };

    const result = collectUsedAudioFilenames(storyData, settings, fileMap, []);
    expect(result).toEqual(new Set(['indicator1.mp3', 'indicator2.mp3']));
  });

  it('should collect background music filenames', () => {
    const storyData = makeStoryData();
    const result = collectUsedAudioFilenames(storyData, {}, {}, ['bgm1.mp3', 'bgm2.mp3']);
    expect(result).toEqual(new Set(['bgm1.mp3', 'bgm2.mp3']));
  });

  it('should skip nodes without audio', () => {
    const storyData = makeStoryData({
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [],
          choices: [],
          divert: null,
          tags: [],
        },
      },
    });

    const result = collectUsedAudioFilenames(storyData, {}, {}, []);
    expect(result.size).toBe(0);
  });

  it('should skip indicator audio when file IDs not in fileMap', () => {
    const storyData = makeStoryData();
    const settings = {
      choiceIndicatorAudio: {
        choice1FileId: 'missing-id',
      },
    };

    const result = collectUsedAudioFilenames(storyData, settings, {}, []);
    expect(result.size).toBe(0);
  });

  it('should deduplicate filenames across sources', () => {
    const storyData = makeStoryData({
      nodes: {
        start: {
          id: 'start',
          type: 'knot',
          content: [],
          choices: [],
          divert: null,
          tags: [],
          audio: { voiceover: 'shared.mp3' },
        },
      },
    });

    const result = collectUsedAudioFilenames(storyData, {}, {}, ['shared.mp3']);
    expect(result.size).toBe(1);
    expect(result.has('shared.mp3')).toBe(true);
  });
});
