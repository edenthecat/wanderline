import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioFileUrl, removeAudioAssignment, replaceAudioTake, setSfxOffset } from '../client';

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

describe('new takes', () => {
  it('posts the file to the replace route', async () => {
    const file = new File(['x'], 'take.mp3', { type: 'audio/mpeg' });
    await replaceAudioTake('p1', 'f1', file);
    expect(path()).toBe('/api/projects/p1/audio/f1/replace');
    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('audio')).toBeInstanceOf(File);
  });

  // Multer errors used to come back as an HTML 500, and over HTTP/2
  // statusText is empty: the editor then showed nothing at all.
  it('never throws a blank message', async () => {
    fetchMock.mockResolvedValue(new Response('<html>oops</html>', { status: 500, statusText: '' }));
    await expect(replaceAudioTake('p1', 'f1', new File(['x'], 't.mp3'))).rejects.toThrow(
      'Upload failed (500)',
    );
  });

  it('versions the audition URL so a new take isn’t played from cache', () => {
    expect(audioFileUrl('p1', 'f1')).toBe('/api/projects/p1/audio/file/f1');
    expect(audioFileUrl('p1', 'f1', 'a b.mp3')).toBe('/api/projects/p1/audio/file/f1?v=a%20b.mp3');
  });
});
