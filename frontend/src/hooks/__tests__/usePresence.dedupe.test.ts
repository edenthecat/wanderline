import { describe, expect, it } from 'vitest';
import { _dedupeByUserForTests as dedupeByUser } from '../usePresence';
import type { PresentUser } from '../usePresence';

// Reported: the avatars showing who else is in the project "flicker
// really rapidly, like a strobe light".
//
// A Y.js awareness clientID is per WebSocket, so it changes on every
// reconnect — flaky network, laptop waking, server restart, or the room
// being invalidated after someone re-uploads their ink. Presence was
// built one entry per connection and the chips were keyed on that id,
// so each reconnect unmounted a peer's chip and mounted a new one. A
// peer reconnecting in a loop strobes the strip. The same peer with two
// tabs open also drew two chips.

const peer = (over: Partial<PresentUser> & { clientId: number }): PresentUser => ({
  userId: 'u1',
  displayName: 'Bijan',
  color: '#ef4444',
  ...over,
});

describe('presence is per person, not per connection', () => {
  it('collapses one person on two connections into one chip', () => {
    const out = dedupeByUser([peer({ clientId: 1 }), peer({ clientId: 2 })]);
    expect(out).toHaveLength(1);
    expect(out[0].userId).toBe('u1');
  });

  it('keeps the lower clientId so a reconnect does not displace the chip', () => {
    // The surviving entry must not change identity just because the
    // peer opened a second, higher-numbered connection.
    expect(dedupeByUser([peer({ clientId: 5 }), peer({ clientId: 90 })])[0].clientId).toBe(5);
  });

  it("does not lose a peer's editing dot to their other tab", () => {
    const out = dedupeByUser([
      peer({ clientId: 1 }),
      peer({ clientId: 2, editingNodeId: 'inbox' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].editingNodeId).toBe('inbox');
  });

  it('still separates different people', () => {
    const out = dedupeByUser([
      peer({ clientId: 1, userId: 'u1', displayName: 'Bijan' }),
      peer({ clientId: 2, userId: 'u2', displayName: 'Eden' }),
    ]);
    expect(out.map((u) => u.userId)).toEqual(['u1', 'u2']);
  });

  it('keeps anonymous peers one per connection', () => {
    // The server's filter permits awareness with no userId; there is
    // nothing else to identify those by, so they cannot be collapsed.
    const out = dedupeByUser([
      peer({ clientId: 1, userId: undefined }),
      peer({ clientId: 2, userId: undefined }),
    ]);
    expect(out).toHaveLength(2);
  });
});
