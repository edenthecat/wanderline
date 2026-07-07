import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  ReactFlowProvider,
  type Node as RFNode,
  type Edge as RFEdge,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
  type Connection,
} from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import '@xyflow/react/dist/style.css';
import { updateChoiceTarget, updateDivert, type StoryGraph, type StoryNode } from '../api/client';
import NodeDetail from './NodeDetail';
import InkSourceEditor from './InkSourceEditor';
import { useNodeEditor } from '../hooks/useNodeEditor';
import { uploadInk } from '../api/client';
import { useYjs } from '../hooks/useYjs';
import { useYjsSeedReady } from '../hooks/useStoryYDoc';

interface Props {
  projectId: string;
  storyGraph: StoryGraph | null;
  /** Current raw .ink source. Passed in so the slide-in source
   * editor doesn't need a second fetch — the parent already has it. */
  inkSource: string | null;
  /** Bumped by the parent after any story-replacing upload (StoryTab,
   * here, or any future surface) so this slide-in source editor also
   * force-resets instead of holding stale dirty edits. */
  sourceResetKey: number;
  /** Async so the source editor's Save flow can sequence the refetch
   * ahead of the resetKey bump and avoid a stale-seed flash window. */
  onStoryUpdated: () => Promise<void>;
  /** Called after this tab's source-editor Save lands so the parent
   * bumps sourceResetKey for the other tabs' editors. */
  onSourceReplaced: () => void;
}

// Node sizing — fed into both the dagre layout and the React Flow render.
const NODE_WIDTH = 200;
const NODE_HEIGHT = 78;

function hasAudio(n: StoryNode): boolean {
  if (!n.audio) return false;
  return Object.values(n.audio).some(
    (v) => v && (typeof v === 'string' ? v.length > 0 : Array.isArray(v) && v.length > 0),
  );
}

interface StoryCardData {
  storyNode: StoryNode;
  isStart: boolean;
  isEnding: boolean;
  severity: 'error' | 'warning' | null;
  hasAudio: boolean;
  choices: { text: string; target: string }[];
  hasDivert: boolean;
  preview: string;
  /** Used by jumpToNextMatch / onNavigate to center the canvas
   * accurately on tall cards (choice/divert rows vary the height). */
  cardHeight: number;
  /** Set by the parent: dim this node because it's unreachable from start. */
  dim: boolean;
  /** Set by the parent: highlight as part of the active path-trace. */
  onPath: boolean;
  /** Set by the parent: matched by the current search query. */
  matched: boolean;
  /** Set by the parent: there's a search query AND this node doesn't match. */
  unmatched: boolean;
}

// Card-style node renderer inspired by node-canvas editors (ComfyUI /
// drawthings vibe). New for graph v2:
//   - One source handle per choice + an extra one for the divert, so
//     edges leave from a specific row instead of all stacking at the
//     bottom edge. This is what makes drag-to-retarget feel natural —
//     you grab the handle that belongs to the choice you want to
//     change.
//   - `is-ending` styling for nodes tagged #ending.
//   - dim / on-path / matched flags drive search + path-trace visuals.
const StoryCardNode = memo(function StoryCardNode({ data, selected }: NodeProps) {
  const d = data as unknown as StoryCardData;
  const cls = ['graph-node-card'];
  if (selected) cls.push('is-selected');
  if (d.isStart) cls.push('is-start');
  if (d.isEnding) cls.push('is-ending');
  if (d.severity === 'error') cls.push('is-error');
  if (d.severity === 'warning') cls.push('is-warning');
  if (d.storyNode.type === 'stitch') cls.push('is-stitch');
  if (d.dim) cls.push('is-dim');
  if (d.onPath) cls.push('is-on-path');
  if (d.matched) cls.push('is-matched');
  if (d.unmatched) cls.push('is-unmatched');

  return (
    <div className={cls.join(' ')}>
      <Handle type="target" position={Position.Top} className="graph-node-handle" />
      <div className="graph-node-card-header">
        <span className="graph-node-chip" data-kind={d.storyNode.type}>
          {d.isStart ? 'start' : d.isEnding ? 'ending' : d.storyNode.type}
        </span>
        <span
          className={`graph-node-dot ${d.hasAudio ? 'is-on' : 'is-off'}`}
          aria-label={d.hasAudio ? 'has audio' : 'no audio assigned'}
        />
      </div>
      <div className="graph-node-card-title">{d.storyNode.id}</div>
      {d.choices.length > 0 && (
        <ul className="graph-node-choices">
          {d.choices.map((c, i) => {
            const label = c.text || `Choice ${i + 1}`;
            const trimmedLabel = label.length > 20 ? `${label.slice(0, 20)}…` : label;
            const target = c.target || '?';
            const trimmedTarget = target.length > 14 ? `…${target.slice(-14)}` : target;
            return (
              <li key={i} className="graph-node-choice-row">
                <span className="graph-node-choice-bullet" aria-hidden="true">
                  ►
                </span>
                <span className="graph-node-choice-text" title={`${label}  →  ${target}`}>
                  {trimmedLabel}
                </span>
                <span className="graph-node-choice-target" title={target}>
                  {trimmedTarget}
                </span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`choice-${i}`}
                  className="graph-node-handle graph-node-handle-row"
                />
              </li>
            );
          })}
        </ul>
      )}
      {d.hasDivert && (
        <div className="graph-node-card-footer graph-node-divert-row">
          <span className="graph-node-divert-bullet" aria-hidden="true">
            ↪
          </span>
          <span className="graph-node-divert-label">fall-through</span>
          <Handle
            type="source"
            position={Position.Right}
            id="divert"
            className="graph-node-handle graph-node-handle-row graph-node-handle-divert"
          />
        </div>
      )}
      {/* Fallback bottom-edge handle so terminal/single-edge cases
          still have a default attach point — used by the dagre
          layout for "node has no rows" outliers. Marked
          non-connectable so dragging from it can't fire a retarget
          we have no API slot to write through. */}
      {d.choices.length === 0 && !d.hasDivert && (
        <Handle
          type="source"
          position={Position.Bottom}
          id="default"
          className="graph-node-handle"
          isConnectable={false}
        />
      )}
    </div>
  );
});

// Terminal sinks (END / DONE) — pill, no handles needed on the source.
const TerminalNode = memo(function TerminalNode({ data }: NodeProps) {
  const label = (data as { label: string }).label;
  return (
    <div className="graph-node-terminal">
      <Handle type="target" position={Position.Top} className="graph-node-handle" />
      {label}
    </div>
  );
});

// "Missing" — author references a target that doesn't exist. Mirrors
// the card shape but in danger styling.
const MissingNode = memo(function MissingNode({ data }: NodeProps) {
  const label = (data as { label: string }).label;
  return (
    <div className="graph-node-card is-missing">
      <Handle type="target" position={Position.Top} className="graph-node-handle" />
      <div className="graph-node-card-header">
        <span className="graph-node-chip" data-kind="missing">
          missing
        </span>
      </div>
      <div className="graph-node-card-title">{label}</div>
    </div>
  );
});

const NODE_TYPES = {
  storyCard: StoryCardNode,
  terminal: TerminalNode,
  missing: MissingNode,
};

// Resolve `target` semantically: END / DONE are terminal sinks (drawn
// once as a synthetic node), unknown targets render as "missing" nodes
// so the author can see the broken edge in context.
function resolveTarget(
  target: string,
  nodes: Record<string, StoryNode>,
): { id: string; missing: boolean; terminal: boolean } {
  if (target === 'END' || target === 'DONE') return { id: target, missing: false, terminal: true };
  if (nodes[target]) return { id: target, missing: false, terminal: false };
  return { id: target, missing: true, terminal: false };
}

// Resolve the rendered height of a ReactFlow node for centering math.
// Story cards stash their dagre-fed cardHeight in node.data; terminal
// + missing nodes fall back to the constant NODE_HEIGHT (synthetic
// nodes are uniform).
function nodeHeightOf(node: RFNode): number {
  if (node.type === 'storyCard') {
    const data = node.data as unknown as StoryCardData;
    if (typeof data.cardHeight === 'number') return data.cardHeight;
  }
  return NODE_HEIGHT;
}

// Per-choice handle row adds ~18px to the card; account for that in
// the dagre layout so edges + cards don't overlap. The base is the
// CSS min-height of `.graph-node-card` (NODE_HEIGHT = 78px, covers
// header + title + padding); each additional row (choice or divert)
// adds its own height on top.
const CHOICE_ROW_HEIGHT = 18;
function estimateCardHeight(node: StoryNode): number {
  const choiceRows = (node.choices?.length ?? 0) * CHOICE_ROW_HEIGHT;
  const divertRow = node.divert ? CHOICE_ROW_HEIGHT : 0;
  return NODE_HEIGHT + choiceRows + divertRow;
}

function isEnding(node: StoryNode): boolean {
  if (!node.tags) return false;
  return node.tags.some((t) => t.toLowerCase() === 'ending');
}

function buildLayout(
  storyGraph: StoryGraph,
  rankdir: 'TB' | 'LR' = 'TB',
): { nodes: RFNode[]; edges: RFEdge[] } {
  // Bucket validation messages by nodeId so each rendered node can pick
  // up the strongest severity referencing it. An error trumps a warning.
  const severityByNode = new Map<string, 'error' | 'warning'>();
  for (const w of storyGraph.validation.warnings) {
    if (w.nodeId) severityByNode.set(w.nodeId, 'warning');
  }
  for (const e of storyGraph.validation.errors) {
    if (e.nodeId) severityByNode.set(e.nodeId, 'error');
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir, ranksep: 80, nodesep: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  const nodeIds: string[] = [];
  const syntheticIds = new Set<string>();
  const missingIds = new Set<string>();

  // First pass: collect every distinct node referenced (real + END/DONE +
  // missing), so dagre has the full set before we assign edges.
  for (const [id, node] of Object.entries(storyGraph.nodes)) {
    nodeIds.push(id);
    g.setNode(id, { width: NODE_WIDTH, height: estimateCardHeight(node) });
    for (const ch of node.choices) {
      const t = resolveTarget(ch.target, storyGraph.nodes);
      if (t.terminal) syntheticIds.add(t.id);
      if (t.missing) missingIds.add(t.id);
    }
    if (node.divert) {
      const t = resolveTarget(node.divert, storyGraph.nodes);
      if (t.terminal) syntheticIds.add(t.id);
      if (t.missing) missingIds.add(t.id);
    }
  }
  for (const id of syntheticIds) g.setNode(id, { width: 80, height: 40 });
  for (const id of missingIds) g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });

  // Edges. Smoothstep for the soft routed look; thinner stroke so
  // big graphs don't feel chaotic; muted color from the design
  // tokens; missing-target edges go red + animated to draw the eye.
  // sticky choices get a dotted stroke; fallback choices get italic
  // label + amber tint so authors can read the flow at a glance.
  const edges: RFEdge[] = [];
  for (const [id, node] of Object.entries(storyGraph.nodes)) {
    node.choices.forEach((ch, idx) => {
      const t = resolveTarget(ch.target, storyGraph.nodes);
      g.setEdge(id, t.id);
      const stroke = t.missing
        ? '#dc2626'
        : ch.fallback
          ? '#d97706'
          : ch.sticky
            ? '#0891b2'
            : '#94a3b8';
      // Tiny edge label so zoomed-out users can read the flow without
      // hunting for the source card. Truncate to keep the canvas
      // legible. The label sits over a translucent white pill.
      const labelRaw = ch.text || `choice ${idx + 1}`;
      const label = labelRaw.length > 18 ? `${labelRaw.slice(0, 18)}…` : labelRaw;
      edges.push({
        id: `${id}->${t.id}#choice-${idx}`,
        source: id,
        sourceHandle: `choice-${idx}`,
        target: t.id,
        type: 'smoothstep',
        animated: t.missing,
        label,
        labelStyle: { fontSize: 10, fill: '#475569' },
        labelBgPadding: [3, 2],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: '#ffffff', fillOpacity: 0.92 },
        data: { sourceNodeId: id, sourceChoiceIndex: idx, kind: 'choice' as const },
        style: {
          stroke,
          strokeWidth: 1.6,
          strokeDasharray: ch.sticky && !t.missing ? '5 3' : undefined,
        },
      });
    });
    if (node.divert) {
      const t = resolveTarget(node.divert, storyGraph.nodes);
      g.setEdge(id, t.id);
      edges.push({
        id: `${id}->divert->${t.id}`,
        source: id,
        sourceHandle: 'divert',
        target: t.id,
        type: 'smoothstep',
        animated: t.missing,
        label: 'fall-through',
        labelStyle: { fontSize: 9.5, fill: '#64748b', fontStyle: 'italic' },
        labelBgPadding: [3, 2],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
        data: { sourceNodeId: id, kind: 'divert' as const },
        style: {
          stroke: t.missing ? '#dc2626' : '#94a3b8',
          strokeWidth: 1.6,
          strokeDasharray: '4 3',
        },
      });
    }
  }

  dagre.layout(g);

  const nodes: RFNode[] = [];
  for (const id of nodeIds) {
    const layout = g.node(id);
    const sn = storyGraph.nodes[id];
    const isStart = id === storyGraph.startNode;
    const ending = isEnding(sn);
    const contentText = sn.content?.map((c) => c.text).join(' ') ?? '';
    const preview = contentText.length > 140 ? `${contentText.slice(0, 140).trim()}…` : contentText;
    const cardHeight = estimateCardHeight(sn);
    nodes.push({
      id,
      type: 'storyCard',
      position: { x: layout.x - NODE_WIDTH / 2, y: layout.y - cardHeight / 2 },
      data: {
        storyNode: sn,
        isStart,
        isEnding: ending,
        severity: severityByNode.get(id) ?? null,
        hasAudio: hasAudio(sn),
        choices: (sn.choices ?? []).map((c) => ({ text: c.text, target: c.target })),
        hasDivert: !!sn.divert,
        preview,
        cardHeight,
        dim: false,
        onPath: false,
        matched: false,
        unmatched: false,
      } satisfies StoryCardData,
    });
  }
  for (const id of syntheticIds) {
    const layout = g.node(id);
    nodes.push({
      id,
      type: 'terminal',
      position: { x: layout.x - 40, y: layout.y - 20 },
      data: { label: id },
    });
  }
  for (const id of missingIds) {
    const layout = g.node(id);
    nodes.push({
      id,
      type: 'missing',
      position: { x: layout.x - NODE_WIDTH / 2, y: layout.y - NODE_HEIGHT / 2 },
      data: { label: id },
    });
  }

  return { nodes, edges };
}

/**
 * Interactive story graph view. Renders the storyGraph as a
 * directed graph with dagre auto-layout, pan + zoom, mini-map, and a
 * fit-to-content button. Knots are filled boxes, stitches are dashed,
 * the start node has a thicker accent border, audio-having nodes get a
 * 🔊 prefix, and missing-target nodes / edges are red.
 */
export default function GraphTab(props: Props) {
  // useReactFlow needs to live inside a Provider; wrap once so the
  // inner component can drive zoom + center on the start node + open
  // a detail rail when a node is clicked.
  return (
    <ReactFlowProvider>
      <GraphTabInner {...props} />
    </ReactFlowProvider>
  );
}

interface PathTrace {
  nodes: Set<string>;
  /** Set of "source->target" pairs along the shortest path. Used to
   * highlight only the edges that participate in the route, not
   * every edge between any two on-path nodes (a sibling choice
   * pointing forward to a later on-path node should NOT light up). */
  edgePairs: Set<string>;
}

// BFS shortest path on the choice/divert DAG. Returns both the node
// set AND the consecutive (source,target) pairs that form the route.
function shortestPath(storyGraph: StoryGraph, fromId: string, toId: string): PathTrace | null {
  if (!storyGraph.nodes[fromId] || !storyGraph.nodes[toId]) return null;
  if (fromId === toId) return { nodes: new Set([fromId]), edgePairs: new Set() };
  const prev = new Map<string, string | null>();
  prev.set(fromId, null);
  const queue: string[] = [fromId];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const node = storyGraph.nodes[id];
    if (!node) continue;
    const out: string[] = [];
    for (const c of node.choices) out.push(c.target);
    if (node.divert) out.push(node.divert);
    for (const t of out) {
      if (!storyGraph.nodes[t]) continue;
      if (prev.has(t)) continue;
      prev.set(t, id);
      if (t === toId) {
        const nodes = new Set<string>();
        const edgePairs = new Set<string>();
        let cur: string | null = toId;
        while (cur !== null) {
          nodes.add(cur);
          const p = prev.get(cur);
          if (p) edgePairs.add(`${p}->${cur}`);
          cur = p ?? null;
        }
        return { nodes, edgePairs };
      }
      queue.push(t);
    }
  }
  return null;
}

// BFS reachable-from-start. Used for the "dim unreachable" treatment.
function computeReachable(storyGraph: StoryGraph): Set<string> {
  const reachable = new Set<string>();
  if (!storyGraph.startNode || !storyGraph.nodes[storyGraph.startNode]) return reachable;
  reachable.add(storyGraph.startNode);
  const queue: string[] = [storyGraph.startNode];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const node = storyGraph.nodes[id];
    if (!node) continue;
    const out: string[] = [];
    for (const c of node.choices) out.push(c.target);
    if (node.divert) out.push(node.divert);
    for (const t of out) {
      if (!storyGraph.nodes[t]) continue;
      if (reachable.has(t)) continue;
      reachable.add(t);
      queue.push(t);
    }
  }
  return reachable;
}

function GraphTabInner({
  projectId,
  storyGraph,
  inkSource,
  sourceResetKey,
  onStoryUpdated,
  onSourceReplaced,
}: Props) {
  // Same Y.Doc as StoryTab so collaborative choice-text edits stay in
  // sync across whichever tab is open. Note: useYjs maintains a
  // ref-counted singleton per projectId, so this is the SAME doc as
  // the one StoryTab has when both tabs are mounted.
  const { doc: yDoc } = useYjs(projectId);
  const yDocReady = useYjsSeedReady(yDoc);

  // Shared editor state + handlers. Same hook the list view calls so
  // the detail rail offers the full editing surface (transcript
  // override, timing, choice text, retargets, divert) without
  // duplicating any of the cross-tab plumbing.
  const editor = useNodeEditor({ projectId, storyGraph, onStoryUpdated, yDoc });
  // Compute layout once per storyGraph reference. The build is cheap
  // (≤O(n) dagre layout) but expensive enough that we don't want to
  // redo it on every pan/zoom.
  // Layout direction. TB (top→bottom) is the canonical Ink reading
  // order; LR (left→right) reads more comfortably for long flat
  // stories with a small branching factor. The toggle re-runs dagre.
  const [rankdir, setRankdir] = useState<'TB' | 'LR'>('TB');
  // Bumped by the "Reset layout" button to force a re-seed even when
  // structure is unchanged (otherwise dragged positions stick).
  const [layoutNonce, setLayoutNonce] = useState(0);

  const { nodes: initialNodes, edges: initialEdges } = useMemo(() => {
    if (!storyGraph) return { nodes: [], edges: [] };
    return buildLayout(storyGraph, rankdir);
    // layoutNonce is intentionally a dep — its only purpose is to
    // re-run dagre on demand. eslint sees it as unused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyGraph, rankdir, layoutNonce]);

  // Reachable set + #ending set, used to overlay dim / on-path
  // styling without re-running dagre.
  const reachable = useMemo(
    () => (storyGraph ? computeReachable(storyGraph) : new Set<string>()),
    [storyGraph],
  );

  // Pre-computed set of real node ids — used in the overlay effect
  // to decide whether an edge target is synthetic (END / DONE / a
  // "missing" placeholder). Captured as a memo keyed on storyGraph
  // so the effect doesn't need storyGraph in its dep array directly.
  const realNodeIds = useMemo(
    () => new Set(storyGraph ? Object.keys(storyGraph.nodes) : []),
    [storyGraph],
  );

  // React Flow expects controlled nodes/edges to support interactivity
  // (selection, dragging). Re-seed only when the *structural* set of
  // node IDs / edge IDs changes — pure layout-position recomputes from
  // the same story shouldn't destroy user-dragged positions. We track
  // the last seeded fingerprint in a ref and merge new dagre positions
  // into the existing node list, preserving any node the user has
  // moved.
  const [nodes, setNodes] = useState<RFNode[]>(initialNodes);
  const [edges, setEdges] = useState<RFEdge[]>(initialEdges);
  const draggedNodeIdsRef = useRef<Set<string>>(new Set());
  const lastFingerprintRef = useRef<string>('');
  useEffect(() => {
    const fingerprint =
      `${rankdir}#${layoutNonce}#` +
      initialNodes
        .map((n) => n.id)
        .sort()
        .join('|') +
      '#' +
      initialEdges
        .map((e) => e.id)
        .sort()
        .join('|');
    if (fingerprint !== lastFingerprintRef.current) {
      // Structural change — accept the new layout wholesale.
      lastFingerprintRef.current = fingerprint;
      draggedNodeIdsRef.current = new Set();
      setNodes(initialNodes);
      setEdges(initialEdges);
      return;
    }
    // Same set of nodes/edges — refresh data/style from buildLayout but
    // keep dragged positions. This is what runs when the user edits a
    // choice label and the parent refetches storyGraph: dagre re-runs
    // but we don't want their manual arrangement to vanish.
    const dragged = draggedNodeIdsRef.current;
    setNodes((current) => {
      const currentById = new Map(current.map((n) => [n.id, n]));
      return initialNodes.map((next) => {
        const existing = currentById.get(next.id);
        if (existing && dragged.has(next.id)) {
          return { ...next, position: existing.position };
        }
        return next;
      });
    });
    setEdges(initialEdges);
  }, [initialNodes, initialEdges]);

  // Selected node detail. `selectedNodeId` is null when no rail/sheet
  // is shown; on desktop the rail renders alongside the graph, on
  // mobile a bottom sheet overlays.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Slide-in panel that hosts the raw Ink source editor. Same
  // component the StoryTab uses inline so authors get the same
  // surface from either tab and saves go through one path.
  const [sourceOpen, setSourceOpen] = useState(false);
  const handleSaveInkSource = useCallback(
    async (next: string) => {
      await uploadInk(projectId, next);
      // Sequence the refetch before bumping resetKey to avoid the
      // stale-seed flash (see StoryTab.handleFileUpload).
      await onStoryUpdated();
      onSourceReplaced();
    },
    [projectId, onStoryUpdated, onSourceReplaced],
  );
  const rf = useReactFlow();

  // Search query. Filters affect the node card visuals (matched /
  // unmatched) and the path-trace bar offers a "jump to match" affordance.
  const [search, setSearch] = useState('');
  const matchedIds = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const ids = new Set<string>();
    if (!storyGraph) return ids;
    for (const [id, node] of Object.entries(storyGraph.nodes)) {
      if (id.toLowerCase().includes(q)) {
        ids.add(id);
        continue;
      }
      const text =
        node.content
          ?.map((c) => c.text)
          .join(' ')
          .toLowerCase() ?? '';
      if (text.includes(q)) ids.add(id);
    }
    return ids;
  }, [search, storyGraph]);

  // Path tracing — pick two nodes and see how a listener could route
  // between them. First click sets `pathFromId`; the next sets
  // `pathToId`; a third click resets and starts over. Clearing the
  // search clears the trace too (so the panel feels uncluttered).
  const [pathFromId, setPathFromId] = useState<string | null>(null);
  const [pathToId, setPathToId] = useState<string | null>(null);
  const pathTrace = useMemo(() => {
    if (!storyGraph || !pathFromId || !pathToId) return null;
    return shortestPath(storyGraph, pathFromId, pathToId);
  }, [storyGraph, pathFromId, pathToId]);

  // Current zoom level — drives whether edge labels render. Below
  // ~0.75 the labels overlap into illegibility on large graphs
  // (a real project we tested had ~200 edges); hide them and let
  // the user lean on the in-card choice rows instead.
  const [zoom, setZoom] = useState(1);
  const showEdgeLabels = zoom >= 0.75;

  // Hover card — a richer preview than the browser's native title=.
  // Position updates are rAF-throttled so a fast mouse drag doesn't
  // re-render GraphTabInner on every pointer pixel (mousemove fires
  // at native pointer frequency). The throttle stores the LATEST
  // coords in a ref so the queued frame reads fresh values, not the
  // first call's snapshot.
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const latestHoverPosRef = useRef<{ x: number; y: number } | null>(null);
  const cancelHoverRaf = useCallback(() => {
    if (hoverRafRef.current !== null) {
      cancelAnimationFrame(hoverRafRef.current);
      hoverRafRef.current = null;
    }
    latestHoverPosRef.current = null;
  }, []);
  const queueHoverPos = useCallback((x: number, y: number) => {
    latestHoverPosRef.current = { x, y };
    if (hoverRafRef.current !== null) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = null;
      const next = latestHoverPosRef.current;
      if (next) setHoverPos(next);
    });
  }, []);
  useEffect(() => cancelHoverRaf, [cancelHoverRaf]);

  // Toggleable dim-unreachable overlay. Off by default to avoid the
  // initial impression of "lots of broken stuff" — the StoryHealthPanel
  // already surfaces the unreachable count.
  const [dimUnreachable, setDimUnreachable] = useState(false);

  // Apply overlay flags (dim, onPath, matched/unmatched) to the
  // rendered nodes via shallow-update on the data object. We don't
  // re-run dagre for these — they're purely cosmetic.
  useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        if (n.type !== 'storyCard') return n;
        const id = n.id;
        const data = n.data as unknown as StoryCardData;
        const dim = dimUnreachable && !reachable.has(id) && !data.isStart;
        const onPath = !!pathTrace && pathTrace.nodes.has(id);
        const matched = !!matchedIds && matchedIds.has(id);
        const unmatched = !!matchedIds && !matchedIds.has(id);
        if (
          data.dim === dim &&
          data.onPath === onPath &&
          data.matched === matched &&
          data.unmatched === unmatched
        ) {
          return n;
        }
        return { ...n, data: { ...data, dim, onPath, matched, unmatched } };
      }),
    );
    setEdges((current) =>
      current.map((e) => {
        const data = (e.data ?? {}) as { sourceNodeId?: string };
        const sourceId = data.sourceNodeId ?? e.source;
        const targetId = e.target;
        // Only edges that participate in the SHORTEST route get the
        // on-path treatment — having both endpoints in the node set
        // isn't enough (a sibling choice that points forward to a
        // later on-path node would otherwise wrongly light up).
        const onPath = !!pathTrace && pathTrace.edgePairs.has(`${sourceId}->${targetId}`);
        // Edges to synthetic targets (END/DONE terminals + "missing"
        // placeholders) aren't in the storyGraph.nodes map, so they
        // can't be in the reachable set. Only dim them when the
        // SOURCE is unreachable — otherwise a healthy edge from a
        // reachable knot to END always looks faded once the toggle
        // is on, which is the opposite of the toggle's intent.
        const targetIsSynthetic = !realNodeIds.has(targetId);
        const dim =
          dimUnreachable &&
          (!reachable.has(sourceId) || (!targetIsSynthetic && !reachable.has(targetId)));
        const className = [onPath ? 'graph-edge-on-path' : '', dim ? 'graph-edge-dim' : '']
          .filter(Boolean)
          .join(' ');
        // Bail out when nothing visual changed — avoids creating a
        // fresh edges array on every keystroke (ReactFlow would
        // otherwise re-process every edge).
        if ((e.className ?? '') === className) return e;
        return { ...e, className };
      }),
    );
  }, [pathTrace, matchedIds, dimUnreachable, reachable, realNodeIds]);

  // Initial framing: center on the start node at 1.0× rather than
  // fitView-shrink-everything. For huge graphs (a real project we
  // tested had 168 nodes) fitView reduces the zoom to the point
  // that labels are unreadable; the start node + neighbors is a
  // better landing.
  const didFrameRef = useRef(false);
  useEffect(() => {
    if (didFrameRef.current) return;
    if (!storyGraph || nodes.length === 0) return;
    const startNode = nodes.find((n) => n.id === storyGraph.startNode);
    if (startNode) {
      // Center on the start node. Use a sane default zoom (1.0); user
      // can scroll out if they want the bird's-eye view.
      rf.setCenter(
        startNode.position.x + NODE_WIDTH / 2,
        startNode.position.y + nodeHeightOf(startNode) / 2,
        { zoom: 1, duration: 0 },
      );
      didFrameRef.current = true;
    }
  }, [storyGraph, nodes, rf]);

  // Re-frame when the user changes layout direction or hits Reset
  // layout — otherwise the nodes snap to fresh dagre positions but
  // the viewport stays on its previous coordinates, leaving the user
  // staring at empty canvas while their graph rearranged elsewhere.
  useEffect(() => {
    if (!storyGraph || nodes.length === 0) return;
    const startNode = nodes.find((n) => n.id === storyGraph.startNode);
    if (!startNode) return;
    rf.setCenter(
      startNode.position.x + NODE_WIDTH / 2,
      startNode.position.y + nodeHeightOf(startNode) / 2,
      { zoom: 1, duration: 400 },
    );
    // Intentionally NOT depending on `nodes` — that changes on every
    // drag and would re-center on each move. We re-frame only on
    // rankdir/layoutNonce changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rankdir, layoutNonce]);

  // Transient banner for a failed retarget. The drag gesture itself
  // produces no DOM change (we don't optimistically update edges)
  // so without a banner the user has no signal that anything broke.
  const [retargetError, setRetargetError] = useState<string | null>(null);

  // Drag-from-choice-handle to target → re-target. Called when the
  // user drops a connection onto a different node. We parse the
  // sourceHandle id (set in buildLayout) to find which choice or
  // divert is being re-pointed, hit the API, and let the parent
  // refetch the storyGraph so dagre re-runs.
  const applyRetarget = useCallback(
    async (sourceNodeId: string, sourceHandle: string | null | undefined, newTarget: string) => {
      if (!sourceHandle) return;
      try {
        if (sourceHandle === 'divert') {
          await updateDivert(projectId, sourceNodeId, newTarget);
        } else if (sourceHandle.startsWith('choice-')) {
          const idx = Number.parseInt(sourceHandle.slice('choice-'.length), 10);
          if (!Number.isFinite(idx) || idx < 0) return;
          await updateChoiceTarget(projectId, sourceNodeId, idx, newTarget);
        } else {
          return;
        }
        setRetargetError(null);
        onStoryUpdated();
      } catch (err) {
        setRetargetError(err instanceof Error ? err.message : 'Failed to re-target. Try again.');
      }
    },
    [projectId, onStoryUpdated],
  );

  // Shared gate for both gestures: ignore drops with missing endpoints
  // and self-loops. Self-loops on a single node aren't a thing in Ink's
  // flow model (a knot can't divert to itself meaningfully), and the
  // gesture is more often a misdrop than an intentional edit.
  const tryRetargetConnection = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      void applyRetarget(connection.source, connection.sourceHandle, connection.target);
    },
    [applyRetarget],
  );

  const onConnect = useCallback(tryRetargetConnection, [tryRetargetConnection]);

  // Reconnect: built-in ReactFlow gesture (drag the END of an existing
  // edge onto a different target node). Same code path as onConnect.
  const onReconnect = useCallback(
    (_oldEdge: RFEdge, newConnection: Connection) => tryRetargetConnection(newConnection),
    [tryRetargetConnection],
  );

  // Cursor through the matched set so repeated clicks cycle to the
  // next match instead of always recentering on the first.
  const [matchCursor, setMatchCursor] = useState(0);
  useEffect(() => {
    setMatchCursor(0);
  }, [matchedIds]);
  const jumpToNextMatch = useCallback(() => {
    if (!matchedIds || matchedIds.size === 0) return;
    const order = Array.from(matchedIds);
    const idx = matchCursor % order.length;
    const targetId = order[idx];
    const target = nodes.find((n) => n.id === targetId);
    if (target) {
      rf.setCenter(
        target.position.x + NODE_WIDTH / 2,
        target.position.y + nodeHeightOf(target) / 2,
        { zoom: 1, duration: 300 },
      );
      setSelectedNodeId(targetId);
    }
    setMatchCursor((c) => c + 1);
  }, [matchedIds, matchCursor, nodes, rf]);

  if (!storyGraph) {
    return (
      <div className="tab-panel">
        <div className="section-header">
          <h2>Graph</h2>
        </div>
        <div className="empty-state">
          <p>Upload a story file to see its node graph.</p>
        </div>
      </div>
    );
  }

  const selected = selectedNodeId ? storyGraph.nodes[selectedNodeId] : null;
  const hoverNode = hoverNodeId ? storyGraph.nodes[hoverNodeId] : null;

  // Click semantics:
  //  - shift-click sets path endpoints (1st → from, 2nd → to)
  //  - plain click opens the detail rail
  const handleNodeClick = (event: React.MouseEvent, node: RFNode) => {
    if (!storyGraph.nodes[node.id]) return;
    if (event.shiftKey) {
      if (!pathFromId || (pathFromId && pathToId)) {
        setPathFromId(node.id);
        setPathToId(null);
      } else if (node.id !== pathFromId) {
        setPathToId(node.id);
      }
      return;
    }
    // Opening the detail rail evicts the source panel — they
    // occupy the same right-side region of the canvas.
    setSourceOpen(false);
    setSelectedNodeId(node.id);
  };

  return (
    <div className="tab-panel graph-tab">
      <div className="section-header">
        <h2>Graph</h2>
        <p className="text-muted text-sm">
          Click a node for details. Shift-click two nodes to trace a path. Drag a choice handle
          (right side of a card) onto another node to re-target it.
        </p>
      </div>
      <div className="graph-toolbar">
        <div className="graph-toolbar-search">
          <input
            type="search"
            value={search}
            onChange={(e) => {
              const next = e.target.value;
              setSearch(next);
              // Clear the path-trace too when the user wipes the
              // search box; the toolbar feels less cluttered after a
              // "go back to a clean view" gesture.
              if (!next.trim()) {
                setPathFromId(null);
                setPathToId(null);
              }
            }}
            placeholder="Search nodes by id or content…"
            aria-label="Search graph"
            data-testid="graph-search"
            className="graph-search-input"
          />
          {matchedIds && matchedIds.size > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={jumpToNextMatch}
              data-testid="graph-search-jump"
            >
              {matchedIds.size === 1
                ? 'Jump to match'
                : `Next match (${(matchCursor % matchedIds.size) + 1}/${matchedIds.size})`}
            </button>
          )}
        </div>
        <label className="graph-toolbar-toggle">
          <input
            type="checkbox"
            checked={dimUnreachable}
            onChange={(e) => setDimUnreachable(e.target.checked)}
            data-testid="graph-dim-toggle"
          />
          Dim unreachable
        </label>
        <div className="graph-toolbar-segmented" role="group" aria-label="Layout direction">
          <button
            type="button"
            className={rankdir === 'TB' ? 'is-active' : ''}
            onClick={() => setRankdir('TB')}
            aria-pressed={rankdir === 'TB'}
            title="Top → bottom"
            data-testid="graph-rankdir-tb"
          >
            ↓ TB
          </button>
          <button
            type="button"
            className={rankdir === 'LR' ? 'is-active' : ''}
            onClick={() => setRankdir('LR')}
            aria-pressed={rankdir === 'LR'}
            title="Left → right"
            data-testid="graph-rankdir-lr"
          >
            → LR
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setLayoutNonce((n) => n + 1)}
          data-testid="graph-reset-layout"
          title="Discard manual drag positions and re-run auto-layout"
        >
          Reset layout
        </button>
        <button
          type="button"
          className={`btn btn-sm ${sourceOpen ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => {
            setSourceOpen((v) => {
              const next = !v;
              // Mutually exclusive with the node detail rail —
              // their right-side regions overlap and showing both
              // at once hides the detail behind the source panel.
              if (next) setSelectedNodeId(null);
              return next;
            });
          }}
          data-testid="graph-source-toggle"
          title="Edit the raw Ink source"
          aria-pressed={sourceOpen}
        >
          {sourceOpen ? '✕ Source' : 'Edit source'}
        </button>
        {(pathFromId || pathToId) && (
          <div className="graph-toolbar-path">
            <span className="text-sm">
              Path: <strong>{pathFromId ?? '…'}</strong>
              {' → '}
              <strong>{pathToId ?? '…'}</strong>
              {pathFromId && pathToId && !pathTrace && (
                <span className="text-muted"> (no route)</span>
              )}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setPathFromId(null);
                setPathToId(null);
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>
      <div className="graph-layout">
        <div className="graph-frame" data-testid="story-graph">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={(changes: NodeChange[]) => {
              for (const c of changes) {
                if (c.type === 'position' && c.position && 'id' in c) {
                  draggedNodeIdsRef.current.add(c.id);
                }
              }
              setNodes((ns) => applyNodeChanges(changes, ns));
            }}
            onEdgesChange={(changes: EdgeChange[]) => {
              setEdges((es) => applyEdgeChanges(changes, es));
            }}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onNodeClick={handleNodeClick}
            onNodeMouseEnter={(event, node) => {
              if (!storyGraph.nodes[node.id]) return;
              // Cancel any pending rAF queued by a previous node's
              // mouseMove — otherwise a fast A→B sweep can land the
              // queued frame after enter and render B's preview at
              // A's coordinates.
              cancelHoverRaf();
              setHoverNodeId(node.id);
              setHoverPos({ x: event.clientX, y: event.clientY });
            }}
            onNodeMouseMove={(event, node) => {
              // Track the cursor while still inside the node so the
              // preview floats with the pointer instead of pinning
              // to the entry point. rAF-throttled to one update per
              // paint frame so we don't re-render hundreds of times
              // a second on fast mouse moves.
              if (!storyGraph.nodes[node.id]) return;
              queueHoverPos(event.clientX, event.clientY);
            }}
            onNodeMouseLeave={() => {
              cancelHoverRaf();
              setHoverNodeId(null);
              setHoverPos(null);
            }}
            fitView={false}
            minZoom={0.4}
            maxZoom={2}
            onMove={(_e, viewport) => setZoom(viewport.zoom)}
            proOptions={{ hideAttribution: true }}
            className={`graph-canvas${showEdgeLabels ? '' : ' is-zoomed-out'}`}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#e2e8f0" />
            <Controls showInteractive={false} className="graph-controls" />
            <MiniMap pannable zoomable className="graph-minimap" />
          </ReactFlow>
          {hoverNode && hoverPos && <HoverPreview node={hoverNode} x={hoverPos.x} y={hoverPos.y} />}
          {retargetError && (
            <div className="graph-retarget-error" role="status" data-testid="graph-retarget-error">
              <span>{retargetError}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setRetargetError(null)}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}
        </div>
        {selected && selectedNodeId && (
          <aside className="graph-detail" aria-label="Node detail">
            <div className="graph-detail-header">
              <div>
                <h3 className="graph-detail-title">{selectedNodeId}</h3>
                <span className="text-muted text-sm">{selected.type}</span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSelectedNodeId(null)}
                aria-label="Close detail"
              >
                ✕
              </button>
            </div>
            {editor.editorError && (
              <div className="alert alert-error" role="alert">
                {editor.editorError}
              </div>
            )}
            {editor.metadataError && (
              <div className="alert alert-warning" role="alert">
                {editor.metadataError}{' '}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={editor.retryMetadata}
                >
                  Retry
                </button>
              </div>
            )}
            <NodeDetail
              key={selectedNodeId}
              nodeId={selectedNodeId}
              node={selected}
              metadata={editor.metadata[selectedNodeId]}
              metadataLoaded={editor.metadataLoaded}
              nodeIdSet={editor.nodeIdSet}
              nodeIdOptions={editor.nodeIdOptions}
              onChoiceTextEdit={(ci, text) => editor.handleChoiceTextEdit(selectedNodeId, ci, text)}
              onContentEdit={(ci, text) => editor.handleNodeContentEdit(selectedNodeId, ci, text)}
              onChoiceTargetEdit={(ci, target) =>
                editor.handleChoiceTargetEdit(selectedNodeId, ci, target)
              }
              onDivertEdit={(target) => editor.handleDivertEdit(selectedNodeId, target)}
              onAddChoice={(choice) => editor.handleAddChoice(selectedNodeId, choice)}
              onDeleteChoice={(ci) => editor.handleDeleteChoice(selectedNodeId, ci)}
              onSwapChoices={(from, to) => editor.handleSwapChoices(selectedNodeId, from, to)}
              onMetadataSave={(patch) => editor.handleMetadataSave(selectedNodeId, patch)}
              reachableFrom={editor.reverseEdges.get(selectedNodeId)}
              onJumpToNode={(id) => {
                setSelectedNodeId(id);
                const target = nodes.find((n) => n.id === id);
                if (target) {
                  rf.setCenter(
                    target.position.x + NODE_WIDTH / 2,
                    target.position.y + nodeHeightOf(target) / 2,
                    { zoom: 1, duration: 300 },
                  );
                }
              }}
              yDoc={yDoc}
              yDocReady={yDocReady}
            />
          </aside>
        )}
      </div>
      {sourceOpen && (
        <aside className="graph-source-panel" aria-label="Ink source editor">
          <InkSourceEditor
            initialSource={inkSource ?? ''}
            onSave={handleSaveInkSource}
            onClose={() => setSourceOpen(false)}
            resetKey={`${projectId}#${sourceResetKey}`}
          />
        </aside>
      )}
    </div>
  );
}

// Floating preview card that follows the cursor when hovering a node.
// Replaces the browser's native title= tooltip with something we can
// style: knot id, type chip, content snippet, and a tag list.
interface HoverPreviewProps {
  node: StoryNode;
  x: number;
  y: number;
}
function HoverPreview({ node, x, y }: HoverPreviewProps) {
  const contentText = node.content?.map((c) => c.text).join(' ') ?? '';
  const preview =
    contentText.length > 220 ? `${contentText.slice(0, 220).trim()}…` : contentText || '(empty)';
  return (
    <div className="graph-hover-card" style={{ left: x + 14, top: y + 14 }} role="tooltip">
      <div className="graph-hover-card-header">
        <span className="graph-node-chip" data-kind={node.type}>
          {node.type}
        </span>
        <strong className="graph-hover-card-title">{node.id}</strong>
      </div>
      <p className="graph-hover-card-body">{preview}</p>
      {node.tags && node.tags.length > 0 && (
        <div className="graph-hover-card-tags">
          {node.tags.slice(0, 6).map((t) => (
            <span key={t} className="badge badge-gray">
              #{t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
