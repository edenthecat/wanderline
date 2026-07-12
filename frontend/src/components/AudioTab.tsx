import { Fragment, useEffect, useState, useMemo, useRef, type ChangeEvent } from 'react';
import {
  fetchAudioFiles,
  uploadAudioFile,
  deleteAudioFile,
  fetchAudioAssignments,
  assignAudio,
  removeAudioAssignment,
  bulkReassignAudio,
  fetchAudioCoverage,
  bulkUploadAudio,
  rematchUnassignedAudio,
  type AudioFile,
  type AudioAssignments,
  type AudioCoverage,
  type BulkReassignOp,
  type BulkUploadResult,
  type StoryGraph,
} from '../api/client';
import OrphanedAudioPanel from './OrphanedAudioPanel';
import { useYjs } from '../hooks/useYjs';
import { bumpLiveSignal, useLiveSignal } from '../hooks/useLiveSignal';
import { useAudition } from '../hooks/useAudition';

const AUDIO_ASSIGNMENTS_SIGNAL = 'audio-assignments';

const CATEGORIES = ['voiceover', 'choice', 'indicator', 'ambience', 'sfx', 'music'] as const;
const AUDIO_TYPES = ['voiceover', 'choice1', 'choice2', 'ambience', 'sfx'] as const;
type AudioType = (typeof AUDIO_TYPES)[number];
type FilterMode = 'all' | 'assigned' | 'unassigned';

interface Props {
  projectId: string;
  storyGraph: StoryGraph | null;
}

export default function AudioTab({ projectId, storyGraph }: Props) {
  const { doc: yDoc } = useYjs(projectId);
  const audioSignalTick = useLiveSignal(yDoc, AUDIO_ASSIGNMENTS_SIGNAL);
  const { playingId, toggle: toggleAudition, stop: stopAudition } = useAudition();

  const [audioFiles, setAudioFiles] = useState<AudioFile[]>([]);
  const [assignments, setAssignments] = useState<AudioAssignments>({});
  const [coverage, setCoverage] = useState<AudioCoverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Upload state
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState<string>('voiceover');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkInputRef = useRef<HTMLInputElement>(null);
  const [bulkResult, setBulkResult] = useState<BulkUploadResult | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [rematching, setRematching] = useState(false);

  // Assignment state
  const [assignNodeId, setAssignNodeId] = useState<string>('');
  const [assignAudioType, setAssignAudioType] = useState<AudioType>('voiceover');
  const [assignFileId, setAssignFileId] = useState<string>('');
  const [assigning, setAssigning] = useState(false);

  // Filter state
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  // Build set of assigned file IDs for filtering (memoized to avoid recalc on UI-only state changes)
  const assignedFileIds = useMemo(() => {
    const ids = new Set<string>();
    for (const nodeAssigns of Object.values(assignments)) {
      if (nodeAssigns.voiceover) ids.add(nodeAssigns.voiceover);
      if (nodeAssigns.ambience) ids.add(nodeAssigns.ambience);
      if (nodeAssigns.choice1) ids.add(nodeAssigns.choice1);
      if (nodeAssigns.choice2) ids.add(nodeAssigns.choice2);
      for (const sfxId of nodeAssigns.sfx) ids.add(sfxId);
    }
    return ids;
  }, [assignments]);

  // Reverse index: every (nodeId, audioType) where each fileId is
  // currently assigned. Drives the per-row "Used in" expander +
  // "Swap this file everywhere" action below — without it the only
  // way to redirect a file's assignments was to remember the slots
  // manually, then DELETE + POST each one. The 'sfx' slot is
  // multi-valued so the same file may appear twice on a node.
  const usagesByFileId = useMemo(() => {
    const map = new Map<string, Array<{ nodeId: string; audioType: AudioType }>>();
    const push = (fileId: string, nodeId: string, audioType: AudioType) => {
      const list = map.get(fileId);
      if (list) list.push({ nodeId, audioType });
      else map.set(fileId, [{ nodeId, audioType }]);
    };
    for (const [nodeId, a] of Object.entries(assignments)) {
      if (a.voiceover) push(a.voiceover, nodeId, 'voiceover');
      if (a.ambience) push(a.ambience, nodeId, 'ambience');
      if (a.choice1) push(a.choice1, nodeId, 'choice1');
      if (a.choice2) push(a.choice2, nodeId, 'choice2');
      for (const sfxId of a.sfx) push(sfxId, nodeId, 'sfx');
    }
    // Sort each list for stable rendering across refetches.
    for (const list of map.values()) {
      list.sort((x, y) =>
        x.nodeId === y.nodeId
          ? x.audioType.localeCompare(y.audioType)
          : x.nodeId.localeCompare(y.nodeId),
      );
    }
    return map;
  }, [assignments]);

  // Per-file row expander + the in-flight target for the
  // "Swap everywhere" action. Both keyed by fileId.
  const [expandedFileId, setExpandedFileId] = useState<string | null>(null);
  const [swapTargetByFileId, setSwapTargetByFileId] = useState<Record<string, string>>({});
  const [swappingFileId, setSwappingFileId] = useState<string | null>(null);

  const nodeIds = storyGraph ? Object.keys(storyGraph.nodes) : [];

  useEffect(() => {
    // Clear all transient UI state when switching projects
    setSuccessMessage(null);
    setBulkResult(null);
    setError(null);
    setAssignNodeId('');
    setAssignAudioType('voiceover');
    setAssignFileId('');
    setFilterMode('all');
    loadAll(true);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // a peer announced an assignment change. Refetch
  // silently (no loader) so the existing list refreshes in place.
  // We deliberately skip the first run (`audioSignalTick === 0`) so
  // an empty doc on mount doesn't cause a double load.
  const audioSignalRef = useRef(0);
  useEffect(() => {
    if (audioSignalTick === 0) return;
    if (audioSignalTick === audioSignalRef.current) return;
    audioSignalRef.current = audioSignalTick;
    void loadAll(false);
  }, [audioSignalTick]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll(showLoader = false) {
    if (showLoader) setLoading(true);
    try {
      const [filesRes, assignRes, coverageRes] = await Promise.all([
        fetchAudioFiles(projectId),
        fetchAudioAssignments(projectId),
        fetchAudioCoverage(projectId),
      ]);
      setAudioFiles(filesRes.audioFiles);
      setAssignments(assignRes.assignments);
      setCoverage(coverageRes);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audio data');
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await uploadAudioFile(projectId, file, category);
      await loadAll();
      setSuccessMessage('File uploaded successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleBulkUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    setError(null);
    setSuccessMessage(null);
    setBulkResult(null);
    setBulkProgress(null);

    try {
      const result = await bulkUploadAudio(
        projectId,
        Array.from(files),
        category,
        undefined,
        (done, total) => setBulkProgress({ done, total }),
      );
      setBulkResult(result);
      await loadAll();
      setSuccessMessage(
        `Bulk upload complete: ${result.totalUploaded} uploaded, ${result.totalMatched} auto-matched, ${result.totalUnmatched} unmatched.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk upload failed');
    } finally {
      setUploading(false);
      setBulkProgress(null);
      if (bulkInputRef.current) bulkInputRef.current.value = '';
    }
  }

  // Re-run the auto-matcher against existing unassigned files. The
  // matcher has gotten smarter over time (DAW-prefix / version-suffix
  // stripping, etc.), so files that originally landed in the
  // unmatched pile may now have a target. This is a no-cost retry —
  // already-assigned files are skipped, and unmatched files just
  // stay unmatched.
  async function handleRematch() {
    setRematching(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const result = await rematchUnassignedAudio(projectId);
      await loadAll();
      setSuccessMessage(
        `Re-match complete: ${result.totalMatched} newly matched, ${result.totalUnmatched} still unmatched, ${result.alreadyAssigned} already assigned.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Re-match failed');
    } finally {
      setRematching(false);
    }
  }

  async function handleDelete(audioId: string) {
    if (!confirm('Delete this audio file?')) return;
    // Stop the inline preview if this is the file currently playing —
    // otherwise loadAll() removes the row (and its Stop button) while
    // the audio keeps playing with no visible way to stop it.
    if (playingId === audioId) stopAudition();
    try {
      await deleteAudioFile(projectId, audioId);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  // Skip the per-file confirm() prompt — the OrphanedAudioPanel owns
  // its own confirmation flow for the bulk case, and the per-row Delete
  // there is explicitly scoped to "files you've already classified as
  // orphans", so a second native modal each click is just friction.
  async function handleOrphanDelete(audioId: string) {
    if (playingId === audioId) stopAudition();
    try {
      await deleteAudioFile(projectId, audioId);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      throw err;
    }
  }

  // Bulk variant: skip the per-file loadAll so OrphanedAudioPanel can
  // delete N files in N HTTP calls instead of N + (N × ~3 coverage GETs).
  async function handleOrphanDeleteSilent(audioId: string) {
    try {
      await deleteAudioFile(projectId, audioId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      throw err;
    }
  }

  async function handleAssign() {
    if (!assignNodeId || !assignFileId) return;
    setAssigning(true);
    setError(null);
    setSuccessMessage(null);

    try {
      await assignAudio(projectId, assignNodeId, assignAudioType, assignFileId);
      await loadAll();
      // broadcast to peers so other open tabs
      // refresh their coverage + assignment lists without waiting
      // for a manual reload. Done after loadAll so the local view
      // is consistent before we tell peers to refresh.
      bumpLiveSignal(yDoc, AUDIO_ASSIGNMENTS_SIGNAL);
      setAssignFileId('');
      setSuccessMessage(`Audio assigned to ${assignNodeId} as ${assignAudioType}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assignment failed');
    } finally {
      setAssigning(false);
    }
  }

  async function handleRemoveAssignment(nodeId: string, audioType: string, audioFileId?: string) {
    if (!confirm(`Remove ${audioType} assignment from ${nodeId}?`)) return;
    setError(null);
    setSuccessMessage(null);

    try {
      await removeAudioAssignment(projectId, nodeId, audioType, audioFileId);
      await loadAll();
      bumpLiveSignal(yDoc, AUDIO_ASSIGNMENTS_SIGNAL);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove assignment');
    }
  }

  // Per-row "Replace with…" target. Kept in state so the select is
  // controlled (the previous uncontrolled `e.target.value = ''` reset
  // raced the success/failure handler and silently swallowed errors).
  const [replaceTargetByUsage, setReplaceTargetByUsage] = useState<Record<string, string>>({});
  const usageKey = (nodeId: string, audioType: AudioType) => `${nodeId}#${audioType}`;

  // Apply a batch of (from → to) swaps atomically on the backend. Used
  // by both the "Replace this one" per-row dropdown and the "Swap
  // everywhere" header action. Single transaction on the server so a
  // half-applied swap can't leave the player in a worse state.
  async function handleBulkReassign(ops: BulkReassignOp[], fileIdForUI: string) {
    if (ops.length === 0) return;
    setSwappingFileId(fileIdForUI);
    setError(null);
    setSuccessMessage(null);
    try {
      const { swapped } = await bulkReassignAudio(projectId, ops);
      await loadAll();
      bumpLiveSignal(yDoc, AUDIO_ASSIGNMENTS_SIGNAL);
      setSuccessMessage(
        swapped === 1 ? 'Replaced 1 assignment.' : `Replaced ${swapped} assignments.`,
      );
      // After a successful swap the source file may have zero usages
      // left. Collapse its row so the now-empty expander state can't
      // surprise the user by reopening if the file gets re-assigned
      // later. Clear the swap-target state on the same key so a
      // stale id doesn't sit there pointing at a now-irrelevant file.
      if (expandedFileId === fileIdForUI) setExpandedFileId(null);
      setSwapTargetByFileId((prev) => {
        if (!(fileIdForUI in prev)) return prev;
        const next = { ...prev };
        delete next[fileIdForUI];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to swap assignments');
    } finally {
      setSwappingFileId(null);
    }
  }

  async function handleSwapEverywhere(fromFileId: string) {
    const toFileId = swapTargetByFileId[fromFileId];
    if (!toFileId || toFileId === fromFileId) return;
    const usages = usagesByFileId.get(fromFileId) ?? [];
    if (usages.length === 0) return;
    const ops: BulkReassignOp[] = usages.map((u) => ({
      nodeId: u.nodeId,
      audioType: u.audioType,
      fromFileId,
      toFileId,
    }));
    await handleBulkReassign(ops, fromFileId);
    setSwapTargetByFileId((prev) => {
      const next = { ...prev };
      delete next[fromFileId];
      return next;
    });
  }

  async function handleReplaceOne(
    fromFileId: string,
    nodeId: string,
    audioType: AudioType,
    toFileId: string,
  ) {
    if (!toFileId || toFileId === fromFileId) return;
    await handleBulkReassign([{ nodeId, audioType, fromFileId, toFileId }], fromFileId);
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const fileNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of audioFiles) map.set(f.id, f.original_name);
    return map;
  }, [audioFiles]);

  function getFileName(fileId: string): string {
    return fileNameMap.get(fileId) ?? fileId;
  }

  function getFilteredFiles(): AudioFile[] {
    switch (filterMode) {
      case 'assigned':
        return audioFiles.filter((f) => assignedFileIds.has(f.id));
      case 'unassigned':
        return audioFiles.filter((f) => !assignedFileIds.has(f.id));
      default:
        return audioFiles;
    }
  }

  if (loading) return <div className="page-loader">Loading audio files...</div>;

  const filteredFiles = getFilteredFiles();
  const grouped = CATEGORIES.reduce(
    (acc, cat) => {
      acc[cat] = filteredFiles.filter((f) => f.category === cat);
      return acc;
    },
    {} as Record<string, AudioFile[]>,
  );

  const nodesWithAssignments = Object.entries(assignments).filter(
    ([, a]) => a.voiceover || a.ambience || a.choice1 || a.choice2 || a.sfx.length > 0,
  );

  return (
    <div className="tab-panel">
      {/* Coverage Stats */}
      {coverage && coverage.coverage.total > 0 && (
        <div className="stats-row">
          <div className="stat">
            <span className="stat-value">{coverage.coverage.percentage}%</span>
            <span className="stat-label">Coverage</span>
          </div>
          <div className="stat">
            <span className="stat-value">{coverage.coverage.withAudio}</span>
            <span className="stat-label">Nodes with voiceover</span>
          </div>
          <div className="stat">
            <span className="stat-value">
              {coverage.coverage.total - coverage.coverage.withAudio}
            </span>
            <span className="stat-label">Nodes missing voiceover</span>
          </div>
          <div className="stat">
            <span className="stat-value">{coverage.orphanedAudioFiles.length}</span>
            <span className="stat-label">Orphaned files</span>
          </div>
          <div className="stat">
            <span className="stat-value">{audioFiles.length}</span>
            <span className="stat-label">Total files</span>
          </div>
        </div>
      )}

      {coverage && (
        <OrphanedAudioPanel
          files={coverage.orphanedAudioFiles}
          onDelete={handleOrphanDelete}
          onDeleteSilent={handleOrphanDeleteSilent}
          onBulkComplete={() => loadAll()}
        />
      )}

      {/* Upload Section */}
      <div className="section-header">
        <h2>Audio files</h2>
        <div className="section-actions">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="select"
            aria-label="Audio category for upload"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={handleUpload}
            style={{ display: 'none' }}
          />
          <button
            className="btn btn-ghost"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? 'Uploading...' : 'Upload file'}
          </button>
          <input
            ref={bulkInputRef}
            type="file"
            accept="audio/*"
            multiple
            onChange={handleBulkUpload}
            style={{ display: 'none' }}
          />
          <button
            className="btn btn-primary"
            onClick={() => bulkInputRef.current?.click()}
            disabled={uploading}
            aria-busy={uploading}
          >
            {uploading && bulkProgress
              ? `Uploading ${bulkProgress.done}/${bulkProgress.total}…`
              : uploading
                ? 'Uploading…'
                : 'Bulk upload'}
          </button>
          <button
            className="btn btn-ghost"
            onClick={handleRematch}
            disabled={rematching || uploading || audioFiles.length === 0}
            aria-busy={rematching}
            title="Re-run auto-assignment on files that aren't yet assigned to a node. Useful after fixing a typo in your story or after we improve the matcher."
          >
            {rematching ? 'Re-matching…' : 'Re-match unassigned'}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {successMessage && (
        <div className="alert alert-success" role="status">
          {successMessage}
        </div>
      )}

      {/* Bulk Upload Results */}
      {bulkResult && (
        <div className="card bulk-result">
          <h3 className="bulk-result-title">Bulk upload results</h3>
          <div className="bulk-result-summary">
            <span className="badge badge-blue">{bulkResult.totalUploaded} uploaded</span>
            <span className="badge badge-green">{bulkResult.totalMatched} matched</span>
            {bulkResult.totalUnmatched > 0 && (
              <span className="badge badge-gray">{bulkResult.totalUnmatched} unmatched</span>
            )}
          </div>
          {bulkResult.matched.length > 0 && (
            <div className="bulk-result-section">
              <h4>Auto-matched</h4>
              <ul className="bulk-result-list">
                {bulkResult.matched.map((m) => (
                  <li key={m.audioFileId}>
                    <span className="audio-filename">{m.filename}</span>
                    <span className="text-muted"> → </span>
                    <span className="node-name">{m.nodeId}</span>
                    <span className="badge badge-green">{m.audioType}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {bulkResult.unmatched.length > 0 && (
            <div className="bulk-result-section">
              <h4>Unmatched (assign manually)</h4>
              <ul className="bulk-result-list">
                {bulkResult.unmatched.map((u) => (
                  <li key={u.audioFileId}>
                    <span className="audio-filename">{u.filename}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setBulkResult(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Assignment Form */}
      {storyGraph && nodeIds.length > 0 && audioFiles.length > 0 && (
        <div className="card assign-form">
          <h3 className="assign-form-title">Assign audio to node</h3>
          <div className="assign-form-row">
            <label className="field assign-form-field">
              <span className="field-label">Node</span>
              <select
                className="select"
                value={assignNodeId}
                onChange={(e) => setAssignNodeId(e.target.value)}
              >
                <option value="">Select node...</option>
                {nodeIds.map((nid) => (
                  <option key={nid} value={nid}>
                    {nid}
                  </option>
                ))}
              </select>
            </label>
            <label className="field assign-form-field">
              <span className="field-label">Type</span>
              <select
                className="select"
                value={assignAudioType}
                onChange={(e) => setAssignAudioType(e.target.value as AudioType)}
              >
                {AUDIO_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="field assign-form-field-wide">
              <span className="field-label">Audio file</span>
              <select
                className="select"
                value={assignFileId}
                onChange={(e) => setAssignFileId(e.target.value)}
              >
                <option value="">Select file...</option>
                {audioFiles.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.original_name} ({f.category})
                  </option>
                ))}
              </select>
            </label>
            <div className="assign-form-action">
              <button
                className="btn btn-primary"
                onClick={handleAssign}
                disabled={assigning || !assignNodeId || !assignFileId}
              >
                {assigning ? 'Assigning...' : 'Assign'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Current Assignments */}
      {nodesWithAssignments.length > 0 && (
        <div className="audio-section">
          <h3 className="audio-section-title">
            Node assignments{' '}
            <span className="text-muted">({nodesWithAssignments.length} nodes)</span>
          </h3>
          <div className="table-scroll">
            <table className="table">
              <caption className="sr-only">Audio assignments per story node</caption>
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Type</th>
                  <th>Audio file</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {nodesWithAssignments.map(([nodeId, nodeAssign]) => {
                  const rows: { type: string; fileId: string }[] = [];
                  if (nodeAssign.voiceover)
                    rows.push({ type: 'voiceover', fileId: nodeAssign.voiceover });
                  if (nodeAssign.choice1)
                    rows.push({ type: 'choice1', fileId: nodeAssign.choice1 });
                  if (nodeAssign.choice2)
                    rows.push({ type: 'choice2', fileId: nodeAssign.choice2 });
                  if (nodeAssign.ambience)
                    rows.push({ type: 'ambience', fileId: nodeAssign.ambience });
                  for (const sfxId of nodeAssign.sfx) rows.push({ type: 'sfx', fileId: sfxId });
                  return rows.map((row, idx) => (
                    <tr key={`${nodeId}-${row.type}-${row.fileId}`}>
                      {idx === 0 ? (
                        <td className="node-name" rowSpan={rows.length}>
                          {nodeId}
                        </td>
                      ) : null}
                      <td>
                        <span className="badge badge-blue">{row.type}</span>
                      </td>
                      <td className="audio-filename">{getFileName(row.fileId)}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm btn-danger"
                          onClick={() =>
                            handleRemoveAssignment(
                              nodeId,
                              row.type,
                              row.type === 'sfx' ? row.fileId : undefined,
                            )
                          }
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Filter Controls */}
      {audioFiles.length > 0 && (
        <div className="section-header">
          <h3>File library</h3>
          <div className="section-actions">
            <select
              className="select"
              value={filterMode}
              onChange={(e) => setFilterMode(e.target.value as FilterMode)}
            >
              <option value="all">All files ({audioFiles.length})</option>
              <option value="assigned">
                Assigned ({audioFiles.filter((f) => assignedFileIds.has(f.id)).length})
              </option>
              <option value="unassigned">
                Unassigned ({audioFiles.filter((f) => !assignedFileIds.has(f.id)).length})
              </option>
            </select>
          </div>
        </div>
      )}

      {/* File Library */}
      {audioFiles.length === 0 ? (
        <div className="empty-state">
          <p>No audio files uploaded yet.</p>
          <p className="text-muted">
            Upload MP3, WAV, or OGG files for voiceover, ambience, and effects.
          </p>
        </div>
      ) : filteredFiles.length === 0 ? (
        <div className="empty-state">
          <p>No files match the current filter.</p>
        </div>
      ) : (
        <div className="audio-sections">
          {CATEGORIES.map((cat) => {
            const files = grouped[cat];
            if (files.length === 0) return null;
            return (
              <div key={cat} className="audio-section">
                <h3 className="audio-section-title">
                  {cat} <span className="text-muted">({files.length})</span>
                </h3>
                <div className="table-scroll">
                  <table className="table">
                    <caption className="sr-only">{cat} audio files</caption>
                    <thead>
                      <tr>
                        <th>File</th>
                        <th>Size</th>
                        <th>Status</th>
                        <th>Uploaded</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((f) => {
                        const usages = usagesByFileId.get(f.id) ?? [];
                        const isExpanded = expandedFileId === f.id;
                        const isAssigned = usages.length > 0;
                        const replacementCandidates = audioFiles.filter(
                          (other) => other.id !== f.id,
                        );
                        const swapTarget = swapTargetByFileId[f.id] ?? '';
                        const isSwapping = swappingFileId === f.id;
                        return (
                          <Fragment key={f.id}>
                            <tr>
                              <td className="audio-filename">{f.original_name}</td>
                              <td className="text-muted">{formatSize(f.size_bytes)}</td>
                              <td>
                                {isAssigned ? (
                                  <button
                                    type="button"
                                    className="badge badge-green audio-usage-badge"
                                    onClick={() => {
                                      // Clear the swap-target for this file
                                      // when collapsing so reopening doesn't
                                      // show a previously-chosen target that
                                      // may now point at a deleted file.
                                      if (isExpanded) {
                                        setExpandedFileId(null);
                                        setSwapTargetByFileId((prev) => {
                                          if (!(f.id in prev)) return prev;
                                          const next = { ...prev };
                                          delete next[f.id];
                                          return next;
                                        });
                                      } else {
                                        setExpandedFileId(f.id);
                                      }
                                    }}
                                    aria-expanded={isExpanded}
                                    aria-label={`${
                                      isExpanded ? 'Hide' : 'Show'
                                    } ${usages.length} assignment${
                                      usages.length === 1 ? '' : 's'
                                    } of ${f.original_name}`}
                                  >
                                    {isExpanded ? '▼' : '▶'} Used in {usages.length}
                                  </button>
                                ) : (
                                  <span className="badge badge-gray">Unassigned</span>
                                )}
                              </td>
                              <td className="text-muted">
                                <time dateTime={f.created_at}>
                                  {new Date(f.created_at).toLocaleDateString()}
                                </time>
                              </td>
                              <td>
                                {(() => {
                                  const isPlaying = playingId === f.id;
                                  return (
                                    <>
                                      <button
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        onClick={() =>
                                          toggleAudition(
                                            f.id,
                                            `/api/projects/${projectId}/audio/file/${f.id}`,
                                          )
                                        }
                                        aria-label={
                                          isPlaying
                                            ? `Stop previewing ${f.original_name}`
                                            : `Preview ${f.original_name}`
                                        }
                                        aria-pressed={isPlaying}
                                        data-testid="audio-preview-btn"
                                      >
                                        {isPlaying ? '■ Stop' : '▶ Play'}
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-ghost btn-sm btn-danger"
                                        onClick={() => handleDelete(f.id)}
                                        aria-label={`Delete audio file ${f.original_name}`}
                                      >
                                        Delete
                                      </button>
                                    </>
                                  );
                                })()}
                              </td>
                            </tr>
                            {isExpanded && isAssigned && (
                              <tr className="audio-usage-row" data-testid="audio-usage-panel">
                                <td colSpan={5}>
                                  <div className="audio-usage-panel">
                                    <div className="audio-usage-swap-header">
                                      <label>
                                        <span className="text-muted text-sm">
                                          Swap all {usages.length} assignment
                                          {usages.length === 1 ? '' : 's'} to:
                                        </span>
                                        <select
                                          className="select select-inline"
                                          value={swapTarget}
                                          onChange={(e) =>
                                            setSwapTargetByFileId((prev) => ({
                                              ...prev,
                                              [f.id]: e.target.value,
                                            }))
                                          }
                                          disabled={isSwapping}
                                        >
                                          <option value="">Pick a replacement…</option>
                                          {replacementCandidates.map((c) => (
                                            <option key={c.id} value={c.id}>
                                              {c.original_name}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                      <button
                                        type="button"
                                        className="btn btn-primary btn-sm"
                                        onClick={() => handleSwapEverywhere(f.id)}
                                        disabled={
                                          !swapTarget ||
                                          isSwapping ||
                                          !replacementCandidates.some((c) => c.id === swapTarget)
                                        }
                                        data-testid="audio-swap-everywhere"
                                      >
                                        {isSwapping ? 'Swapping…' : 'Swap everywhere'}
                                      </button>
                                    </div>
                                    <table className="table audio-usage-table">
                                      <caption className="sr-only">
                                        Assignments of {f.original_name}
                                      </caption>
                                      <thead>
                                        <tr>
                                          <th>Node</th>
                                          <th>Slot</th>
                                          <th>Replace with</th>
                                          <th>
                                            <span className="sr-only">Remove</span>
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {usages.map((u) => (
                                          <tr key={`${u.nodeId}#${u.audioType}`}>
                                            <td className="node-name">{u.nodeId}</td>
                                            <td>
                                              <span className="badge badge-gray">
                                                {u.audioType}
                                              </span>
                                            </td>
                                            <td>
                                              <select
                                                className="select select-inline"
                                                value={
                                                  replaceTargetByUsage[
                                                    usageKey(u.nodeId, u.audioType)
                                                  ] ?? ''
                                                }
                                                onChange={(e) => {
                                                  const next = e.target.value;
                                                  const key = usageKey(u.nodeId, u.audioType);
                                                  setReplaceTargetByUsage((prev) => ({
                                                    ...prev,
                                                    [key]: next,
                                                  }));
                                                  if (next) {
                                                    void handleReplaceOne(
                                                      f.id,
                                                      u.nodeId,
                                                      u.audioType,
                                                      next,
                                                    ).finally(() => {
                                                      // Clear the dropdown after the swap
                                                      // attempt (success or failure) so
                                                      // the next pick starts fresh.
                                                      setReplaceTargetByUsage((prev) => {
                                                        if (!(key in prev)) return prev;
                                                        const cleared = { ...prev };
                                                        delete cleared[key];
                                                        return cleared;
                                                      });
                                                    });
                                                  }
                                                }}
                                                disabled={isSwapping}
                                                aria-label={`Replace ${u.audioType} on ${u.nodeId}`}
                                              >
                                                <option value="">Replace with…</option>
                                                {replacementCandidates.map((c) => (
                                                  <option key={c.id} value={c.id}>
                                                    {c.original_name}
                                                  </option>
                                                ))}
                                              </select>
                                            </td>
                                            <td>
                                              <button
                                                type="button"
                                                className="btn btn-ghost btn-sm btn-danger"
                                                onClick={() =>
                                                  handleRemoveAssignment(
                                                    u.nodeId,
                                                    u.audioType,
                                                    u.audioType === 'sfx' ? f.id : undefined,
                                                  )
                                                }
                                                disabled={isSwapping}
                                                aria-label={`Remove ${u.audioType} from ${u.nodeId}`}
                                              >
                                                ✕
                                              </button>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Coverage: Nodes without audio */}
      {coverage && coverage.nodesWithoutAudio.length > 0 && (
        <details className="audio-section">
          <summary className="audio-section-title audio-section-summary">
            Nodes without voiceover{' '}
            <span className="text-muted">({coverage.nodesWithoutAudio.length})</span>
          </summary>
          <ul className="missing-nodes-list">
            {coverage.nodesWithoutAudio.map((nodeId) => (
              <li key={nodeId} className="node-name">
                {nodeId}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
