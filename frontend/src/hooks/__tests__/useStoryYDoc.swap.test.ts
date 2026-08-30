import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as Y from 'yjs';
import { useYjsSeedReady } from '../useStoryYDoc';

// useYjs replaces the Y.Doc when the server invalidates the collab room
// after a destructive write. The replacement arrives EMPTY and seeds
// asynchronously from the server.
//
// `ready` gates every collaborative input: false means fall back to the
// uncontrolled REST branch, which is keyed on its initial text, so a
// focused author loses their caret and stops seeing peers' edits. It
// used to be a one-way latch — the only reset sat behind `!doc`, which
// a doc -> doc swap never hits — so it stayed true from the previous
// doc while the new one was empty, and the observer's setReady(true)
// became a same-value set React bails out of. Collaboration was then
// silently dead for the rest of the session.

function seed(doc: Y.Doc, id = 'intro') {
  doc.getMap<Y.Map<unknown>>('nodes').set(id, new Y.Map());
}

describe('useYjsSeedReady across a doc swap', () => {
  it('goes false when an empty replacement doc arrives', () => {
    const seeded = new Y.Doc();
    seed(seeded);
    const { result, rerender } = renderHook(({ doc }) => useYjsSeedReady(doc), {
      initialProps: { doc: seeded },
    });
    expect(result.current).toBe(true);

    // The server invalidated the room; useYjs hands over a fresh doc
    // that has not been seeded yet.
    const replacement = new Y.Doc();
    rerender({ doc: replacement });
    expect(result.current).toBe(false);
  });

  it('goes true again once the replacement seeds', () => {
    const seeded = new Y.Doc();
    seed(seeded);
    const { result, rerender } = renderHook(({ doc }) => useYjsSeedReady(doc), {
      initialProps: { doc: seeded },
    });

    const replacement = new Y.Doc();
    rerender({ doc: replacement });
    expect(result.current).toBe(false);

    act(() => {
      seed(replacement);
    });
    expect(result.current).toBe(true);
  });

  it('stays true when the replacement already carries the story', () => {
    // A doc that hydrated before React observed it must not flicker the
    // inputs into their REST fallback for a render.
    const a = new Y.Doc();
    seed(a);
    const b = new Y.Doc();
    seed(b);
    const { result, rerender } = renderHook(({ doc }) => useYjsSeedReady(doc), {
      initialProps: { doc: a },
    });
    rerender({ doc: b });
    expect(result.current).toBe(true);
  });
});
