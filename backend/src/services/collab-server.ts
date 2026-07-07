// WebSocket bridge for Yjs collaborative editing.
//
// Mounts a WebSocket server on top of the existing Express HTTP
// server (so Cloud Run's same-port routing still works) and runs
// the Yjs sync + awareness protocols for each /ws/projects/:id
// path. Auth: re-uses the editor's session cookie via the same
// express-session machinery the REST routes use — without auth,
// any browser could connect to any project's collab room.
//
// y-websocket@3 no longer ships the bin/utils helper that older
// guides reference, so this file is the ~80-line equivalent built
// directly on y-protocols/sync + y-protocols/awareness. That also
// gives us a clear extension point for phase 4's DB persistence and
// phase 5's presence wiring without monkey-patching a vendor lib.

import type { IncomingMessage, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import { logger } from '../logger.js';
import { seedYDocFromStoryGraph } from './yjs-story.js';
import { CollabShadowSaver } from './collab-shadow-saver.js';
import type { StoryGraph } from '../types.js';

const PATH_RE = /^\/ws\/projects\/([0-9a-f-]{36})(?:\?.*)?$/;

// Message-type tags. Mirrors y-websocket's wire format so the
// frontend's WebsocketProvider talks to us without modification.
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<WebSocket>;
  /** Set true once we've attempted DB hydration for this room. */
  hydrated: boolean;
  /** Persistence: shadow-saves the Y.Doc nodes back to project_stories. */
  shadowSaver: CollabShadowSaver | null;
  /** Timer that GCs the room after the last client leaves. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Awareness client IDs each connected socket has published. Used
   * on socket close to remove only THIS socket's awareness entries
   * — without it, closing one socket would clear every peer's
   * awareness and make the remaining editors disappear from each
   * other's presence chips.
   */
  awarenessByConn: Map<WebSocket, Set<number>>;
}

const rooms = new Map<string, Room>();
/**
 * Per-project promise that resolves once an in-flight invalidation
 * (room teardown after restore/ink-upload) has fully completed.
 * `getOrCreateRoom` awaits this before constructing a fresh room
 * so a new connection can't slip into the window between
 * "rooms.delete" and "shadow saver finishes its trailing UPDATE"
 * and hydrate from a row the old saver is about to clobber.
 */
const pendingInvalidations = new Map<string, Promise<void>>();

// How long an empty room sits in memory before we drop it. Long
// enough that a page refresh doesn't lose state; short enough that
// hundreds of stale rooms don't accumulate over a long-lived
// backend.
const IDLE_GC_MS = 5 * 60 * 1000;

async function getOrCreateRoom(projectId: string): Promise<Room> {
  // If a previous invalidation is still tearing down (its shadow
  // saver is mid-UPDATE), wait for that to settle before we
  // construct a fresh room. Otherwise the trailing stale UPDATE
  // can land AFTER this new room hydrates and silently revert the
  // row we're about to read from.
  while (pendingInvalidations.has(projectId)) {
    // Loop in case another invalidation lands while we're awaiting
    // the first one — we want to be 100% behind any teardown.
    await pendingInvalidations.get(projectId);
  }
  let room = rooms.get(projectId);
  if (room) {
    // Cancel any pending idle GC since we're about to touch this room.
    if (room.idleTimer) {
      clearTimeout(room.idleTimer);
      room.idleTimer = null;
    }
    return room;
  }
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null); // server is not a participant
  room = {
    doc,
    awareness,
    conns: new Set(),
    hydrated: false,
    shadowSaver: null,
    idleTimer: null,
    awarenessByConn: new Map(),
  };
  rooms.set(projectId, room);

  // Broadcast doc updates to all peers other than the one that
  // produced them. The transaction origin is the WebSocket that
  // generated the update; we tag it so we don't echo back.
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const msg = encoding.toUint8Array(encoder);
    for (const conn of room!.conns) {
      if (conn === origin) continue;
      try {
        conn.send(msg);
      } catch {
        // socket already closed — closer's onclose will clean up
      }
    }
  });

  awareness.on(
    'update',
    (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      const changed = added.concat(updated, removed);
      if (changed.length === 0) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      const msg = encoding.toUint8Array(encoder);
      for (const conn of room!.conns) {
        if (conn === origin) continue;
        try {
          conn.send(msg);
        } catch {}
      }
    },
  );

  return room;
}

async function hydrateRoomFromDb(room: Room, projectId: string, pool: Pool): Promise<void> {
  if (room.hydrated) return;
  room.hydrated = true; // mark first so concurrent connections don't double-hydrate
  try {
    const result = await pool.query(
      'SELECT story_graph FROM project_stories WHERE project_id = $1',
      [projectId],
    );
    if (result.rows.length > 0 && result.rows[0].story_graph) {
      const storyGraph = result.rows[0].story_graph as StoryGraph;
      seedYDocFromStoryGraph(room.doc, storyGraph);
      logger.info(
        { projectId, nodeCount: Object.keys(storyGraph.nodes ?? {}).length },
        'collab: hydrated Y.Doc from project_stories',
      );
    }
    // Phase 4: now that hydration is done (or there was nothing to
    // hydrate), attach the shadow saver. Future Y.Doc updates from
    // connected editors get debounced + persisted back to the row.
    if (!room.shadowSaver) {
      room.shadowSaver = new CollabShadowSaver(pool, projectId, room.doc);
    }
  } catch (err) {
    logger.error({ err, projectId }, 'collab: failed to hydrate Y.Doc from DB');
    // Leave hydrated=true so we don't retry on every connection — a
    // failed hydration becomes an empty Doc that clients can still
    // edit. The shadow saver still attaches so subsequent edits
    // persist normally.
    if (!room.shadowSaver) {
      room.shadowSaver = new CollabShadowSaver(pool, projectId, room.doc);
    }
  }
}

/**
 * Walk the wire-level awareness update payload (the same format
 * produced by `awarenessProtocol.encodeAwarenessUpdate`) and replace
 * any per-client state whose `user.userId` doesn't match the
 * authenticated session userId with a removal (state=null).
 *
 * This runs BEFORE `applyAwarenessUpdate` so a spoofed state never
 * enters the server's awareness map and never gets relayed to
 * peers. Anonymous states (no `user` field) pass through untouched.
 *
 * Payload format (mirrors y-protocols encode/decodeAwarenessUpdate):
 *
 *   [varuint number of states]
 *   for each state:
 *     [varuint clientID]
 *     [varuint clock]
 *     [varString state JSON]
 */
function filterAwarenessPayload(payload: Uint8Array, sessionUserId: string): Uint8Array {
  let probe;
  let len: number;
  try {
    // Probe a COPY of the payload so the original Uint8Array is
    // untouched. lib0/decoding's createDecoder doesn't mutate the
    // source buffer, but readVarUint8Array upstream returns a
    // subarray view — copying is cheap and bulletproof.
    probe = decoding.createDecoder(new Uint8Array(payload));
    len = decoding.readVarUint(probe);
  } catch (err) {
    // Malformed varuint up-front: don't risk a partial parse,
    // pass through and let applyAwarenessUpdate decide.
    logger.warn({ err }, 'collab: awareness payload header unreadable, passing through');
    return payload;
  }
  type Entry = { clientID: number; clock: number; state: unknown };
  const entries: Entry[] = [];
  let needsRewrite = false;
  for (let i = 0; i < len; i++) {
    let clientID: number;
    let clock: number;
    let state: unknown;
    let stateJson: string;
    try {
      clientID = decoding.readVarUint(probe);
      clock = decoding.readVarUint(probe);
      // y-protocols encodes state via writeVarString(JSON.stringify(state)).
      // We mirror that on the wire to stay round-trip compatible.
      stateJson = decoding.readVarString(probe);
      state = stateJson === 'null' ? null : JSON.parse(stateJson);
    } catch (err) {
      logger.warn({ err, i }, 'collab: awareness entry unreadable, passing payload through');
      return payload;
    }
    if (state !== null && typeof state === 'object') {
      const user = (state as { user?: unknown }).user;
      if (user && typeof user === 'object') {
        const userObj = user as { userId?: unknown };
        const claimedUserId = typeof userObj.userId === 'string' ? userObj.userId : undefined;
        // Reject only when a userId IS present and doesn't match the
        // authenticated session — that's the impersonation case.
        // Anonymous awareness (user object without a userId field)
        // is allowed: a peer can use it for display purposes (cursor
        // colors, focus rings) without claiming an identity.
        if (claimedUserId !== undefined && claimedUserId !== sessionUserId) {
          logger.warn(
            { sessionUserId, claimedUserId },
            'collab: dropped awareness state with mismatched userId',
          );
          state = null;
          needsRewrite = true;
        }
      }
    }
    entries.push({ clientID, clock, state });
  }
  if (!needsRewrite) return payload;
  const out = encoding.createEncoder();
  encoding.writeVarUint(out, len);
  for (const entry of entries) {
    encoding.writeVarUint(out, entry.clientID);
    encoding.writeVarUint(out, entry.clock);
    // Mirror the y-protocols wire encoding.
    encoding.writeVarString(out, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(out);
}

async function handleConnection(
  ws: WebSocket,
  projectId: string,
  userId: string,
  pool: Pool,
): Promise<void> {
  const room = await getOrCreateRoom(projectId);
  room.conns.add(ws);
  room.awarenessByConn.set(ws, new Set());
  ws.binaryType = 'arraybuffer';

  // Hydrate the Y.Doc from the DB BEFORE the sync handshake so
  // the first client receives the populated state vector, not an
  // empty one. The hydrated flag means subsequent connections
  // skip the DB hit. The transaction in seedYDocFromStoryGraph
  // commits before this await returns, so by the time we send
  // sync step 1 the Doc holds the seed.
  await hydrateRoomFromDb(room, projectId, pool);

  // 1. Sync step 1 — send our state vector so the client can diff
  //    its own state and respond with whatever we don't have yet.
  {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    ws.send(encoding.toUint8Array(encoder));
  }

  // 2. Send the current awareness state so this client sees who
  //    else is connected.
  const existingAwareness = Array.from(room.awareness.getStates().keys());
  if (existingAwareness.length > 0) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(room.awareness, existingAwareness),
    );
    ws.send(encoding.toUint8Array(encoder));
  }

  ws.on('message', (data: ArrayBuffer | Buffer) => {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      const decoder = decoding.createDecoder(bytes);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        // The 3rd arg is the origin we tag on the transaction; pass
        // ws so the broadcast loop above can skip the originator.
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws);
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        // Pre-filter the payload to neutralize any awareness state
        // that claims a userId other than this socket's session
        // userId. This MUST happen before applyAwarenessUpdate so
        // a spoof never lands in the server's awareness map and
        // never gets relayed to peers via the 'update' broadcast.
        const rawPayload = decoding.readVarUint8Array(decoder);
        const filtered = filterAwarenessPayload(rawPayload, userId);
        const beforeKeys = new Set(room.awareness.getStates().keys());
        awarenessProtocol.applyAwarenessUpdate(room.awareness, filtered, ws);
        const owned = room.awarenessByConn.get(ws);
        if (owned) {
          for (const id of room.awareness.getStates().keys()) {
            if (!beforeKeys.has(id)) owned.add(id);
          }
        }
      }
    } catch (err) {
      logger.warn({ err, projectId, userId }, 'collab: failed to handle message');
    }
  });

  const cleanup = () => {
    room.conns.delete(ws);
    // Forget ONLY this socket's awareness entries so peers stop
    // seeing it as present. Removing every state would erase the
    // chips for everyone still connected.
    const owned = room.awarenessByConn.get(ws);
    if (owned && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(owned), ws);
    }
    room.awarenessByConn.delete(ws);
    if (room.conns.size === 0) {
      logger.info({ projectId }, 'collab: last client left room');
      // Flush any pending shadow-save right away so the DB is
      // current even if the process dies before the idle window
      // elapses. We swallow the rejection because this is a
      // best-effort path — flush() rethrows for callers that need
      // to detect a failed write, but this cleanup runs after a
      // disconnect and has nowhere to report the error to.
      room.shadowSaver?.flush().catch((err) => {
        logger.warn({ err, projectId }, 'collab: last-client-leaving flush failed');
      });
      // Schedule the idle GC. If a client reconnects before the
      // timer fires, getOrCreateRoom cancels it.
      if (room.idleTimer) clearTimeout(room.idleTimer);
      room.idleTimer = setTimeout(() => {
        const stillRoom = rooms.get(projectId);
        if (!stillRoom || stillRoom.conns.size > 0) return;
        logger.info({ projectId }, 'collab: GC idle room from memory');
        rooms.delete(projectId);
        void (async () => {
          if (stillRoom.shadowSaver) await stillRoom.shadowSaver.destroy();
          stillRoom.doc.destroy();
        })();
      }, IDLE_GC_MS);
      room.idleTimer.unref?.();
    }
  };
  ws.on('close', cleanup);
  ws.on('error', (err) => {
    logger.warn({ err, projectId, userId }, 'collab: socket error');
    cleanup();
  });
}

/**
 * Attach a WebSocket server to the given HTTP server. Verifies the
 * connecting client has a valid session before delegating to the
 * Yjs sync/awareness handler. Each project id gets its own Y.Doc.
 *
 * sessionMiddleware: the express-session middleware instance, used
 *   to parse the session cookie off the upgrade request the same
 *   way HTTP routes resolve req.user.
 */
export function attachCollabServer(
  httpServer: HttpServer,
  options: {
    pool: Pool;
    sessionMiddleware: RequestHandler;
    /**
     * Predicate the server uses to gate access to a project's
     * Y.Doc. Injected (rather than imported directly) so tests can
     * stub the check without dragging the auth-middleware setup in.
     */
    canAccessProject: (userId: string, projectId: string) => Promise<boolean>;
  },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = req.url ?? '';
    const match = url.match(PATH_RE);
    if (!match) return;
    const projectId = match[1];

    const fakeRes = {
      end: () => undefined,
      setHeader: () => undefined,
      getHeader: () => undefined,
      writeHead: () => undefined,
    } as unknown as Parameters<RequestHandler>[1];
    options.sessionMiddleware(req as unknown as Parameters<RequestHandler>[0], fakeRes, () => {
      const session = (req as unknown as { session?: { userId?: string } }).session;
      if (!session?.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const userId = session.userId;
      // Mirror the REST `/api/projects/:id` access check so a
      // signed-in editor who knows another project's id can't open
      // its Y.Doc, read story contents, or push edits. Admins pass
      // unconditionally; everyone else must be in
      // `project_collaborators` for this project.
      void options
        .canAccessProject(userId, projectId)
        .then((allowed) => {
          if (!allowed) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
          wss.handleUpgrade(req, socket, head, (ws) => {
            logger.info({ projectId, userId }, 'collab: client connected');
            void handleConnection(ws as WebSocket, projectId, userId, options.pool);
          });
        })
        .catch((err) => {
          logger.error({ err, projectId, userId }, 'collab: project access check failed');
          try {
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            socket.destroy();
          } catch {}
        });
    });
  });

  return wss;
}

/**
 * Expose the room's Y.Doc to other backend code (e.g. preview /
 * build pipelines that want the current canonical state instead of
 * the row snapshot). Returns undefined if no client has ever
 * connected for that project.
 */
export function getProjectDoc(projectId: string): Y.Doc | undefined {
  return rooms.get(projectId)?.doc;
}

/**
 * Force any in-flight shadow saver for the project to commit
 * synchronously. Callers that read the canonical row (snapshot
 * capture, build pipeline) call this first so they don't miss
 * edits sitting in the debounce window. Resolves immediately if
 * no room is live.
 */
export async function flushPendingShadowSave(projectId: string): Promise<void> {
  const room = rooms.get(projectId);
  if (!room?.shadowSaver) return;
  await room.shadowSaver.flush();
}

/**
 * Drop a project's in-memory Y.Doc and disconnect all connected
 * clients. Used by the snapshot-restore endpoint and the ink-upload
 * endpoint: after the DB row is overwritten with the new canonical
 * state, the in-memory Doc is stale, so we close the room and let
 * clients reconnect — y-websocket auto-reconnects, and the new
 * connection re-hydrates from the DB row.
 *
 * CRITICAL: we do NOT flush the shadow saver here. The Y.Doc holds
 * the pre-restore/pre-upload state, but the row the caller just
 * wrote IS the new truth — flushing would race and stomp the row
 * back to pre-state content. We destroy the saver (cancelling any
 * pending debounce timer) before destroying the Doc so no late
 * write can leak through. The caller is expected to have already
 * persisted the new content before calling this.
 *
 * Returns true if a room existed and was closed, false if there
 * was nothing to do.
 */
export async function invalidateRoom(projectId: string): Promise<boolean> {
  const room = rooms.get(projectId);
  if (!room) return false;
  // Pull the room out of the rooms map immediately so any new
  // upgrade request can't reuse this one mid-teardown. New
  // connections going through getOrCreateRoom will block on the
  // teardown promise we register below — preventing the case
  // where a reconnect inside the await window hydrates from a row
  // the OLD saver is about to overwrite.
  rooms.delete(projectId);
  if (room.idleTimer) {
    clearTimeout(room.idleTimer);
    room.idleTimer = null;
  }
  const teardown = (async () => {
    // Tear down the saver and AWAIT any in-flight DB write so a
    // trailing stale UPDATE can't land after the caller's
    // destructive write (snapshot restore, ink reupload).
    if (room.shadowSaver) {
      await room.shadowSaver.destroy();
    }
    // Close all sockets. Clients will reconnect, hit
    // hydrateRoomFromDb, and see the restored row.
    for (const ws of room.conns) {
      try {
        ws.close(1012, 'collab-room-invalidated');
      } catch {
        try {
          ws.terminate();
        } catch {}
      }
    }
    room.doc.destroy();
  })();
  pendingInvalidations.set(projectId, teardown);
  try {
    await teardown;
  } finally {
    // Only clear if this is still the promise we registered — a
    // back-to-back invalidate would set a new one we shouldn't drop.
    if (pendingInvalidations.get(projectId) === teardown) {
      pendingInvalidations.delete(projectId);
    }
  }
  logger.info({ projectId }, 'collab: room invalidated');
  return true;
}

// For tests: drop all in-memory rooms (and their pending timers /
// shadow-save observers, so jest's open-handle detector stays
// happy across suites). Returns once every in-flight saver has
// settled.
export async function _resetCollabState(): Promise<void> {
  const snapshot = Array.from(rooms.values());
  rooms.clear();
  for (const room of snapshot) {
    if (room.idleTimer) clearTimeout(room.idleTimer);
    if (room.shadowSaver) await room.shadowSaver.destroy();
    room.doc.destroy();
  }
}
