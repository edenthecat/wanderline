// Reported by an author: "wanderline keeps bringing back the old
// choices associated with the previous version of the intro", and
// "the start node isn't remembering my divert choices", leaving the
// story "trying to send players to choices that dont go anywhere now".
//
// The server side is correct. A REST edit or re-upload updates the row
// and then invalidates the collab room: the shadow saver's pending
// write is CANCELLED (not flushed), every socket is closed with 1012,
// and the next connection re-hydrates a fresh Y.Doc from the row.
//
// The client is the hole. Nothing in the frontend looks at the close
// code — y-websocket simply auto-reconnects carrying the SAME local
// Y.Doc, and on every open it sends sync step 1 from that doc. So the
// stale local state is pushed up into the freshly-hydrated server doc,
// Yjs merges both histories, and the shadow saver then materializes
// the merged result over story_graph.nodes — choices, diverts and all.
//
// These tests reproduce that at the CRDT level, which is where the bug
// actually lives; no websocket is involved in the mechanism.

import * as Y from 'yjs';
import { seedYDocFromStoryGraph, materializeNodesFromYDoc } from '../yjs-story.js';
import type { StoryGraph } from '../../types.js';

/** A one-knot story whose intro offers `choices` and falls to `divert`. */
function intro(choiceTargets: string[], divert: string | null): StoryGraph {
  return {
    id: 'g',
    title: 'T',
    startNode: 'intro',
    validation: { valid: true, errors: [], warnings: [] },
    nodes: {
      intro: {
        id: 'intro',
        type: 'knot',
        parent: null,
        lineNumber: 1,
        content: [{ text: 'The intro.', tags: [] }],
        choices: choiceTargets.map((t, i) => ({
          text: `Choice ${i + 1}`,
          target: t,
          sticky: false,
          fallback: false,
          tags: [],
        })),
        divert,
        tags: [],
      },
    },
  } as unknown as StoryGraph;
}

// Yjs breaks a concurrent write to the same Y.Map key by comparing
// client ids, so with random ids this reproduces only about two runs in
// three — which is exactly why the author sees it intermittently. Pin
// the ids so the stale doc always wins and the test is a real guard:
// the room the author's browser is still holding gets the HIGHER id.
const STALE_ID = 9_000_000;
const FRESH_ID = 1_000;

/** Both directions of the y-websocket sync handshake. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('a client reconnecting after its collab room was invalidated', () => {
  it('does not resurrect the intro the author replaced', () => {
    // The author is editing with the browser open, so a client doc is
    // live and synced against the room.
    const serverBefore = new Y.Doc();
    serverBefore.clientID = STALE_ID;
    seedYDocFromStoryGraph(serverBefore, intro(['old_a', 'old_b'], 'old_credits'));
    const client = new Y.Doc();
    sync(serverBefore, client);

    // They re-upload the ink. The row is replaced, the room is torn
    // down, and the next connection hydrates a brand-new doc from the
    // NEW row. This is exactly what invalidateRoom + hydrateRoomFromDb
    // do today.
    serverBefore.destroy();
    const serverAfter = new Y.Doc();
    serverAfter.clientID = FRESH_ID;
    seedYDocFromStoryGraph(serverAfter, intro(['new_a'], 'new_credits'));

    // The browser is still open. y-websocket reconnects and sends sync
    // step 1 from the doc it never threw away.
    sync(serverAfter, client);

    const merged = materializeNodesFromYDoc(serverAfter).intro;
    expect(merged.divert).toBe('new_credits');
    expect(merged.choices.map((c) => c.target)).toEqual(['new_a']);
  });

  it('does not resurrect a choice the author deleted', () => {
    // Narrower shape, same cause: the count is what regresses, so a
    // passage the author simplified goes back to offering a target
    // that no longer exists anywhere in the story.
    const serverBefore = new Y.Doc();
    serverBefore.clientID = STALE_ID;
    seedYDocFromStoryGraph(serverBefore, intro(['keep', 'deleted'], null));
    const client = new Y.Doc();
    sync(serverBefore, client);

    serverBefore.destroy();
    const serverAfter = new Y.Doc();
    serverAfter.clientID = FRESH_ID;
    seedYDocFromStoryGraph(serverAfter, intro(['keep'], null));

    sync(serverAfter, client);

    expect(materializeNodesFromYDoc(serverAfter).intro.choices.map((c) => c.target)).toEqual([
      'keep',
    ]);
  });
});
