import { describe, it, expect, beforeEach } from 'vitest';
import {
  AUTOSAVE_SLOT_ID,
  clearAllSlots,
  defaultManualSlotName,
  hasStoredSlots,
  newSlotId,
  readSlotsWithMigration,
  removeSlot,
  upsertSlot,
  writeSlots,
  type SaveSlot,
} from './save-slots';

const STORY_ID = 'story-1';
const validIds = new Set(['_intro', 'chapter_a', 'chapter_b']);

function makeSlot(over: Partial<SaveSlot> = {}): SaveSlot {
  return {
    id: 'autosave',
    name: 'Autosave',
    nodeId: 'chapter_a',
    history: ['_intro'],
    savedAt: '2026-05-23T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('save-slots', () => {
  it('returns empty when no slots and no legacy save exist', () => {
    expect(readSlotsWithMigration(STORY_ID, validIds)).toEqual([]);
  });

  it('migrates a legacy single-slot autosave into the new layout', () => {
    localStorage.setItem(
      `wanderline_${STORY_ID}`,
      JSON.stringify({ nodeId: 'chapter_a', history: ['_intro'] }),
    );
    const slots = readSlotsWithMigration(STORY_ID, validIds);
    expect(slots).toHaveLength(1);
    expect(slots[0].id).toBe(AUTOSAVE_SLOT_ID);
    expect(slots[0].name).toBe('Autosave');
    expect(slots[0].nodeId).toBe('chapter_a');
    expect(slots[0].history).toEqual(['_intro']);
    // Legacy key removed after migration.
    expect(localStorage.getItem(`wanderline_${STORY_ID}`)).toBeNull();
  });

  it('skips migration when the legacy node is no longer in the story', () => {
    localStorage.setItem(
      `wanderline_${STORY_ID}`,
      JSON.stringify({ nodeId: 'deleted_node', history: [] }),
    );
    expect(readSlotsWithMigration(STORY_ID, validIds)).toEqual([]);
  });

  it('drops slots whose nodeId is no longer valid', () => {
    writeSlots(STORY_ID, [
      makeSlot({ id: 'a', name: 'Save 1', nodeId: 'gone' }),
      makeSlot({ id: 'b', name: 'Save 2' }),
    ]);
    const slots = readSlotsWithMigration(STORY_ID, validIds);
    expect(slots.map((s) => s.id)).toEqual(['b']);
  });

  it('always returns the autosave slot first', () => {
    writeSlots(STORY_ID, [
      makeSlot({ id: 'a', name: 'Save 1', savedAt: '2026-05-22T00:00:00Z' }),
      makeSlot({ id: AUTOSAVE_SLOT_ID, savedAt: '2026-05-21T00:00:00Z' }),
      makeSlot({ id: 'b', name: 'Save 2', savedAt: '2026-05-23T00:00:00Z' }),
    ]);
    const slots = readSlotsWithMigration(STORY_ID, validIds);
    expect(slots[0].id).toBe(AUTOSAVE_SLOT_ID);
  });

  it('upsertSlot replaces by id and appends new ones', () => {
    const start: SaveSlot[] = [
      makeSlot({ id: AUTOSAVE_SLOT_ID, nodeId: 'chapter_a' }),
      makeSlot({ id: 'manual-1', name: 'Save 1', nodeId: 'chapter_b' }),
    ];
    const updated = upsertSlot(start, makeSlot({ id: AUTOSAVE_SLOT_ID, nodeId: 'chapter_b' }));
    expect(updated[0].nodeId).toBe('chapter_b');
    const added = upsertSlot(updated, makeSlot({ id: 'manual-2', name: 'Save 2' }));
    expect(added).toHaveLength(3);
  });

  it('removeSlot drops by id', () => {
    const start: SaveSlot[] = [
      makeSlot({ id: AUTOSAVE_SLOT_ID }),
      makeSlot({ id: 'manual-1', name: 'Save 1' }),
    ];
    expect(removeSlot(start, 'manual-1').map((s) => s.id)).toEqual([AUTOSAVE_SLOT_ID]);
  });

  it('clearAllSlots wipes both the new key and the legacy key', () => {
    writeSlots(STORY_ID, [makeSlot()]);
    localStorage.setItem(`wanderline_${STORY_ID}`, '{"nodeId":"chapter_a"}');
    clearAllSlots(STORY_ID);
    expect(localStorage.getItem(`wanderline_${STORY_ID}_slots`)).toBeNull();
    expect(localStorage.getItem(`wanderline_${STORY_ID}`)).toBeNull();
  });

  it('defaultManualSlotName picks the next free "Save N"', () => {
    expect(defaultManualSlotName([])).toBe('Save 1');
    expect(
      defaultManualSlotName([
        makeSlot({ id: 'a', name: 'Save 1' }),
        makeSlot({ id: 'b', name: 'Save 2' }),
      ]),
    ).toBe('Save 3');
    // Gap fills in:
    expect(
      defaultManualSlotName([
        makeSlot({ id: 'a', name: 'Save 2' }),
        makeSlot({ id: 'b', name: 'Save 4' }),
      ]),
    ).toBe('Save 1');
  });

  it('newSlotId returns a non-empty string distinct from autosave', () => {
    const id = newSlotId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toBe(AUTOSAVE_SLOT_ID);
  });

  it('writeSlots caps the manual list at MAX_MANUAL_SLOTS', async () => {
    const { MAX_MANUAL_SLOTS } = await import('./save-slots');
    const tooMany: SaveSlot[] = [];
    for (let i = 0; i < MAX_MANUAL_SLOTS + 3; i++) {
      tooMany.push(
        makeSlot({
          id: `m-${i}`,
          name: `Save ${i + 1}`,
          // Increasing timestamps so the older ones get dropped first.
          savedAt: new Date(2026, 0, 1 + i).toISOString(),
        }),
      );
    }
    // Tack on an autosave; it should survive the trim and stay first.
    tooMany.unshift(makeSlot({ id: AUTOSAVE_SLOT_ID }));
    writeSlots(STORY_ID, tooMany);
    const round = readSlotsWithMigration(STORY_ID, validIds);
    // Autosave + MAX_MANUAL_SLOTS manual = MAX + 1 total.
    expect(round).toHaveLength(MAX_MANUAL_SLOTS + 1);
    expect(round[0].id).toBe(AUTOSAVE_SLOT_ID);
    // The OLDEST manual slots were dropped — m-0, m-1, m-2.
    expect(round.find((s) => s.id === 'm-0')).toBeUndefined();
    expect(round.find((s) => s.id === `m-${MAX_MANUAL_SLOTS + 2}`)).toBeDefined();
  });

  it('round-trips slots through writeSlots / readSlotsWithMigration', () => {
    const start: SaveSlot[] = [
      makeSlot({ id: AUTOSAVE_SLOT_ID }),
      makeSlot({ id: 'manual-1', name: 'Save 1' }),
    ];
    writeSlots(STORY_ID, start);
    expect(readSlotsWithMigration(STORY_ID, validIds)).toEqual(start);
  });
});

// readSlotsWithMigration filters unusable slots out of what it RETURNS
// but leaves them on disk, so "is there anything here?" and "is there
// anything usable here?" are different questions — and the one that
// gates wiping saved state is the first.
// The legacy key used to be deleted whenever it was READ, migrated or
// not — so a payload pointing at a passage a re-upload removed was
// destroyed by the next load, before anything could decide whether it
// was worth protecting.
describe('legacy payloads the current story cannot use', () => {
  const legacyKey = `wanderline_${STORY_ID}`;

  it('is kept, not migrated, while its passage is missing', () => {
    localStorage.setItem(legacyKey, JSON.stringify({ nodeId: 'a_passage_that_left', history: [] }));
    expect(readSlotsWithMigration(STORY_ID, validIds)).toHaveLength(0);
    expect(localStorage.getItem(legacyKey)).not.toBeNull();
    expect(hasStoredSlots(STORY_ID)).toBe(true);
  });

  it('migrates once the passage is back', () => {
    localStorage.setItem(legacyKey, JSON.stringify({ nodeId: 'chapter_a', history: [] }));
    const slots = readSlotsWithMigration(STORY_ID, validIds);
    expect(slots.map((s) => s.nodeId)).toEqual(['chapter_a']);
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it('drops a payload no story could ever migrate', () => {
    localStorage.setItem(legacyKey, 'not json');
    expect(readSlotsWithMigration(STORY_ID, validIds)).toHaveLength(0);
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });
});

describe('hasStoredSlots', () => {
  it('is false on a device with nothing stored', () => {
    expect(hasStoredSlots(STORY_ID)).toBe(false);
  });

  it('is true once a slot has been written', () => {
    writeSlots(STORY_ID, [makeSlot()]);
    expect(hasStoredSlots(STORY_ID)).toBe(true);
  });

  it('is true for slots the current story can no longer use', () => {
    writeSlots(STORY_ID, [makeSlot({ nodeId: 'a_passage_that_left' })]);
    expect(readSlotsWithMigration(STORY_ID, validIds)).toHaveLength(0);
    expect(hasStoredSlots(STORY_ID)).toBe(true);
  });

  it('is false again after a clear', () => {
    writeSlots(STORY_ID, [makeSlot()]);
    clearAllSlots(STORY_ID);
    expect(hasStoredSlots(STORY_ID)).toBe(false);
  });
});
