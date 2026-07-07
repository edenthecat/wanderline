// presence — surfaces the list of OTHER editors
// currently connected to the same project's Y.Doc, plus publishes
// our own identity into awareness so peers see us.
//
// The y-protocols/awareness layer is already wired through y-
// websocket on both ends; this hook just (a) sets local awareness
// state from the auth user and (b) re-reads `awareness.getStates()`
// whenever it changes so the UI can render chips.
//
// Excludes our own local client id from the returned list — chips
// only show OTHER people. A "(you)" indicator belongs to a
// downstream chip variant, not the dataset.

import { useEffect, useRef, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';

export interface PresentUser {
  /** Y.js awareness clientID — stable per WebSocket connection. */
  clientId: number;
  /** App user id (UUID). May be undefined for very brief pre-publish window. */
  userId?: string;
  displayName: string;
  /** Color hex string assigned deterministically from userId. */
  color: string;
  /**
   * Node the peer is currently focused on (expanded knot in
   * StoryTab, etc). Used to render a "X is editing this" dot on
   * the corresponding node in the graph/list. Undefined when the
   * peer isn't focused on a particular node.
   */
  editingNodeId?: string;
}

export interface UsePresenceArgs {
  awareness: Awareness | null;
  /**
   * The current user's identity to broadcast to peers. Take
   * primitives (not an object) so callers don't accidentally
   * trigger an infinite re-publish loop by passing a fresh literal
   * each render. Pass null for both fields when there's no user
   * yet (e.g. mid-auth).
   */
  selfUserId: string | null;
  selfDisplayName: string | null;
  /**
   * Optional: id of the node THIS user is currently focused on.
   * Published into awareness so other peers can render a "who's
   * editing what" indicator. Pass `null` when the user isn't
   * focused on a particular node.
   */
  selfEditingNodeId?: string | null;
}

// Pleasant chip palette — enough hues that 8 concurrent editors
// still look distinct. Picked from the same palette the graph view
// uses so the app stays visually coherent.
const PALETTE = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
];

export function colorForUser(userId: string): string {
  // Deterministic hash — same user gets the same color across
  // sessions / clients so peers consistently recognize each other.
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

interface AwarenessState {
  user?: {
    userId?: string;
    displayName?: string;
    color?: string;
  };
  editingNodeId?: string;
}

// Awareness.setLocalStateField doesn't have a "remove this key"
// affordance — passing undefined keeps the property around (just
// with an undefined value). Drop a field cleanly by reading the
// current local state, omitting the key, and writing the rest back.
// Tolerant of the socket being torn down (e.g. unmount-during-close).
function clearAwarenessField(awareness: Awareness, field: string): void {
  const state = (awareness.getLocalState() ?? {}) as Record<string, unknown>;
  if (!(field in state)) return;
  const rest = { ...state };
  delete rest[field];
  try {
    awareness.setLocalState(rest);
  } catch {
    // socket torn down — safe to ignore
  }
}

function samePresence(a: PresentUser[], b: PresentUser[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].clientId !== b[i].clientId ||
      a[i].displayName !== b[i].displayName ||
      a[i].color !== b[i].color ||
      a[i].userId !== b[i].userId ||
      a[i].editingNodeId !== b[i].editingNodeId
    ) {
      return false;
    }
  }
  return true;
}

export function usePresence({
  awareness,
  selfUserId,
  selfDisplayName,
  selfEditingNodeId,
}: UsePresenceArgs): PresentUser[] {
  const [others, setOthers] = useState<PresentUser[]>([]);

  // Publish our local identity so peers see us.
  useEffect(() => {
    if (!awareness || !selfUserId || !selfDisplayName) return;
    awareness.setLocalStateField('user', {
      userId: selfUserId,
      displayName: selfDisplayName,
      color: colorForUser(selfUserId),
    });
    return () => {
      // Clear our local state on unmount so peers drop our chip.
      // Awareness lib will also do this on socket close, but we
      // unmount on tab navigation too (route changes), so be
      // explicit.
      try {
        awareness.setLocalState(null);
      } catch {
        // Awareness can throw if the underlying socket was already
        // torn down — safe to ignore.
      }
    };
  }, [awareness, selfUserId, selfDisplayName]);

  // Track the latest awareness in a ref so the one-shot unmount
  // effect below can clear the editing field even when awareness
  // was null on first render and connected later.
  const awarenessRef = useRef<Awareness | null>(awareness);
  useEffect(() => {
    awarenessRef.current = awareness;
  }, [awareness]);

  // Publish the node we're focused on. Separate effect from the
  // identity publish so it can update on tab navigation without
  // clearing our identity. The body alone handles setting +
  // clearing; the cleanup is deliberately not used here because it
  // would fire on every selfEditingNodeId change and cause peers
  // to see a transient "no one is editing X" between renders. The
  // dedicated unmount cleanup below handles true teardown.
  useEffect(() => {
    if (!awareness) return;
    if (selfEditingNodeId) {
      awareness.setLocalStateField('editingNodeId', selfEditingNodeId);
    } else {
      clearAwarenessField(awareness, 'editingNodeId');
    }
  }, [awareness, selfEditingNodeId]);

  // Clear our editingNodeId on the OLD awareness whenever the
  // awareness instance itself changes (e.g. provider reconnect,
  // project switch). Without this, the dropped awareness still has
  // our editing field set, and peers connected to it may keep
  // showing a stale dot until the underlying socket actually closes.
  // Depends only on `awareness` (NOT selfEditingNodeId) so it doesn't
  // re-fire on every node toggle.
  useEffect(() => {
    if (!awareness) return;
    return () => {
      clearAwarenessField(awareness, 'editingNodeId');
    };
  }, [awareness]);

  // One-shot unmount cleanup for the editing field. Reads the
  // latest awareness via ref so a connection that came in mid-
  // component-life still gets cleared on tear-down.
  useEffect(() => {
    return () => {
      const a = awarenessRef.current;
      if (a) clearAwarenessField(a, 'editingNodeId');
    };
  }, []);

  // Subscribe to awareness changes and project them into a flat
  // list of OTHER editors.
  useEffect(() => {
    if (!awareness) return;
    const recompute = () => {
      const states = awareness.getStates();
      const list: PresentUser[] = [];
      for (const [clientId, state] of states.entries()) {
        if (clientId === awareness.clientID) continue;
        const user = (state as AwarenessState).user;
        if (!user?.displayName) continue;
        const editingNodeId = (state as AwarenessState).editingNodeId;
        list.push({
          clientId,
          userId: user.userId,
          displayName: user.displayName,
          color: user.color || (user.userId ? colorForUser(user.userId) : '#94a3b8'),
          editingNodeId: typeof editingNodeId === 'string' ? editingNodeId : undefined,
        });
      }
      // Stable ordering — chips shouldn't reshuffle when an
      // unrelated awareness field updates.
      list.sort((a, b) => a.clientId - b.clientId);
      setOthers((prev) => (samePresence(prev, list) ? prev : list));
    };
    recompute();
    awareness.on('change', recompute);
    return () => awareness.off('change', recompute);
  }, [awareness]);

  return others;
}
