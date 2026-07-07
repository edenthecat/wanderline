// multi-slot save state for player-app.
//
// Storage layout (all under localStorage):
//   wanderline_<storyId>_slots → JSON array of SaveSlot
//
// One slot's id is the reserved string "autosave" — it gets overwritten
// every time the autosave fires. Manual save slots use uuid v4.
// Earlier storage put a single payload at "wanderline_<storyId>";
// readSlotsWithMigration() moves any such legacy payload into a fresh
// autosave slot the first time it runs.

const STORAGE_PREFIX = 'wanderline_';
export const AUTOSAVE_SLOT_ID = 'autosave';
export const MAX_MANUAL_SLOTS = 9;

// Cap the manual-slot count + keep the autosave (if present) in front.
// Older manual slots are dropped first. Shared by writeSlots() and
// readSlotsWithMigration() so reads + writes apply the same trim.
function capSlots(slots: SaveSlot[]): SaveSlot[] {
  const autosave = slots.find((s) => s.id === AUTOSAVE_SLOT_ID);
  const manual = slots
    .filter((s) => s.id !== AUTOSAVE_SLOT_ID)
    // Stable when timestamps match (most recent at the END, so slice
    // from the tail keeps the newest).
    .sort((a, b) => {
      if (a.savedAt < b.savedAt) return -1;
      if (a.savedAt > b.savedAt) return 1;
      return 0;
    });
  const trimmed = manual.slice(-MAX_MANUAL_SLOTS);
  return autosave ? [autosave, ...trimmed] : trimmed;
}

export interface SaveSlot {
  id: string;
  name: string;
  nodeId: string;
  history: string[];
  savedAt: string; // ISO timestamp
}

const slotsStorageKey = (storyId: string) => `${STORAGE_PREFIX}${storyId}_slots`;
const legacyStorageKey = (storyId: string) => `${STORAGE_PREFIX}${storyId}`;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // QuotaExceeded etc — silently drop; saves are best-effort.
  }
}
function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function parseSlots(raw: string | null): SaveSlot[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is SaveSlot =>
        s &&
        typeof s === 'object' &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        typeof s.nodeId === 'string' &&
        Array.isArray(s.history) &&
        s.history.every((h: unknown) => typeof h === 'string') &&
        typeof s.savedAt === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Read the slot list for a story. If we find a legacy single-slot
 * autosave at the earlier key, migrate it into a fresh autosave
 * slot before returning. validNodeIds (optional) drops slots whose
 * nodeId is no longer in the story — useful when the story is edited
 * between sessions.
 */
export function readSlotsWithMigration(storyId: string, validNodeIds?: Set<string>): SaveSlot[] {
  const key = slotsStorageKey(storyId);
  let slots = parseSlots(safeGet(key));

  // Legacy single-slot migration. Runs once: after the move, we
  // delete the old key so subsequent loads skip this block.
  if (slots.length === 0) {
    const legacyRaw = safeGet(legacyStorageKey(storyId));
    if (legacyRaw) {
      try {
        const legacy = JSON.parse(legacyRaw);
        if (
          legacy &&
          typeof legacy.nodeId === 'string' &&
          (!validNodeIds || validNodeIds.has(legacy.nodeId))
        ) {
          slots = [
            {
              id: AUTOSAVE_SLOT_ID,
              name: 'Autosave',
              nodeId: legacy.nodeId,
              history: Array.isArray(legacy.history)
                ? legacy.history.filter((h: unknown) => typeof h === 'string')
                : [],
              savedAt: new Date().toISOString(),
            },
          ];
          safeSet(key, JSON.stringify(slots));
        }
      } catch {
        // malformed legacy payload — ignore, drop it
      }
      safeRemove(legacyStorageKey(storyId));
    }
  }

  // Drop slots whose node no longer exists (story rebuild) and cap to
  // the manual-slot limit so a runaway script can't bloat localStorage.
  if (validNodeIds) {
    slots = slots.filter((s) => validNodeIds.has(s.nodeId));
  }
  return capSlots(slots);
}

// Persist a slot list to localStorage, enforcing the manual-slot cap
// before writing. Without this, upsertSlot() lets a session grow the
// list past MAX_MANUAL_SLOTS — readSlotsWithMigration would trim on
// the next load, but the intermediate state could exceed localStorage
// quotas if slots are large.
export function writeSlots(storyId: string, slots: SaveSlot[]): void {
  safeSet(slotsStorageKey(storyId), JSON.stringify(capSlots(slots)));
}

/**
 * Upsert (replace by id, else append) a single slot. Used by the
 * autosave path AND by the "Save as new" path.
 */
export function upsertSlot(slots: SaveSlot[], next: SaveSlot): SaveSlot[] {
  const idx = slots.findIndex((s) => s.id === next.id);
  if (idx === -1) return [...slots, next];
  const copy = slots.slice();
  copy[idx] = next;
  return copy;
}

export function removeSlot(slots: SaveSlot[], id: string): SaveSlot[] {
  return slots.filter((s) => s.id !== id);
}

export function clearAllSlots(storyId: string): void {
  safeRemove(slotsStorageKey(storyId));
  // Defensive: drop the legacy key too in case migration was skipped.
  safeRemove(legacyStorageKey(storyId));
}

// crypto.randomUUID falls back to Math.random in older Safari; we
// don't need cryptographic uniqueness for save slots.
export function newSlotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `slot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultManualSlotName(existing: SaveSlot[]): string {
  // "Save 1", "Save 2", ... — pick the lowest unused N.
  const used = new Set(
    existing
      .filter((s) => s.id !== AUTOSAVE_SLOT_ID)
      .map((s) => /^Save (\d+)$/.exec(s.name)?.[1])
      .filter((n): n is string => !!n)
      .map((n) => parseInt(n, 10)),
  );
  let n = 1;
  while (used.has(n)) n++;
  return `Save ${n}`;
}
