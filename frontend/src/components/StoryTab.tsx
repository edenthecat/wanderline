import { useState, useEffect, useMemo, useRef, useCallback, type ChangeEvent } from 'react';
import {
  uploadInk,
  uploadInkJson,
  uploadTwee,
  exportStorySource,
  type StoryGraph,
} from '../api/client';
import ValidationPanel from './ValidationPanel';
import StoryHealthPanel from './StoryHealthPanel';
import InkSourceEditor from './InkSourceEditor';
import TweeSourceEditor from './TweeSourceEditor';
import { useVocab } from '../hooks/useVocab';
import type { Nomenclature, NomenclaturePreference } from '../lib/nomenclature';
import NodeDetail, { hasCustomTiming } from './NodeDetail';
import NodeRenameButton from './NodeRenameButton';
import { useYjs } from '../hooks/useYjs';
import { useNodeEditor } from '../hooks/useNodeEditor';
import { useYjsSeedReady } from '../hooks/useStoryYDoc';

interface Props {
  projectId: string;
  storyGraph: StoryGraph | null;
  inkSource: string | null;
  /**: Twee 3 source counterpart to inkSource. Populated
   * when source_language='twee'; otherwise null. */
  tweeSource: string | null;
  /**: which format the user is currently authoring in. Drives
   * the source editor swap (Ink vs Twee) and the vocab lookup. */
  sourceLanguage: Nomenclature;
  /**: user override for nomenclature vocab. */
  nomenclaturePreference: NomenclaturePreference;
  /** Bumped by the parent after every story-replacing upload (from
   * StoryTab itself OR a sibling like GraphTab). Combined with
   * projectId in the InkSourceEditor's resetKey so the editor
   * force-overwrites local edits on an explicit replace. */
  sourceResetKey: number;
  /** Async so callers (the file upload + source editor save flows)
   * can sequence the refetch ahead of `onSourceReplaced()` and avoid
   * a one-render window where the editor force-overwrites with the
   * stale OLD seed before the new initialSource arrives. */
  onStoryUpdated: () => Promise<void>;
  /** Reported back to ProjectDetailPage when an in-tab upload
   * succeeds, so the parent can bump sourceResetKey for any peer
   * editor (GraphTab's slide-in source panel reads the same key). */
  onSourceReplaced: () => void;
  /**
   * Collaboration QoL: list of other connected users (from
   * usePresence) and a setter for "the node I'm currently
   * editing". StoryTab publishes the focused node id so peers
   * can render a "Jane is editing _intro" indicator.
   */
  otherPresence: import('../hooks/usePresence').PresentUser[];
  onSelfEditingNodeChange: (nodeId: string | null) => void;
}

type TypeFilter = 'all' | 'knot' | 'stitch';

function hasAudio(node: { audio?: Record<string, unknown> }): boolean {
  if (!node.audio) return false;
  return Object.values(node.audio).some(
    (v) => v && (typeof v === 'string' ? v.length > 0 : Array.isArray(v) && v.length > 0),
  );
}

export default function StoryTab({
  projectId,
  storyGraph,
  inkSource,
  tweeSource,
  sourceLanguage,
  nomenclaturePreference,
  sourceResetKey,
  onStoryUpdated,
  onSourceReplaced,
  otherPresence,
  onSelfEditingNodeChange,
}: Props) {
  const vocab = useVocab(sourceLanguage, nomenclaturePreference);
  const useTweeEditor = sourceLanguage === 'twee';
  // subscribe to the collaborative Y.Doc for this project.
  // The doc is shared with anyone else who has this project open;
  // we pass it down so NodeDetail can bind editable text fields to
  // their Y.Text counterparts. Reads still come from the storyGraph
  // JSON prop — phase 6 migrates the read path too.
  const { doc: yDoc } = useYjs(projectId);
  // Y.Doc updates don't trigger React re-renders. Without this gate,
  // the very first render (which happens before the WS sync delivers
  // the seed) sees an empty `nodes` Y.Map, getChoiceText returns
  // null, and every CollabChoiceTextInput sticks on the REST-only
  // fallback path forever. useYjsSeedReady forces a re-render once
  // the seed arrives so the collaborative input takes over.
  const yDocReady = useYjsSeedReady(yDoc);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  // 'nodes' = parsed-node editor; 'source' = raw Ink CodeMirror
  // surface (lets authors edit + save back to ink_source from the
  // same tab they're already in).
  const [view, setView] = useState<'nodes' | 'source'>('nodes');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track whether the InkSourceEditor has unsaved edits so the file-
  // upload flow can confirm with the user before discarding them.
  const sourceDirtyRef = useRef(false);

  // guard against source-tab STARTER_TEMPLATE data loss.
  // Every graph-mutating PATCH clears both ink_source and twee_source
  // (so cached exports don't drift from the current graph). Without
  // a repopulation step, opening the Source tab afterwards would
  // seed the editor with STARTER_TEMPLATE (the fallback for empty
  // initialSource) and a stray Save would wipe the story. When the
  // relevant source column is null but the graph is populated, hit
  // the exports endpoint — the backend re-emits from story_graph
  // and caches the result — and use that text as the editor seed.
  const [regeneratedSource, setRegeneratedSource] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  // Treat empty strings the same as null — the fetch-and-repopulate
  // path already runs when the cache is empty; if we didn't normalise
  // here, `editorSeed = '' ?? regenerated ?? ''` would coalesce to
  // '' (since `??` only falls through on null/undefined) and the
  // editor would seed STARTER_TEMPLATE anyway.
  const rawSource = useTweeEditor ? tweeSource : inkSource;
  const currentSource = rawSource === '' ? null : rawSource;
  useEffect(() => {
    // Whenever the source-language cache clears, drop any prior
    // regenerated value so we don't reseed the editor with a stale
    // pre-mutation regen.
    setRegeneratedSource(null);
  }, [currentSource, projectId]);
  useEffect(() => {
    if (view !== 'source') return;
    if (!storyGraph) return;
    if (currentSource !== null) return;
    if (regeneratedSource !== null) return;
    let cancelled = false;
    setRegenerating(true);
    exportStorySource(projectId, useTweeEditor ? 'twee' : 'ink')
      .then((text) => {
        if (!cancelled) setRegeneratedSource(text);
      })
      .catch((err) => {
        // If the export endpoint 500s or 404s (e.g. no story_graph
        // yet on a corrupted row) we leave regeneratedSource null,
        // and the editor renders STARTER_TEMPLATE. Only surface a
        // real error message; the empty case is fine.
        if (!cancelled && err instanceof Error) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setRegenerating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [view, storyGraph, currentSource, projectId, useTweeEditor, regeneratedSource]);
  const editorSeed = currentSource ?? regeneratedSource ?? '';

  // Save the editor's current Ink source through the same endpoint
  // the upload flow uses. The backend re-parses, validates, and
  // invalidates the live collab room so peers reconnect against the
  // fresh story. Errors (parser failures + 4xx) propagate so the
  // editor can surface them next to its Save button.
  const handleSaveInkSource = useCallback(
    async (next: string) => {
      await uploadInk(projectId, next);
      await onStoryUpdated();
    },
    [projectId, onStoryUpdated],
  );

  // Twee counterpart. Hits POST /twine so the backend flips
  // source_language to 'twee' and clears ink_source.
  const handleSaveTweeSource = useCallback(
    async (next: string) => {
      await uploadTwee(projectId, next);
      await onStoryUpdated();
    },
    [projectId, onStoryUpdated],
  );

  // Stable callback so the editor's dirty-reporter effect deps
  // don't churn on every parent render.
  const handleSourceDirtyChange = useCallback((dirty: boolean) => {
    sourceDirtyRef.current = dirty;
  }, []);

  // Shared editor state + handlers. GraphTab calls the same hook so
  // both views drive the same NodeDetail panel through the same
  // metadata cache, debounce timers, and cross-tab signal.
  const {
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
  } = useNodeEditor({ projectId, storyGraph, onStoryUpdated, yDoc });

  // Clear our presence-published editing node on project change so a
  // leftover nodeId from project A isn't broadcast into project B.
  useEffect(() => {
    editingStackRef.current = [];
    onSelfEditingNodeChange(null);
  }, [projectId, onSelfEditingNodeChange]);

  async function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);

    try {
      const text = await file.text();
      // format sniff based on file extension AND content
      // markers so a mis-named .txt still dispatches to the right
      // parser. Order matters:
      //   1. Twine 2 published .html archives (root <tw-storydata>) —
      //      reject up front with an "export as Twee 3" hint rather
      //      than let the parser hit a generic no_passages error.
      //   2. `.ink.json` / `.json` → the Ink JSON parser. Even when
      //      the file lacks a top-level `inkVersion` the endpoint's
      //      dedicated 400 ("Compiled Ink JSON is required") gives
      //      the author a clearer diagnosis than falling through to
      //      the Ink source parser (which would report a cascade of
      //      unrelated syntax errors).
      //   3. Twee 3 — .tw/.tw2/.tw3/.twee or a `:: ` line-start.
      //   4. Default to Ink source for the traditional .ink flow.
      const lower = file.name.toLowerCase();
      const head = text.slice(0, 4096);
      const isPublishedTwineHtml = /\.html?$/.test(lower) && /<tw-storydata\b/i.test(head);
      if (isPublishedTwineHtml) {
        throw new Error(
          "This looks like a Twine 2 published .html archive, which we can't import directly. In Twine, use File → Publish to → Twee 3 (or open the story and choose Story → Export as Twee) and upload the resulting .twee file.",
        );
      }
      const looksLikeTwee = /\.(tw|tw2|tw3|twee)$/.test(lower) || /(^|\n):: /.test(head);
      if (lower.endsWith('.ink.json') || lower.endsWith('.json')) {
        await uploadInkJson(projectId, text);
      } else if (looksLikeTwee) {
        await uploadTwee(projectId, text);
      } else {
        await uploadInk(projectId, text);
      }
      // Await the parent's refetch BEFORE bumping the InkSourceEditor's
      // resetKey via onSourceReplaced. Without sequencing the editor
      // briefly force-overwrites with the OLD seed (because resetKey
      // changed before the new initialSource prop arrived) and that
      // OLD-seed insertion pollutes CodeMirror's undo history.
      await onStoryUpdated();
      onSourceReplaced();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function openFilePicker() {
    // Confirm before discarding unsaved source edits. Without this
    // guard, "Replace story file" silently wipes the editor's
    // in-progress draft — destructive UX for a one-click button.
    if (sourceDirtyRef.current) {
      const ok = window.confirm(
        'You have unsaved changes in the Source editor. Replace anyway?\n\n' +
          'Your unsaved edits will be discarded.',
      );
      if (!ok) return;
    }
    // Clear BEFORE opening the picker. Some browsers don't refire
    // `change` when the user picks a file that matches the input's
    // current value verbatim, even after a programmatic .click().
    // Clearing here makes "Replace story file" with the same
    // filename always work; the finally-clear in handleFileUpload
    // is redundant now and could be removed without changing
    // behaviour (left in place for defence-in-depth).
    if (fileInputRef.current) fileInputRef.current.value = '';
    fileInputRef.current?.click();
  }

  // Ordered list of currently-expanded nodes; the last one is what
  // we broadcast as "this user is editing X." Maintained as a
  // parallel structure to expandedNodes so that collapsing a
  // not-most-recently-opened knot doesn't yank presence off the one
  // the user is still focused on.
  const editingStackRef = useRef<string[]>([]);

  // When the user switches away from the Story tab, StoryTab
  // unmounts but ProjectDetailPage keeps the last selfEditingNodeId
  // around — peers would otherwise see a stale "editing X" dot until
  // the user comes back and toggles. Clear on unmount.
  useEffect(
    () => () => {
      onSelfEditingNodeChange(null);
    },
    [onSelfEditingNodeChange],
  );

  // Scroll + expand a given node in the list. Shared by
  // ValidationPanel and StoryHealthPanel.
  const jumpToNode = useCallback(
    (nodeId: string) => {
      setSearch('');
      setTypeFilter('all');
      // Keep the editing stack in sync with expandedNodes so a
      // later toggleNode call doesn't drift. Jumping also focuses
      // the user on the target, so promote it to stack top.
      const toAdd: string[] = [nodeId];
      const dot = nodeId.indexOf('.');
      if (dot > 0) toAdd.unshift(nodeId.slice(0, dot));
      editingStackRef.current = [
        ...editingStackRef.current.filter((id) => !toAdd.includes(id)),
        ...toAdd,
      ];
      const top = editingStackRef.current[editingStackRef.current.length - 1] ?? null;
      onSelfEditingNodeChange(top);
      setExpandedNodes((prev) => {
        const next = new Set(prev);
        for (const id of toAdd) next.add(id);
        return next;
      });
      const selector = `[data-node-id="${CSS.escape(nodeId)}"]`;
      let attempts = 0;
      const tryScroll = () => {
        const el = document.querySelector(selector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }
        if (attempts++ < 10) setTimeout(tryScroll, 50);
      };
      tryScroll();
    },
    [onSelfEditingNodeChange],
  );

  function toggleNode(nodeId: string) {
    const wasExpanded = expandedNodes.has(nodeId);
    if (wasExpanded) {
      editingStackRef.current = editingStackRef.current.filter((id) => id !== nodeId);
    } else {
      // Move-to-top: if it was already in the stack (shouldn't be,
      // but defensive), bump it to the end so it becomes top.
      editingStackRef.current = [...editingStackRef.current.filter((id) => id !== nodeId), nodeId];
    }
    const top = editingStackRef.current[editingStackRef.current.length - 1] ?? null;
    onSelfEditingNodeChange(top);
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (wasExpanded) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }

  // Build a per-node list of who else has it open. Renders as
  // tiny colored chips on the knot header so authors can see at a
  // glance "Jane and Aki are editing this knot." Re-keyed by
  // otherPresence so a peer joining/leaving doesn't churn the
  // whole nodes array.
  const peersByNode = useMemo(() => {
    const map = new Map<string, typeof otherPresence>();
    for (const peer of otherPresence) {
      if (!peer.editingNodeId) continue;
      const existing = map.get(peer.editingNodeId) ?? [];
      existing.push(peer);
      map.set(peer.editingNodeId, existing);
    }
    return map;
  }, [otherPresence]);

  const nodes = useMemo(() => (storyGraph ? Object.values(storyGraph.nodes) : []), [storyGraph]);

  const childrenByParent = useMemo(() => {
    const map = new Map<string, typeof nodes>();
    for (const n of nodes) {
      if (n.parent) {
        const arr = map.get(n.parent) || [];
        arr.push(n);
        map.set(n.parent, arr);
      }
    }
    return map;
  }, [nodes]);

  const knots = useMemo(() => nodes.filter((n) => n.type === 'knot'), [nodes]);
  const stitchCount = useMemo(() => nodes.filter((n) => n.type === 'stitch').length, [nodes]);
  const nodesWithAudio = useMemo(() => nodes.filter(hasAudio).length, [nodes]);

  const isFiltering = search.trim() !== '' || typeFilter !== 'all';

  const filteredNodes = useMemo(() => {
    if (!isFiltering) return [];
    const q = search.toLowerCase().trim();
    return nodes.filter((n) => {
      if (typeFilter !== 'all' && n.type !== typeFilter) return false;
      if (q) {
        const idMatch = n.id.toLowerCase().includes(q);
        const contentMatch = n.content.some((c) => c.text.toLowerCase().includes(q));
        if (!idMatch && !contentMatch) return false;
      }
      return true;
    });
  }, [nodes, search, typeFilter, isFiltering]);

  return (
    <div className="tab-panel">
      <div className="section-header">
        <h2>Story</h2>
        <div className="section-actions">
          <div
            className="graph-toolbar-segmented"
            role="group"
            aria-label="Story view"
            data-testid="story-view-toggle"
          >
            <button
              type="button"
              className={view === 'nodes' ? 'is-active' : ''}
              onClick={() => setView('nodes')}
              aria-pressed={view === 'nodes'}
            >
              Nodes
            </button>
            <button
              type="button"
              className={view === 'source' ? 'is-active' : ''}
              onClick={() => setView('source')}
              aria-pressed={view === 'source'}
            >
              Source
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ink,.ink.json,.tw,.tw2,.tw3,.twee,.html,.htm"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
          />
          <button className="btn btn-primary" onClick={openFilePicker} disabled={uploading}>
            {uploading
              ? 'Uploading...'
              : storyGraph
                ? vocab.replaceStoryFile
                : /* On empty projects source_language defaults to
                     'ink' (server-side COALESCE), so falling through to
                     vocab.uploadStoryFile here would read "Upload .ink
                     file" even though the picker also accepts Twee.
                     Use a format-agnostic label until the user's
                     first upload picks a side. */
                  'Upload story file'}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {editorError && (
        <div className="alert alert-error" role="alert">
          {editorError}
        </div>
      )}
      {metadataError && (
        <div className="alert alert-warning" role="alert">
          {metadataError} Existing transcript overrides and timing settings may not be visible —
          retry before saving.{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={retryMetadata}>
            Retry
          </button>
        </div>
      )}

      {view === 'source' ? (
        regenerating && editorSeed === '' ? (
          // We know a story exists but the source-language cache
          // was cleared by a recent graph edit. Wait for the export
          // endpoint's re-emit before mounting the editor — mounting
          // with '' would seed STARTER_TEMPLATE, and any Save at
          // that point would overwrite the whole story.
          <div className="empty-state">
            <p>Regenerating source from graph…</p>
          </div>
        ) : useTweeEditor ? (
          <TweeSourceEditor
            initialSource={editorSeed}
            onSave={handleSaveTweeSource}
            resetKey={`${projectId}#${sourceResetKey}`}
            onDirtyChange={handleSourceDirtyChange}
          />
        ) : (
          <InkSourceEditor
            initialSource={editorSeed}
            onSave={handleSaveInkSource}
            resetKey={`${projectId}#${sourceResetKey}`}
            onDirtyChange={handleSourceDirtyChange}
          />
        )
      ) : !storyGraph ? (
        <div className="empty-state">
          <p>No story uploaded yet.</p>
          <p className="text-muted">
            Upload an .ink, .ink.json, .tw3, or .twee file, or switch to the{' '}
            <button type="button" className="link-button" onClick={() => setView('source')}>
              Source
            </button>{' '}
            view to write from scratch.
          </p>
        </div>
      ) : (
        <>
          <ValidationPanel
            errors={storyGraph.validation.errors}
            warnings={storyGraph.validation.warnings}
            onNodeJump={jumpToNode}
          />
          <StoryHealthPanel storyGraph={storyGraph} onJumpToNode={jumpToNode} />
          {/* Stats */}
          <div className="stats-row">
            <div className="stat">
              <span className="stat-value">{nodes.length}</span>
              <span className="stat-label">Nodes</span>
            </div>
            {/*: node + subnode labels come from the vocab so
                a Twee-source project reads "Passages" instead of
                "Knots". Twee has no sub-node concept so subNode.plural
                is empty and we skip that stat entirely. */}
            <div className="stat">
              <span className="stat-value">{knots.length}</span>
              <span className="stat-label">
                {vocab.node.plural.charAt(0).toUpperCase() + vocab.node.plural.slice(1)}
              </span>
            </div>
            {vocab.subNode.plural && (
              <div className="stat">
                <span className="stat-value">{stitchCount}</span>
                <span className="stat-label">
                  {vocab.subNode.plural.charAt(0).toUpperCase() + vocab.subNode.plural.slice(1)}
                </span>
              </div>
            )}
            <div className="stat">
              <span className="stat-value">{nodesWithAudio}</span>
              <span className="stat-label">With Audio</span>
            </div>
          </div>

          {/* Search & Filter */}
          <div className="story-filter-bar">
            <input
              type="text"
              className="input"
              placeholder="Search nodes by ID or content..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search nodes"
            />
            <select
              className="select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
              aria-label="Filter nodes by type"
            >
              <option value="all">All types</option>
              <option value="knot">Knots only</option>
              <option value="stitch">Stitches only</option>
            </select>
          </div>

          {/* Validation is rendered by ValidationPanel above (+ ). */}

          {/* Filtered flat list or tree view */}
          {isFiltering ? (
            <div className="node-tree">
              <h3>
                {filteredNodes.length} result{filteredNodes.length !== 1 ? 's' : ''}
              </h3>
              {filteredNodes.map((node) => (
                <div key={node.id} className="node-group" data-node-id={node.id}>
                  <div className="node-header node-header-static">
                    <span
                      className={`node-type badge ${node.type === 'knot' ? 'badge-blue' : 'badge-gray'}`}
                    >
                      {node.type}
                    </span>
                    <span className="node-name">{node.id}</span>
                    {node.type === 'knot' && (
                      <NodeRenameButton
                        nodeId={node.id}
                        onRename={handleRenameNode}
                        nodeIdSet={nodeIdSet}
                      />
                    )}
                    {hasAudio(node) && <span className="badge badge-green">audio</span>}
                    {hasCustomTiming(metadata[node.id]) && (
                      <span className="badge badge-gray">timing</span>
                    )}
                    {node.content[0]?.text && (
                      <span className="node-preview text-muted">
                        {node.content[0].text.slice(0, 60)}
                        {node.content[0].text.length > 60 ? '...' : ''}
                      </span>
                    )}
                  </div>
                  <NodeDetail
                    key={node.id}
                    nodeId={node.id}
                    node={node}
                    metadata={metadata[node.id]}
                    metadataLoaded={metadataLoaded}
                    nodeIdSet={nodeIdSet}
                    nodeIdOptions={nodeIdOptions}
                    onChoiceTextEdit={(ci, text) => handleChoiceTextEdit(node.id, ci, text)}
                    onContentEdit={(ci, text) => handleNodeContentEdit(node.id, ci, text)}
                    onChoiceTargetEdit={(ci, target) => handleChoiceTargetEdit(node.id, ci, target)}
                    onDivertEdit={(target) => handleDivertEdit(node.id, target)}
                    onAddChoice={(c) => handleAddChoice(node.id, c)}
                    onDeleteChoice={(ci) => handleDeleteChoice(node.id, ci)}
                    onSwapChoices={(from, to) => handleSwapChoices(node.id, from, to)}
                    onMetadataSave={(patch) => handleMetadataSave(node.id, patch)}
                    reachableFrom={reverseEdges.get(node.id)}
                    onJumpToNode={jumpToNode}
                    yDoc={yDoc}
                    yDocReady={yDocReady}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="node-tree">
              <h3>Story nodes</h3>
              {knots.map((knot) => {
                const children = childrenByParent.get(knot.id) || [];
                const isExpanded = expandedNodes.has(knot.id);
                const knotPeers = peersByNode.get(knot.id);
                return (
                  <div key={knot.id} className="node-group" data-node-id={knot.id}>
                    <button
                      className="node-header"
                      onClick={() => toggleNode(knot.id)}
                      aria-expanded={isExpanded}
                      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${knot.id}`}
                    >
                      <span className="node-toggle" aria-hidden="true">
                        {isExpanded ? '\u25BC' : '\u25B6'}
                      </span>
                      <span className="node-type badge badge-blue">knot</span>
                      <span className="node-name">{knot.id}</span>
                      {hasAudio(knot) && <span className="badge badge-green">audio</span>}
                      {hasCustomTiming(metadata[knot.id]) && (
                        <span className="badge badge-gray">timing</span>
                      )}
                      {knotPeers && knotPeers.length > 0 && (
                        <span
                          role="img"
                          aria-label={`Also editing: ${knotPeers.map((p) => p.displayName).join(', ')}`}
                          className="node-peer-dot-group"
                        >
                          {knotPeers.map((peer) => (
                            <span
                              key={peer.clientId}
                              className="node-peer-dot"
                              style={{ background: peer.color }}
                              title={`${peer.displayName} is editing this`}
                              data-testid="node-peer-dot"
                              aria-hidden="true"
                            />
                          ))}
                        </span>
                      )}
                      {knot.content[0]?.text && (
                        <span className="node-preview text-muted">
                          {knot.content[0].text.slice(0, 50)}
                          {knot.content[0].text.length > 50 ? '...' : ''}
                        </span>
                      )}
                      {children.length > 0 && (
                        <span className="text-muted">
                          {children.length} stitch{children.length !== 1 ? 'es' : ''}
                        </span>
                      )}
                    </button>
                    {/* Rendered as a sibling because native HTML
                        forbids nesting a <button> inside another
                        <button>. Positioned via .node-rename-slot
                        in the CSS. */}
                    <div className="node-rename-slot">
                      <NodeRenameButton
                        nodeId={knot.id}
                        onRename={handleRenameNode}
                        nodeIdSet={nodeIdSet}
                        confirmMessage={
                          children.length > 0
                            ? `Rename "${knot.id}"? Its ${children.length} stitch${children.length === 1 ? '' : 'es'} will be re-parented to the new name.`
                            : undefined
                        }
                      />
                    </div>
                    {isExpanded && (
                      <div className="node-children">
                        <NodeDetail
                          key={knot.id}
                          nodeId={knot.id}
                          node={knot}
                          metadata={metadata[knot.id]}
                          metadataLoaded={metadataLoaded}
                          nodeIdSet={nodeIdSet}
                          nodeIdOptions={nodeIdOptions}
                          onChoiceTextEdit={(ci, text) => handleChoiceTextEdit(knot.id, ci, text)}
                          onContentEdit={(ci, text) => handleNodeContentEdit(knot.id, ci, text)}
                          onChoiceTargetEdit={(ci, target) =>
                            handleChoiceTargetEdit(knot.id, ci, target)
                          }
                          onDivertEdit={(target) => handleDivertEdit(knot.id, target)}
                          onAddChoice={(c) => handleAddChoice(knot.id, c)}
                          onDeleteChoice={(ci) => handleDeleteChoice(knot.id, ci)}
                          onSwapChoices={(from, to) => handleSwapChoices(knot.id, from, to)}
                          onMetadataSave={(patch) => handleMetadataSave(knot.id, patch)}
                          reachableFrom={reverseEdges.get(knot.id)}
                          onJumpToNode={jumpToNode}
                          yDoc={yDoc}
                          yDocReady={yDocReady}
                        />
                        {children.map((child) => (
                          <div key={child.id} className="node-child" data-node-id={child.id}>
                            <div className="node-child-header">
                              <span className="node-type badge badge-gray">{child.type}</span>
                              <span className="node-name">{child.id.split('.').pop()}</span>
                              {hasAudio(child) && <span className="badge badge-green">audio</span>}
                              {hasCustomTiming(metadata[child.id]) && (
                                <span className="badge badge-gray">timing</span>
                              )}
                            </div>
                            <NodeDetail
                              key={child.id}
                              nodeId={child.id}
                              node={child}
                              metadata={metadata[child.id]}
                              metadataLoaded={metadataLoaded}
                              nodeIdSet={nodeIdSet}
                              nodeIdOptions={nodeIdOptions}
                              onChoiceTextEdit={(ci, text) =>
                                handleChoiceTextEdit(child.id, ci, text)
                              }
                              onContentEdit={(ci, text) =>
                                handleNodeContentEdit(child.id, ci, text)
                              }
                              onChoiceTargetEdit={(ci, target) =>
                                handleChoiceTargetEdit(child.id, ci, target)
                              }
                              onDivertEdit={(target) => handleDivertEdit(child.id, target)}
                              onAddChoice={(c) => handleAddChoice(child.id, c)}
                              onDeleteChoice={(ci) => handleDeleteChoice(child.id, ci)}
                              onSwapChoices={(from, to) => handleSwapChoices(child.id, from, to)}
                              onMetadataSave={(patch) => handleMetadataSave(child.id, patch)}
                              reachableFrom={reverseEdges.get(child.id)}
                              onJumpToNode={jumpToNode}
                              yDoc={yDoc}
                              yDocReady={yDocReady}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Ink source */}
          {inkSource && (
            <details className="ink-source">
              <summary>View raw Ink source</summary>
              <pre className="code-block">{inkSource}</pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
