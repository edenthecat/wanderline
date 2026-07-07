/**
 * API client — thin wrappers around fetch() with session cookies.
 */

const API_BASE = '/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { data } = await requestWithHeaders<T>(path, options);
  return data;
}

/**
 * variant that returns response headers alongside the body.
 * Needed for endpoints where the header carries a signal the UI
 * wants to surface — e.g. `X-Wanderline-Dedup` /
 * `X-Wanderline-Idempotent` on POST /builds. The base `request`
 * helper stays a thin wrapper for the common shape.
 */
export async function requestWithHeaders<T>(
  path: string,
  options: RequestInit = {},
): Promise<{ data: T; headers: Headers }> {
  const { headers: extraHeaders, body, ...restOptions } = options;
  // Normalize headers to plain object to handle Headers instance or [key,value][]
  const normalized = new Headers(extraHeaders as HeadersInit | undefined);
  const headers: Record<string, string> = {};
  normalized.forEach((v, k) => {
    headers[k] = v;
  });
  // Only set Content-Type for requests with a body
  if (body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...restOptions,
    body,
    headers,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, errorBody.error || res.statusText);
  }

  const data = (await res.json()) as T;
  return { data, headers: res.headers };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

// ── Auth ────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'editor';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export function fetchMe(): Promise<{ user: AuthUser }> {
  return request('/auth/me');
}

export function login(email: string, password: string): Promise<{ user: AuthUser }> {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<{ success: boolean }> {
  return request('/auth/logout', { method: 'POST' });
}

// ── Setup ───────────────────────────────────────────────────────────────

export function fetchSetupStatus(): Promise<{ needsSetup: boolean }> {
  return request('/setup/status');
}

export function initAdmin(
  email: string,
  password: string,
  displayName: string,
): Promise<{ user: AuthUser; sessionFailed?: boolean }> {
  return request('/setup', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName }),
  });
}

// ── Projects ────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  has_story: boolean;
  story_title: string | null;
  /**: 'ink' | 'twee' — the format the project was uploaded from.
   * Falls back to 'ink' for earlier rows via COALESCE in the SQL. */
  source_language: 'ink' | 'twee';
  created_at: string;
  updated_at: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  story_graph: StoryGraph | null;
  ink_source: string | null;
  // symmetric with ink_source. Populated when the last
  // upload used POST /twine; NULL after an /ink upload cleared it.
  // Regenerated on demand from story_graph on GET /exports/twee.
  twee_source: string | null;
  // which format the user is currently authoring in. Drives
  // the source editor swap and the default nomenclature. Falls back
  // to 'ink' for earlier rows via the DB default.
  source_language: 'ink' | 'twee';
  settings: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// Mirror of backend ValidationType (see backend/src/types.ts).
// Kept as a string union for forward compatibility — unknown values
// from the API still render as plain text.
export type ValidationType =
  | 'missing_target'
  | 'unreachable_node'
  | 'empty_node'
  | 'circular_reference'
  | 'missing_start'
  | 'duplicate_node'
  | 'syntax_error'
  | 'orphaned_stitch';

export interface ValidationMessage {
  type: ValidationType | string;
  message: string;
  nodeId?: string;
  lineNumber?: number;
}

export interface StoryGraph {
  id: string;
  title: string;
  nodes: Record<string, StoryNode>;
  startNode: string;
  validation: {
    valid: boolean;
    errors: ValidationMessage[];
    warnings: ValidationMessage[];
  };
}

export interface StoryNode {
  id: string;
  type: 'knot' | 'stitch' | 'gather';
  parent: string | null;
  content: { text: string; tags: string[] }[];
  choices: { text: string; target: string; sticky: boolean; fallback: boolean; tags: string[] }[];
  divert: string | null;
  tags: string[];
  lineNumber: number;
  audio?: { voiceover?: string; ambience?: string; sfx?: string[] };
}

export function fetchProjects(): Promise<{ projects: ProjectSummary[] }> {
  return request('/projects');
}

export function fetchProject(id: string): Promise<{ project: ProjectDetail }> {
  return request(`/projects/${id}`);
}

export function createProject(
  name: string,
  description?: string,
): Promise<{ project: ProjectSummary }> {
  return request('/projects', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
}

export function updateProject(
  id: string,
  data: { name?: string; description?: string },
): Promise<{ project: ProjectSummary }> {
  return request(`/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteProject(id: string): Promise<{ success: boolean }> {
  return request(`/projects/${id}`, { method: 'DELETE' });
}

// ── Story ───────────────────────────────────────────────────────────────

export function uploadInk(
  projectId: string,
  source: string,
): Promise<{
  success: boolean;
  story: StoryGraph;
  summary: {
    nodeCount: number;
    knotCount: number;
    stitchCount: number;
    errorCount: number;
    warningCount: number;
  };
}> {
  return request(`/projects/${projectId}/ink`, {
    method: 'POST',
    body: JSON.stringify({ source }),
  });
}

export function uploadInkJson(
  projectId: string,
  jsonContent: string,
): Promise<{
  success: boolean;
  story: StoryGraph;
  summary: {
    nodeCount: number;
    knotCount: number;
    stitchCount: number;
    errorCount: number;
    warningCount: number;
  };
}> {
  return request(`/projects/${projectId}/ink-json`, {
    method: 'POST',
    body: jsonContent,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * upload a Twee 3 source string. Same response shape as
 * uploadInk. Backend flips project_stories.source_language to
 * 'twee' and clears ink_source (regenerated on demand via the Ink
 * emitter if the user later exports).
 *
 * Returns a rejected promise (thrown ApiError) with `code:
 * 'twee1_detected'` on Twee 1 shape — surface as a clear
 * "re-export from Twine 2" message to the user.
 */
export function uploadTwee(
  projectId: string,
  source: string,
): Promise<{
  success: boolean;
  story: StoryGraph;
  summary: {
    nodeCount: number;
    knotCount: number;
    stitchCount: number;
    errorCount: number;
    warningCount: number;
  };
}> {
  return request(`/projects/${projectId}/twine`, {
    method: 'POST',
    body: JSON.stringify({ source }),
  });
}

/**
 * fetch the story as text in the requested format. The
 * backend serves the persisted authoritative source when it matches;
 * otherwise regenerates from story_graph via the appropriate emitter
 * and caches the result server-side.
 */
export async function exportStorySource(
  projectId: string,
  format: 'ink' | 'twee',
): Promise<string> {
  // Not going through requestWithHeaders because the response body
  // is text/plain, not JSON.
  const res = await fetch(`/api/projects/${projectId}/exports/${format}`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || res.statusText);
  }
  return res.text();
}

// ── Audio ────────────────────────────────────────────────────────────────

export interface AudioFile {
  id: string;
  project_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  category: string;
  character_id: string | null;
  created_at: string;
  updated_at: string;
}

export function fetchAudioFiles(projectId: string): Promise<{ audioFiles: AudioFile[] }> {
  return request(`/projects/${projectId}/audio`);
}

export async function uploadAudioFile(
  projectId: string,
  file: File,
  category: string,
  characterId?: string,
): Promise<{ audioFile: AudioFile }> {
  const formData = new FormData();
  formData.append('audio', file);
  formData.append('category', category);
  if (characterId) formData.append('characterId', characterId);

  const res = await fetch(`${API_BASE}/projects/${projectId}/audio`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || res.statusText);
  }

  return res.json();
}

export function deleteAudioFile(projectId: string, audioId: string): Promise<{ success: boolean }> {
  return request(`/projects/${projectId}/audio/${audioId}`, { method: 'DELETE' });
}

// ── Audio Assignments ──────────────────────────────────────────────────

export interface AudioAssignmentRaw {
  id: string;
  project_id: string;
  node_id: string;
  audio_type: string;
  audio_file_id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  created_at: string;
}

export interface AudioAssignments {
  [nodeId: string]: {
    voiceover?: string;
    ambience?: string;
    choice1?: string;
    choice2?: string;
    sfx: string[];
  };
}

export function fetchAudioAssignments(
  projectId: string,
): Promise<{ assignments: AudioAssignments; raw: AudioAssignmentRaw[] }> {
  return request(`/projects/${projectId}/audio/assignments`);
}

export function assignAudio(
  projectId: string,
  nodeId: string,
  audioType: string,
  audioFileId: string,
): Promise<{ assignment: AudioAssignmentRaw }> {
  return request(`/projects/${projectId}/audio/assignments`, {
    method: 'POST',
    body: JSON.stringify({ nodeId, audioType, audioFileId }),
  });
}

export function removeAudioAssignment(
  projectId: string,
  nodeId: string,
  audioType: string,
  audioFileId?: string,
): Promise<{ success: boolean }> {
  const params = audioFileId ? `?audioFileId=${encodeURIComponent(audioFileId)}` : '';
  return request(`/projects/${projectId}/audio/assignments/${nodeId}/${audioType}${params}`, {
    method: 'DELETE',
  });
}

export interface BulkReassignOp {
  nodeId: string;
  audioType: string;
  fromFileId: string;
  toFileId: string;
}

/** Atomically re-point every (nodeId, audioType, fromFileId) assignment
 * in `ops` to `toFileId`. All-or-nothing: if any op references an
 * assignment that doesn't exist (or a toFileId not in this project's
 * library) the server rolls back and returns 400. */
export function bulkReassignAudio(
  projectId: string,
  ops: BulkReassignOp[],
): Promise<{ success: boolean; swapped: number }> {
  return request(`/projects/${projectId}/audio/assignments/bulk-reassign`, {
    method: 'POST',
    body: JSON.stringify({ ops }),
  });
}

// ── Audio Coverage ─────────────────────────────────────────────────────

export interface OrphanedAudioFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType?: string;
  createdAt: string;
}

export interface AudioCoverage {
  nodesWithoutAudio: string[];
  orphanedAudioFiles: OrphanedAudioFile[];
  coverage: {
    total: number;
    withAudio: number;
    percentage: number;
  };
}

export function fetchAudioCoverage(projectId: string): Promise<AudioCoverage> {
  return request(`/projects/${projectId}/audio/coverage`);
}

// ── Audio Bulk Upload ──────────────────────────────────────────────────

export interface BulkUploadResult {
  success: boolean;
  totalUploaded: number;
  totalMatched: number;
  totalUnmatched: number;
  uploaded: { id: string; filename: string; originalName: string }[];
  matched: { audioFileId: string; nodeId: string; audioType: string; filename: string }[];
  unmatched: { audioFileId: string; filename: string }[];
}

export interface RematchResult {
  success: boolean;
  totalMatched: number;
  totalUnmatched: number;
  alreadyAssigned: number;
  matched: { audioFileId: string; nodeId: string; audioType: string; filename: string }[];
  unmatched: { audioFileId: string; filename: string }[];
}

export async function rematchUnassignedAudio(projectId: string): Promise<RematchResult> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/audio/rematch`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || res.statusText);
  }
  return (await res.json()) as RematchResult;
}

// Cloud Run caps request bodies at ~32 MiB; nginx allows 50 MiB but
// that's a moot ceiling because the proxied request still hits
// Cloud Run. To survive realistic bulk uploads (a user reported
// breakage on a multi-file batch), split the upload into chunks of
// ~20 MiB each, send sequentially, and aggregate the per-chunk
// BulkUploadResults into one. The backend's `/audio/bulk` route is
// idempotent at the per-file level (filename + size + project id),
// so a chunked upload behaves the same as one giant one.
const BULK_UPLOAD_TARGET_BYTES = 20 * 1024 * 1024;

function partitionFilesForUpload(files: File[]): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let currentSize = 0;
  for (const file of files) {
    // A single file larger than the target gets its own batch so it
    // still gets attempted (the backend per-file cap is 50 MiB; Cloud
    // Run will reject anything past ~32 MiB and the caller will see
    // a clear 413 instead of a silent truncation).
    if (file.size >= BULK_UPLOAD_TARGET_BYTES) {
      if (current.length > 0) {
        batches.push(current);
        current = [];
        currentSize = 0;
      }
      batches.push([file]);
      continue;
    }
    if (currentSize + file.size > BULK_UPLOAD_TARGET_BYTES && current.length > 0) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(file);
    currentSize += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// Exported for unit-testing the partitioner without going through fetch.
export const __testing__ = { partitionFilesForUpload, BULK_UPLOAD_TARGET_BYTES };

async function uploadOneBatch(
  projectId: string,
  files: File[],
  category: string,
  characterId?: string,
): Promise<BulkUploadResult> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('audio', file);
  }
  formData.append('category', category);
  if (characterId) formData.append('characterId', characterId);

  const res = await fetch(`${API_BASE}/projects/${projectId}/audio/bulk`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 413) {
      throw new ApiError(
        413,
        // Cloud Run caps request bodies at ~32 MiB. The frontend already
        // batches into ~20 MiB chunks, so reaching 413 means a single
        // file in this batch is bigger than that ceiling. Surface the
        // batch-level cause, not "file is too large".
        'Upload batch exceeded the request-body limit. Drop any individual file over ~20 MB and retry.',
      );
    }
    throw new ApiError(res.status, body.error || res.statusText);
  }
  return (await res.json()) as BulkUploadResult;
}

export async function bulkUploadAudio(
  projectId: string,
  files: File[],
  category: string,
  characterId?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<BulkUploadResult> {
  const batches = partitionFilesForUpload(files);
  const combined: BulkUploadResult = {
    success: true,
    totalUploaded: 0,
    totalMatched: 0,
    totalUnmatched: 0,
    uploaded: [],
    matched: [],
    unmatched: [],
  };
  let done = 0;
  for (const batch of batches) {
    const result = await uploadOneBatch(projectId, batch, category, characterId);
    combined.totalUploaded += result.totalUploaded;
    combined.totalMatched += result.totalMatched;
    combined.totalUnmatched += result.totalUnmatched;
    combined.uploaded.push(...result.uploaded);
    combined.matched.push(...result.matched);
    combined.unmatched.push(...result.unmatched);
    done += batch.length;
    onProgress?.(done, files.length);
  }
  return combined;
}

// ── Characters ──────────────────────────────────────────────────────────

export interface Character {
  id: string;
  project_id: string;
  name: string;
  color: string;
  theme: string;
  audio_count: string;
  created_at: string;
  updated_at: string;
}

export function fetchCharacters(projectId: string): Promise<{ characters: Character[] }> {
  return request(`/projects/${projectId}/characters`);
}

export function createCharacter(
  projectId: string,
  name: string,
  color?: string,
  theme?: string,
): Promise<{ character: Character }> {
  return request(`/projects/${projectId}/characters`, {
    method: 'POST',
    body: JSON.stringify({ name, color, theme }),
  });
}

export function updateCharacter(
  projectId: string,
  characterId: string,
  data: { name?: string; color?: string; theme?: string },
): Promise<{ character: Character }> {
  return request(`/projects/${projectId}/characters/${characterId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteCharacter(
  projectId: string,
  characterId: string,
): Promise<{ success: boolean }> {
  return request(`/projects/${projectId}/characters/${characterId}`, { method: 'DELETE' });
}

// ── Builds ──────────────────────────────────────────────────────────────

// Mirror of what backend/src/services/build-service.ts:formatBuild()
// returns. Keep this in sync if the response shape changes.
export interface Build {
  id: string;
  buildNumber: number;
  // 'cancelled' added when the cancel endpoint transitioned
  // pending/processing rows to a terminal state.
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  message: string | null;
  error: string | null;
  label: string | null;
  // Audit data populated when the build completes. Null on pending /
  // processing builds and on legacy builds from before the audit columns.
  totalSizeBytes: number | null;
  audioSizeBytes: number | null;
  codeSizeBytes: number | null;
  audioFileCount: number | null;
  nodeCount: number | null;
  createdAt: string;
  completedAt: string | null;
  // pinning + soft-delete groundwork. Pinned builds are
  // exempted from the retention auto-cull that runs when the project
  // hits MAX_BUILDS_PER_PROJECT.
  pinned: boolean;
  // which player-app bundle this build shipped against. Both
  // null on rows created earlier.
  playerBundleVersion: string | null;
  playerBundleSriHash: string | null;
  // attempt-count for retry visibility, idempotency key echoed
  // back so callers can confirm a same-key retry deduped to the row
  // they expected.
  attemptCount: number;
  idempotencyKey: string | null;
}

/**
 * metadata returned alongside a start-build request. Both
 * headers signal that the returned `build` is an existing row we
 * replayed instead of a fresh queue.
 */
export interface StartBuildOutcome {
  build: Build;
  /** Set when the server hit a story-hash dedup and returned an existing completed build. */
  dedupHit: boolean;
  /** Set when the server hit an Idempotency-Key match and replayed the earlier response. */
  idempotentHit: boolean;
}

export function fetchBuilds(
  projectId: string,
): Promise<{ builds: Build[]; maxBuilds: number; canCreateBuild: boolean }> {
  return request(`/projects/${projectId}/builds`);
}

export function fetchBuild(projectId: string, buildId: string): Promise<{ build: Build }> {
  return request(`/projects/${projectId}/builds/${buildId}`);
}

/**
 * enqueue a build. Accepts an optional `idempotencyKey` so a
 * client-side retry after a mid-flight network failure gets the same
 * row back instead of stacking duplicate builds. UI callers should
 * generate a UUID per user action (crypto.randomUUID()) and reuse it
 * across retries of the same intent.
 *
 * Returns `dedupHit` / `idempotentHit` for the caller to render a
 * user-visible "we reused build #N" hint on 200 responses.
 */
export async function startBuild(
  projectId: string,
  label?: string,
  idempotencyKey?: string,
): Promise<StartBuildOutcome> {
  const { data, headers } = await requestWithHeaders<{ build: Build }>(
    `/projects/${projectId}/builds`,
    {
      method: 'POST',
      body: JSON.stringify({ label }),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    },
  );
  return {
    build: data.build,
    dedupHit: headers.get('X-Wanderline-Dedup') === 'story-hash-match',
    idempotentHit: headers.get('X-Wanderline-Idempotent') === 'hit',
  };
}

export function deleteBuild(projectId: string, buildId: string): Promise<{ success: boolean }> {
  return request(`/projects/${projectId}/builds/${buildId}`, { method: 'DELETE' });
}

/**
 * cancel an in-progress build. Backend gates on
 * status IN ('pending','processing'); terminal-state builds refuse
 * with 409, missing/soft-deleted with 404.
 */
export function cancelBuild(projectId: string, buildId: string): Promise<{ build: Build }> {
  return request(`/projects/${projectId}/builds/${buildId}/cancel`, { method: 'POST' });
}

/**
 * toggle or set the pinned flag on a build. Passing `pinned`
 * is idempotent (safe on double-click / retry); omitting toggles the
 * current state.
 */
export function pinBuild(
  projectId: string,
  buildId: string,
  pinned?: boolean,
): Promise<{ build: Build }> {
  return request(`/projects/${projectId}/builds/${buildId}/pin`, {
    method: 'POST',
    body: pinned !== undefined ? JSON.stringify({ pinned }) : undefined,
  });
}

// ── Snapshots ───────────────────────────────────────────────────────────

export interface ProjectSnapshot {
  id: string;
  label: string;
  source: 'manual' | 'auto';
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
}

export function fetchSnapshots(projectId: string): Promise<{ snapshots: ProjectSnapshot[] }> {
  return request(`/projects/${projectId}/snapshots`);
}

export function createSnapshot(
  projectId: string,
  label?: string,
): Promise<{ id: string; createdAt: string }> {
  return request(`/projects/${projectId}/snapshots`, {
    method: 'POST',
    body: JSON.stringify({ label: label ?? '' }),
  });
}

export function restoreSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<{ success: boolean }> {
  return request(`/projects/${projectId}/snapshots/${snapshotId}/restore`, { method: 'POST' });
}

export function deleteSnapshot(
  projectId: string,
  snapshotId: string,
): Promise<{ success: boolean }> {
  return request(`/projects/${projectId}/snapshots/${snapshotId}`, { method: 'DELETE' });
}

// ── Metadata ────────────────────────────────────────────────────────────

export interface NodeMetadata {
  // Postgres column is nullable; on a freshly-inserted row the API
  // can return `null`, so `string | null` matches runtime reality.
  // Sending either `null` or '' on update clears the override
  // (see backend/src/routes/metadata.ts).
  transcript?: string | null;
  delayBeforeMs: number;
  delayAfterMs: number;
  autoAdvance: boolean;
  autoAdvanceDelayMs: number;
  choice1TimestampMs?: number;
  choice2TimestampMs?: number;
  noInlineChoiceAudio?: boolean;
  characterId?: string;
}

export function fetchMetadata(
  projectId: string,
): Promise<{ metadata: Record<string, NodeMetadata> }> {
  return request(`/projects/${projectId}/metadata`);
}

export function updateNodeMetadata(
  projectId: string,
  nodeId: string,
  data: Partial<NodeMetadata>,
): Promise<{ metadata: NodeMetadata }> {
  return request(`/projects/${projectId}/metadata/${nodeId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ── Users ──────────────────────────────────────────────────────────────

export interface ManagedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
}

export function fetchUsers(): Promise<{ users: ManagedUser[] }> {
  return request('/users');
}

export function createUser(
  email: string,
  password: string,
  displayName: string,
  role: UserRole,
): Promise<{ user: ManagedUser }> {
  return request('/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName, role }),
  });
}

export function updateUser(
  userId: string,
  data: { displayName?: string; role?: UserRole; isActive?: boolean },
): Promise<{ user: ManagedUser }> {
  return request(`/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

// ── Invitations ────────────────────────────────────────────────────────

export interface PendingInvitation {
  id: string;
  email: string;
  role: UserRole;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedInvitation {
  invitation: PendingInvitation;
  // Raw magic link URL — only returned ONCE at create time.
  magicLinkUrl: string;
}

export function fetchInvitations(): Promise<{ invitations: PendingInvitation[] }> {
  return request('/invitations');
}

export function createInvitation(email: string, role: UserRole): Promise<CreatedInvitation> {
  return request('/invitations', {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  });
}

export function revokeInvitation(id: string): Promise<{ success: true }> {
  return request(`/invitations/${id}`, { method: 'DELETE' });
}

export interface PublicInvitation {
  email: string;
  role: UserRole;
  expiresAt: string;
}

export function lookupInvitationToken(token: string): Promise<{ invitation: PublicInvitation }> {
  return request(`/invitations/token/${encodeURIComponent(token)}`);
}

export function acceptInvitation(
  token: string,
  displayName: string,
  password: string,
): Promise<{ user: AuthUser }> {
  return request(`/invitations/token/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body: JSON.stringify({ displayName, password }),
  });
}

// ── Settings ───────────────────────────────────────────────────────────

// Bluetooth / headphone media-control mappings. The browser MediaSession
// API translates physical button presses into these abstract events; we
// pick what each one actually does in our story navigation model.
//
// nextTrack actions:
//   - 'choice1':       jump to choice index 0 (current default)
//   - 'cycle_choices': move the on-screen choice highlight forward
//   - 'confirm':       navigate to the currently-highlighted choice
//   - 'divert':        follow the node's divert (no-op if it has none)
//
// previousTrack actions:
//   - 'choice2':       jump to choice index 1 (current default)
//   - 'cycle_choices': move the on-screen choice highlight backward
//   - 'go_back':       pop one step from history
export type BluetoothNextAction = 'choice1' | 'cycle_choices' | 'confirm' | 'divert';
export type BluetoothPrevAction = 'choice2' | 'cycle_choices' | 'go_back';
export interface BluetoothControls {
  nextTrack?: BluetoothNextAction;
  previousTrack?: BluetoothPrevAction;
}

// theme keys map onto CSS custom properties consumed by the
// player. Adding a knob here requires reading the matching
// `var(--wl-...)` in player-app/src/App.tsx — see VARIABLE_PROPERTY_MAP
// in backend/src/services/theme-render.ts for the canonical mapping.
export interface ThemeVariables {
  pageBackground?: string;
  cardBackground?: string;
  textColor?: string;
  accentColor?: string;
  headingColor?: string;
  chromeColor?: string;
  // follow-up: tint all iconoir SVGs in the player UI.
  iconColor?: string;
}

// per-component theming. Authors override individual surfaces
// (story card, choice button, etc.) without touching the customCss
// textarea. See frontend/src/api/theme-components.ts for the schema
// the editor + player + backend share.
export type ComponentThemeMap = Partial<Record<string, Record<string, string | undefined>>>;

export interface ProjectTheme {
  variables?: ThemeVariables;
  bodyFont?: string;
  bodyFontWeights?: string[];
  headingFont?: string;
  headingFontWeights?: string[];
  customCss?: string;
  components?: ComponentThemeMap;
}

export interface ProjectSettings {
  password?: string;
  // Default playback volumes (0-100) baked into the generated app
  // on launch. User can still adjust at runtime via the player's
  // settings panel; these are the starting points.
  voiceoverVolume?: number;
  backgroundMusicVolume?: number;
  indicatorVolume?: number;
  // Default UI sound: id of an indicator-category audio file that
  // the generated app plays for choice/transition cues. Null/unset
  // means silent.
  defaultIndicatorAudioId?: string | null;
  choiceAudioDelayMs?: number;
  // UI options for the generated player. All default to true / "on"
  // when unset — see player-app/src/App.tsx for the resolution.
  captionsDefault?: boolean;
  showProgressBar?: boolean;
  showChoiceList?: boolean;
  // per-project Bluetooth / headphone button mapping. Falls
  // back to {nextTrack: 'choice1', previousTrack: 'choice2'} when unset
  // (matches the player's earlier hardcoded behavior).
  bluetoothControls?: BluetoothControls;
  // per-project theme — CSS variables, Google Fonts choices,
  // and a free-form customCss escape hatch.
  theme?: ProjectTheme;
  // per-project nomenclature preference. 'auto' means the
  // vocab follows project_stories.source_language; 'ink' / 'twee'
  // locks the vocab regardless of the current source language.
  nomenclature?: 'auto' | 'ink' | 'twee';
  [key: string]: unknown;
}

export function fetchProjectSettings(projectId: string): Promise<{ settings: ProjectSettings }> {
  return request(`/projects/${projectId}/settings`);
}

export function updateProjectSettings(
  projectId: string,
  settings: Partial<ProjectSettings>,
): Promise<{ settings: ProjectSettings }> {
  return request(`/projects/${projectId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ settings }),
  });
}

export function deleteAllProjectAudio(projectId: string): Promise<{ success: boolean }> {
  return request(`/projects/${projectId}/audio`, { method: 'DELETE' });
}

// ── Story Editing ──────────────────────────────────────────────────────

interface StoryEditResult {
  success: boolean;
  story_graph: StoryGraph;
}

export function updateChoiceTarget(
  projectId: string,
  nodeId: string,
  choiceIndex: number,
  newTarget: string,
): Promise<StoryEditResult> {
  return request(`/projects/${projectId}/story/choice`, {
    method: 'PATCH',
    body: JSON.stringify({ nodeId, choiceIndex, newTarget }),
  });
}

export function updateChoiceText(
  projectId: string,
  nodeId: string,
  choiceIndex: number,
  newText: string,
): Promise<StoryEditResult> {
  return request(`/projects/${projectId}/story/choice/text`, {
    method: 'PATCH',
    body: JSON.stringify({ nodeId, choiceIndex, newText }),
  });
}

/** Replace one content-line's text on a node. Body content (narrator
 * paragraphs) was previously read-only in the detail panel; this
 * wires up the same debounced/collab pattern as choice text. */
export function updateNodeContentText(
  projectId: string,
  nodeId: string,
  contentIndex: number,
  newText: string,
): Promise<StoryEditResult> {
  return request(`/projects/${projectId}/story/node/content/text`, {
    method: 'PATCH',
    body: JSON.stringify({ nodeId, contentIndex, newText }),
  });
}

export function updateDivert(
  projectId: string,
  nodeId: string,
  newTarget: string | null,
): Promise<StoryEditResult> {
  return request(`/projects/${projectId}/story/divert`, {
    method: 'PATCH',
    body: JSON.stringify({ nodeId, newTarget }),
  });
}

export function addChoice(
  projectId: string,
  nodeId: string,
  choice: { text: string; target: string },
  atIndex?: number,
): Promise<StoryEditResult> {
  return request(`/projects/${projectId}/story/choice`, {
    method: 'POST',
    body: JSON.stringify({ nodeId, choice, atIndex }),
  });
}

export function deleteChoice(
  projectId: string,
  nodeId: string,
  choiceIndex: number,
): Promise<StoryEditResult> {
  return request(`/projects/${projectId}/story/choice`, {
    method: 'DELETE',
    body: JSON.stringify({ nodeId, choiceIndex }),
  });
}

export function swapChoices(
  projectId: string,
  nodeId: string,
  fromIndex: number,
  toIndex: number,
): Promise<StoryEditResult> {
  return request(`/projects/${projectId}/story/choice/swap`, {
    method: 'PATCH',
    body: JSON.stringify({ nodeId, fromIndex, toIndex }),
  });
}

/**: rename a node. Server-side transaction rewrites every
 * reference (choice targets, diverts, stitch parents, startNode) plus
 * the two side tables (`node_audio_assignments`, `node_metadata`).
 * Throws `ApiError` on 400 (invalid ids), 404 (no story / unknown
 * old), 409 (newId already taken). */
export function renameNode(
  projectId: string,
  oldId: string,
  newId: string,
): Promise<StoryEditResult> {
  return request(`/projects/${projectId}/story/node/rename`, {
    method: 'PATCH',
    body: JSON.stringify({ oldId, newId }),
  });
}
