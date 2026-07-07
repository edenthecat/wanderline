import { buildMatchTables, matchAudioFile } from '../audio-matcher.js';

// Synthetic node ids exercising audio-matcher's cases:
//   - `alpha_room_1/2` — two names one edit apart, so the ambiguity
//     branch refuses to guess between them.
//   - `bravo_notebook_scene` — target for a 1-edit-typo Levenshtein
//     match (`notbook` vs `notebook`).
//   - `Delta_intercom_4` — mixed-case id so the case-insensitive
//     branch has something to match.
//   - `recap.entry_5` — stitch id, exercises last-segment
//     resolution.
const sampleNodes = {
  alpha_room_1: {
    id: 'alpha_room_1',
    choices: [
      { text: 'Follow the corridor.', target: 'alpha_bar' },
      { text: 'Head back.', target: 'alpha_room_2' },
    ],
  },
  alpha_bar: { id: 'alpha_bar', choices: [] },
  alpha_room_2: { id: 'alpha_room_2', choices: [] },
  bravo_notebook_scene: { id: 'bravo_notebook_scene', choices: [] },
  Delta_intercom_4: {
    id: 'Delta_intercom_4',
    choices: [{ text: 'Try the button again.', target: 'END' }],
  },
  'recap.entry_5': {
    id: 'recap.entry_5',
    choices: [{ text: 'read further', target: 'finale' }],
  },
  finale: { id: 'finale', choices: [] },
};

describe('audio-matcher', () => {
  const tables = buildMatchTables(sampleNodes);

  describe('voiceover by exact node id', () => {
    it('matches alpha_room_1.wav → alpha_room_1 / voiceover', () => {
      expect(matchAudioFile('alpha_room_1.wav', tables)).toEqual({
        nodeId: 'alpha_room_1',
        audioType: 'voiceover',
      });
    });

    it('matches a stitch by its last segment', () => {
      // `recap.entry_5` is registered; the last-segment map
      // adds `entry_5` too.
      expect(matchAudioFile('entry_5.wav', tables)).toEqual({
        nodeId: 'recap.entry_5',
        audioType: 'voiceover',
      });
    });
  });

  describe('choice positional suffix', () => {
    it('alpha_room_1_choice_a → alpha_room_1 / choice1', () => {
      expect(matchAudioFile('alpha_room_1_choice_a.wav', tables)).toEqual({
        nodeId: 'alpha_room_1',
        audioType: 'choice1',
      });
    });

    it('alpha_room_1_choice_b → alpha_room_1 / choice2', () => {
      expect(matchAudioFile('alpha_room_1_choice_b.wav', tables)).toEqual({
        nodeId: 'alpha_room_1',
        audioType: 'choice2',
      });
    });

    it('alpha_room_1.choice_a (dot form) → alpha_room_1 / choice1', () => {
      expect(matchAudioFile('alpha_room_1.choice_a.wav', tables)).toEqual({
        nodeId: 'alpha_room_1',
        audioType: 'choice1',
      });
    });

    it('Delta_intercom_4.choice_a → choice1 (case-insensitive)', () => {
      expect(matchAudioFile('Delta_intercom_4.choice_a.wav', tables)).toEqual({
        nodeId: 'Delta_intercom_4',
        audioType: 'choice1',
      });
    });

    it('also accepts choice_1 / choice_2 numeric variants', () => {
      expect(matchAudioFile('alpha_room_1_choice_1.wav', tables)).toEqual({
        nodeId: 'alpha_room_1',
        audioType: 'choice1',
      });
      expect(matchAudioFile('alpha_room_1_choice_2.wav', tables)).toEqual({
        nodeId: 'alpha_room_1',
        audioType: 'choice2',
      });
    });
  });

  describe('Levenshtein typo fallback', () => {
    it('matches a 1-edit typo to the closest node', () => {
      // "notbook" (missing o) → "notebook"
      expect(matchAudioFile('bravo_notbook_scene.wav', tables)).toEqual({
        nodeId: 'bravo_notebook_scene',
        audioType: 'voiceover',
      });
    });

    it('refuses a typo with ambiguous (within 2 edits of multiple nodes) targets', () => {
      // "alpha_room" is one edit from alpha_room_1 AND alpha_room_2 —
      // refuse rather than guess wrong.
      expect(matchAudioFile('alpha_room.wav', tables)).toBeNull();
    });

    it('returns null for unrelated input', () => {
      expect(matchAudioFile('completely_unrelated_file.wav', tables)).toBeNull();
    });

    it('returns null for too-short input (avoids nonsense matches)', () => {
      expect(matchAudioFile('s.wav', tables)).toBeNull();
    });
  });

  describe('DAW prefix/suffix normalization', () => {
    it('strips a leading track number', () => {
      expect(matchAudioFile('04_alpha_room_1.wav', tables)).toEqual({
        nodeId: 'alpha_room_1',
        audioType: 'voiceover',
      });
    });

    it('strips a trailing _v2 suffix', () => {
      expect(matchAudioFile('alpha_room_1_v2.wav', tables)).toEqual({
        nodeId: 'alpha_room_1',
        audioType: 'voiceover',
      });
    });
  });
});
