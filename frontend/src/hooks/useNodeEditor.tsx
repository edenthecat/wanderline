// Shared editor state + handlers for `<NodeDetail>`. Both StoryTab
// (list view) and GraphTab (canvas view) instantiate this hook so
// they get the same editing surface: bulk metadata fetch, dirty-key
// reconciliation across refetches, debounced choice-text saves, and
// cross-tab signaling via Y.Doc's `metadata` live signal.
//
// The hook is intentionally view-agnostic. Callers pass a projectId
// + storyGraph + onStoryUpdated callback + (optional) Y.Doc and the
// hook returns everything `<NodeDetail>` needs as props.
//
// Why not lift this to a context at the page level? Each tab mounts
// at most one consumer at a time, and the metadata cache fits in
// memory comfortably. A per-tab fetch on mount keeps the wiring
// simple — the Y.Doc `metadata` signal handles cross-tab sync after
// edits so the two caches don't drift while both tabs exist.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { ReactNode } from 'react';
import {
  addChoice,
  deleteChoice,
  fetchMetadata,
  renameNode,
  swapChoices,
  updateChoiceTarget,
  updateChoiceText,
  updateDivert,
  updateNodeContentText,
  updateNodeMetadata,
  type NodeMetadata,
  type StoryGraph,
} from '../api/client';
import { bumpLiveSignal, useLiveSignal } from './useLiveSignal';

const METADATA_SIGNAL = 'metadata';
const CHOICE_TEXT_SAVE_DEBOUNCE_MS = 800;

interface UseNodeEditorArgs {
  projectId: string;
  storyGraph: StoryGraph | null;
  onStoryUpdated: () => void;
  yDoc?: Y.Doc | null;
}

export interface UseNodeEditorResult {
  metadata: Record<string, NodeMetadata>;
  metadataLoaded: boolean;
  metadataError: string | null;
  /** Manually retry the bulk metadata fetch after a transient failure. */
  retryMetadata: () => void;
  /** Set of every node id that exists in the current storyGraph. */
  nodeIdSet: Set<string>;
  /** Pre-rendered <option> nodes for choice/divert target dropdowns
   * (includes END + DONE). Stable per-storyGraph. */
  nodeIdOptions: ReactNode;
  /** Reverse-edge index: which node ids choose-into or divert-into the
   * keyed target. Used by the detail rail's "Reachable from" panel. */
  reverseEdges: Map<string, string[]>;
  handleChoiceTextEdit: (nodeId: string, choiceIndex: number, newText: string) => void;
  handleNodeContentEdit: (nodeId: string, contentIndex: number, newText: string) => void;
  handleChoiceTargetEdit: (nodeId: string, choiceIndex: number, newTarget: string) => void;
  handleDivertEdit: (nodeId: string, newTarget: string) => void;
  handleAddChoice: (
    nodeId: string,
    choice: { text: string; target: string },
    atIndex?: number,
  ) => Promise<void>;
  handleDeleteChoice: (nodeId: string, choiceIndex: number) => Promise<void>;
  handleSwapChoices: (nodeId: string, fromIndex: number, toIndex: number) => Promise<void>;
  /**: rename a node. Rewrites every reference server-side.
   * Resolves when the parent's refetch has run (so the returned
   * newId is safe to switch the selection to). */
  handleRenameNode: (oldId: string, newId: string) => Promise<void>;
  handleMetadataSave: (nodeId: string, patch: Partial<NodeMetadata>) => Promise<void>;
  editorError: string | null;
  clearEditorError: () => void;
}

export function useNodeEditor({
  projectId,
  storyGraph,
  onStoryUpdated,
  yDoc = null,
}: UseNodeEditorArgs): UseNodeEditorResult {
  const [metadata, setMetadata] = useState<Record<string, NodeMetadata>>({});
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  // Bumped by retryMetadata + by the cross-tab signal so peer saves
  // refresh local metadata without needing a manual reload.
  const [metadataReloadKey, setMetadataReloadKey] = useState(0);

  const metadataSignalTick = useLiveSignal(yDoc, METADATA_SIGNAL);
  const lastMetadataSignalRef = useRef(0);
  useEffect(() => {
    if (metadataSignalTick === 0) return;
    if (metadataSignalTick === lastMetadataSignalRef.current) return;
    lastMetadataSignalRef.current = metadataSignalTick;
    setMetadataReloadKey((k) => k + 1);
  }, [metadataSignalTick]);

  // Track which node IDs have been locally saved since the last
  // metadata fetch. When a refetch lands we preserve only the
  // canonical post-save row for those keys (and let the server's
  // response win for every other node). This way concurrent edits
  // from another tab / a project switch / a story replacement
  // reconcile correctly instead of permanently shadowing server data.
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  // Reset metadata state whenever the project changes so we never
  // shadow the new project with entries from the previous one.
  useEffect(() => {
    setMetadata({});
    setMetadataLoaded(false);
    setMetadataError(null);
    dirtyKeysRef.current = new Set();
  }, [projectId]);

  // Bulk-fetch per-node metadata so individual NodeDetail components
  // don't each fire their own request.
  const hasStoryGraph = !!storyGraph;
  useEffect(() => {
    if (!hasStoryGraph) return;
    let cancelled = false;
    const dirtyAtFetchStart = new Set(dirtyKeysRef.current);
    fetchMetadata(projectId)
      .then((res) => {
        if (cancelled) return;
        setMetadata((prev) => {
          const merged: Record<string, NodeMetadata> = { ...res.metadata };
          // Keys that became dirty AFTER the fetch started take
          // priority over the server response. Keys dirty BEFORE the
          // fetch began are assumed to be reflected in the response,
          // so the server's view wins.
          for (const key of dirtyKeysRef.current) {
            if (dirtyAtFetchStart.has(key)) continue;
            if (prev[key]) merged[key] = prev[key];
          }
          return merged;
        });
        for (const key of dirtyAtFetchStart) dirtyKeysRef.current.delete(key);
        setMetadataLoaded(true);
        setMetadataError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMetadataError(
          err instanceof Error
            ? `Couldn't load existing overrides: ${err.message}`
            : "Couldn't load existing overrides.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, hasStoryGraph, metadataReloadKey]);

  const retryMetadata = useCallback(() => {
    setMetadataReloadKey((k) => k + 1);
  }, []);

  // ── Derived: ids + select options for dropdowns ──────────────────
  const allNodeIds = useMemo(() => (storyGraph ? Object.keys(storyGraph.nodes) : []), [storyGraph]);
  const nodeIdSet = useMemo(() => new Set(allNodeIds), [allNodeIds]);
  const reverseEdges = useMemo<Map<string, string[]>>(() => {
    const map = new Map<string, string[]>();
    if (!storyGraph) return map;
    const push = (target: string, sourceId: string) => {
      const list = map.get(target);
      if (list) list.push(sourceId);
      else map.set(target, [sourceId]);
    };
    for (const [sourceId, node] of Object.entries(storyGraph.nodes)) {
      for (const c of node.choices) {
        if (c.target) push(c.target, sourceId);
      }
      if (node.divert) push(node.divert, sourceId);
    }
    // Dedupe (a knot with two choices pointing at the same target
    // shows up twice otherwise) and sort for stable rendering.
    for (const [k, v] of map) {
      map.set(k, Array.from(new Set(v)).sort());
    }
    return map;
  }, [storyGraph]);
  const nodeIdOptions = useMemo<ReactNode>(() => {
    const opts: ReactNode[] = allNodeIds.map((id) => (
      <option key={id} value={id}>
        {id}
      </option>
    ));
    opts.push(
      <option key="END" value="END">
        END
      </option>,
    );
    opts.push(
      <option key="DONE" value="DONE">
        DONE
      </option>,
    );
    return opts;
  }, [allNodeIds]);

  // ── Debounced save (used for high-frequency choice-text edits) ───
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    return () => {
      for (const timer of saveTimers.current.values()) clearTimeout(timer);
      saveTimers.current.clear();
    };
  }, []);
  const debouncedSave = useCallback(
    (key: string, fn: () => Promise<unknown>) => {
      const existing = saveTimers.current.get(key);
      if (existing) clearTimeout(existing);
      saveTimers.current.set(
        key,
        setTimeout(async () => {
          try {
            await fn();
            // Clear any stale error from a prior failure so a
            // subsequent success doesn't leave the banner asserting
            // something that's no longer true.
            setEditorError(null);
            onStoryUpdated();
          } catch (err) {
            setEditorError(err instanceof Error ? err.message : 'Failed to save edit');
          }
          saveTimers.current.delete(key);
        }, CHOICE_TEXT_SAVE_DEBOUNCE_MS),
      );
    },
    [onStoryUpdated],
  );

  const handleChoiceTextEdit = useCallback(
    (nodeId: string, choiceIndex: number, newText: string) => {
      debouncedSave(`ct-${nodeId}-${choiceIndex}`, () =>
        updateChoiceText(projectId, nodeId, choiceIndex, newText),
      );
    },
    [debouncedSave, projectId],
  );

  // Body content text on a knot/stitch. Same debounce + collab
  // shape as choice text — the Y.Doc seeds content as a Y.Array
  // of Y.Maps with text Y.Texts, so peer edits merge naturally
  // while the REST PATCH keeps the canonical story_graph in sync.
  const handleNodeContentEdit = useCallback(
    (nodeId: string, contentIndex: number, newText: string) => {
      debouncedSave(`nc-${nodeId}-${contentIndex}`, () =>
        updateNodeContentText(projectId, nodeId, contentIndex, newText),
      );
    },
    [debouncedSave, projectId],
  );

  const handleChoiceTargetEdit = useCallback(
    (nodeId: string, choiceIndex: number, newTarget: string) => {
      updateChoiceTarget(projectId, nodeId, choiceIndex, newTarget)
        .then(() => {
          setEditorError(null);
          onStoryUpdated();
        })
        .catch((err) => setEditorError(err instanceof Error ? err.message : 'Failed to save'));
    },
    [projectId, onStoryUpdated],
  );

  const handleDivertEdit = useCallback(
    (nodeId: string, newTarget: string) => {
      updateDivert(projectId, nodeId, newTarget)
        .then(() => {
          setEditorError(null);
          onStoryUpdated();
        })
        .catch((err) => setEditorError(err instanceof Error ? err.message : 'Failed to save'));
    },
    [projectId, onStoryUpdated],
  );

  const handleAddChoice = useCallback(
    async (nodeId: string, choice: { text: string; target: string }, atIndex?: number) => {
      // Note: we surface failure via the local AddChoiceRow form
      // (which catches the rethrow), not via the global editorError
      // banner — otherwise the same message would render in both
      // places. The shared banner is for handlers whose UI doesn't
      // have a natural local error slot.
      await addChoice(projectId, nodeId, choice, atIndex);
      setEditorError(null);
      onStoryUpdated();
    },
    [projectId, onStoryUpdated],
  );

  const handleDeleteChoice = useCallback(
    async (nodeId: string, choiceIndex: number) => {
      try {
        await deleteChoice(projectId, nodeId, choiceIndex);
        setEditorError(null);
        onStoryUpdated();
      } catch (err) {
        setEditorError(err instanceof Error ? err.message : 'Failed to remove choice');
        throw err;
      }
    },
    [projectId, onStoryUpdated],
  );

  const handleSwapChoices = useCallback(
    async (nodeId: string, fromIndex: number, toIndex: number) => {
      try {
        await swapChoices(projectId, nodeId, fromIndex, toIndex);
        setEditorError(null);
        onStoryUpdated();
      } catch (err) {
        setEditorError(err instanceof Error ? err.message : 'Failed to reorder');
        throw err;
      }
    },
    [projectId, onStoryUpdated],
  );

  const handleRenameNode = useCallback(
    async (oldId: string, newId: string) => {
      try {
        await renameNode(projectId, oldId, newId);
        setEditorError(null);
        // Await the parent refetch so callers can safely swap the
        // selection to newId once this resolves — otherwise the
        // caller might read stale storyGraph state that still keys
        // by oldId.
        await onStoryUpdated();
      } catch (err) {
        setEditorError(err instanceof Error ? err.message : 'Failed to rename node');
        throw err;
      }
    },
    [projectId, onStoryUpdated],
  );

  const handleMetadataSave = useCallback(
    async (nodeId: string, patch: Partial<NodeMetadata>) => {
      const initialProjectId = projectId;
      const { metadata: updated } = await updateNodeMetadata(initialProjectId, nodeId, patch);
      if (projectIdRef.current !== initialProjectId) return;
      setMetadata((prev) => ({
        ...prev,
        [nodeId]: { ...prev[nodeId], ...updated },
      }));
      dirtyKeysRef.current.add(nodeId);
      // Tell peer tabs to re-fetch metadata so their NodeDetail
      // editors show the new transcript / timing without a manual
      // reload. Bump after the local state is consistent so a
      // round-trip from a peer can't race us.
      bumpLiveSignal(yDoc ?? null, METADATA_SIGNAL);
    },
    [projectId, yDoc],
  );

  const clearEditorError = useCallback(() => setEditorError(null), []);

  return {
    metadata,
    metadataLoaded,
    metadataError,
    retryMetadata,
    nodeIdSet,
    nodeIdOptions,
    reverseEdges,
    handleChoiceTextEdit,
    handleNodeContentEdit,
    handleChoiceTargetEdit,
    handleDivertEdit,
    handleAddChoice,
    handleDeleteChoice,
    handleSwapChoices,
    handleRenameNode,
    handleMetadataSave,
    editorError,
    clearEditorError,
  };
}
