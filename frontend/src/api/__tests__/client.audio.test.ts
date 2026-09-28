import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeAudioAssignment, setSfxOffset } from '../client';

// Node ids are free text: a Twee passage can be named "Left/Right" or
// "What now?". Unencoded, the first misses the route and the second
// loses everything after the "?".

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const path = () => new URL(String(fetchMock.mock.calls[0][0]), 'http://x').pathname;

describe('audio assignment paths', () => {
  it('encodes the node id when clearing a slot', async () => {
    await removeAudioAssignment('p1', 'What now?/Left', 'ambience', 'f1');
    expect(path()).toMatch(/\/assignments\/What%20now%3F%2FLeft\/ambience$/);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\?audioFileId=f1$/);
  });

  it('encodes the node id when timing an effect', async () => {
    await setSfxOffset('p1', '50%', 'f1', 1000);
    expect(path()).toMatch(/\/assignments\/50%25\/sfx\/f1$/);
  });
});
