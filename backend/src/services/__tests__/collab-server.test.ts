// Heavy-test ladder for the phase 1 WebSocket bridge.
// Spins up a real HTTP + WSS pair (no mocks) and exercises:
//   1. Two clients connect to the same room and see each other's edits
//   2. Unauthenticated upgrade requests get a 401
//
// Phase 1 deliberately scopes the test surface; reconnect-after-
// disconnect / server-restart scenarios depend on the phase 4
// persistence work and get tested there.

import { createServer, type Server as HttpServer } from 'http';
import express, { type RequestHandler } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { attachCollabServer, _resetCollabState } from '../collab-server.js';
import type { Pool } from 'pg';

function fakeSession(allow: boolean): RequestHandler {
  return (req, _res, next) => {
    if (allow) {
      (req as unknown as { session: { userId: string } }).session = {
        userId: '00000000-0000-0000-0000-000000000001',
      };
    }
    next();
  };
}

async function startServer(
  authAllowed = true,
  projectAllowed = true,
): Promise<{ server: HttpServer; wss: WebSocketServer; port: number }> {
  const app = express();
  const server = createServer(app);
  const wss = attachCollabServer(server, {
    pool: {} as Pool,
    sessionMiddleware: fakeSession(authAllowed),
    canAccessProject: async () => projectAllowed,
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port =
        typeof addr === 'object' && addr && 'port' in addr ? (addr as { port: number }).port : 0;
      resolve({ server, wss, port });
    });
  });
}

async function closeServer(s: { server: HttpServer; wss: WebSocketServer }): Promise<void> {
  // Kill any lingering sockets first so http.close doesn't hang.
  for (const ws of s.wss.clients) {
    try {
      ws.terminate();
    } catch {}
  }
  await new Promise<void>((resolve) => s.wss.close(() => resolve()));
  await new Promise<void>((resolve) => s.server.close(() => resolve()));
}

function makeProvider(
  port: number,
  projectId: string,
): { doc: Y.Doc; provider: WebsocketProvider } {
  const doc = new Y.Doc();
  // y-websocket appends `/${room}` to the base URL, so passing
  // `/ws/projects` here means the actual upgrade hits
  // `/ws/projects/<projectId>` which is what the server matches.
  const provider = new WebsocketProvider(`ws://localhost:${port}/ws/projects`, projectId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
  });
  return { doc, provider };
}

function waitForStatus(provider: WebsocketProvider, want: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (want === 'connected' && provider.wsconnected) return resolve();
    const timer = setTimeout(() => {
      provider.off('status', listener);
      reject(new Error(`provider did not reach status=${want} within ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = (event: { status: string }) => {
      if (event.status === want) {
        clearTimeout(timer);
        provider.off('status', listener);
        resolve();
      }
    };
    provider.on('status', listener);
  });
}

function waitFor<T>(check: () => T | undefined, timeoutMs = 3000, interval = 25): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const v = check();
      if (v !== undefined) {
        clearInterval(iv);
        resolve(v);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error('waitFor timed out'));
      }
    }, interval);
  });
}

describe('collab-server', () => {
  const PROJECT_ID = '11111111-2222-3333-4444-555555555555';

  let context: { server: HttpServer; wss: WebSocketServer; port: number } | null = null;

  afterEach(async () => {
    if (context) {
      await closeServer(context);
      context = null;
    }
    await _resetCollabState();
  });

  it("only clears the disconnecting socket's awareness state, not every peer's", async () => {
    // Regression for the presence bug: previously the cleanup
    // handler called removeAwarenessStates with every non-server
    // awareness id, so when A disconnected, B's awareness entry
    // was also removed and B disappeared from C's chips.
    context = await startServer();
    const a = makeProvider(context.port, PROJECT_ID);
    const b = makeProvider(context.port, PROJECT_ID);
    const c = makeProvider(context.port, PROJECT_ID);
    await waitForStatus(a.provider, 'connected');
    await waitForStatus(b.provider, 'connected');
    await waitForStatus(c.provider, 'connected');

    // Each peer publishes their identity.
    a.provider.awareness.setLocalStateField('user', { name: 'a' });
    b.provider.awareness.setLocalStateField('user', { name: 'b' });
    c.provider.awareness.setLocalStateField('user', { name: 'c' });

    // Wait for C to see both A and B.
    await waitFor(() => {
      const states = c.provider.awareness.getStates();
      return states.size >= 3 ? states : undefined;
    });

    // A disconnects.
    a.provider.destroy();

    // After A leaves, C should still see B's entry. The pre-fix
    // behavior was that A's disconnect wiped B's awareness too.
    await waitFor(() => {
      const states = c.provider.awareness.getStates();
      const names = Array.from(states.values()).map(
        (s) => (s as { user?: { name?: string } })?.user?.name,
      );
      return names.includes('b') ? names : undefined;
    });
    const names = Array.from(c.provider.awareness.getStates().values()).map(
      (s) => (s as { user?: { name?: string } })?.user?.name,
    );
    expect(names).toContain('b');
    expect(names).not.toContain('a');

    b.provider.destroy();
    c.provider.destroy();
  });

  it('relays edits between two connected clients in the same room', async () => {
    context = await startServer();
    const a = makeProvider(context.port, PROJECT_ID);
    const b = makeProvider(context.port, PROJECT_ID);
    await waitForStatus(a.provider, 'connected');
    await waitForStatus(b.provider, 'connected');

    a.doc.getText('shared').insert(0, 'hello from a');
    const got = await waitFor(() => {
      const txt = b.doc.getText('shared').toString();
      return txt.includes('hello from a') ? txt : undefined;
    });
    expect(got).toContain('hello from a');

    a.provider.destroy();
    b.provider.destroy();
  });

  it('rejects upgrades from authed users who lack project access with 403', async () => {
    context = await startServer(true, false);
    const got = await new Promise<{ code?: number }>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${context!.port}/ws/projects/${PROJECT_ID}`);
      ws.on('unexpected-response', (_req, res) => {
        resolve({ code: res.statusCode });
        try {
          ws.terminate();
        } catch {}
      });
      ws.on('open', () => {
        resolve({});
        try {
          ws.close();
        } catch {}
      });
      ws.on('error', () => {});
      setTimeout(() => resolve({}), 1500);
    });
    expect(got.code).toBe(403);
  });

  it('rejects unauthenticated upgrades with 401', async () => {
    context = await startServer(false);
    const got = await new Promise<{ code?: number }>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${context!.port}/ws/projects/${PROJECT_ID}`);
      ws.on('unexpected-response', (_req, res) => {
        resolve({ code: res.statusCode });
        try {
          ws.terminate();
        } catch {}
      });
      ws.on('open', () => {
        resolve({});
        try {
          ws.close();
        } catch {}
      });
      ws.on('error', () => {});
      setTimeout(() => resolve({}), 1500);
    });
    expect(got.code).toBe(401);
  });
});
