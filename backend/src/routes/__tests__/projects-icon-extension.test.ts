// The stored icon filename becomes a storage key, which the local
// storage backend resolves to a real filesystem path — so the
// extension must never carry user-controlled text through.

import { safeIconExtension } from '../projects-icon.js';

describe('safeIconExtension', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
  ])('derives %s from the validated type, ignoring the filename', (mime, expected) => {
    expect(safeIconExtension(mime, 'anything-at-all.EXE')).toBe(expected);
  });

  // The fileFilter admits a file whose name matches the extension
  // allowlist even when the browser sent an unhelpful type, so the
  // filename path has to be safe on its own.
  it.each([
    ['icon.png', 'png'],
    ['icon.JPEG', 'jpeg'],
    ['../../etc/passwd', 'png'],
    ['C:\\Users\\me\\icon.png', 'png'],
    ['icon.p/n/g', 'png'],
    ['archive.tar.gz', 'gz'],
    ['icon.%2e%2e', '2e2e'],
    ['icon.', 'png'],
    ['noextension', 'png'],
    ['', 'png'],
  ])('sanitises %p to %p when the type is unknown', (name, expected) => {
    expect(safeIconExtension('application/octet-stream', name)).toBe(expected);
  });

  it('never emits a path separator or traversal', () => {
    for (const name of ['a./b', 'a.\\b', 'a...', 'a./../..']) {
      const ext = safeIconExtension('application/octet-stream', name);
      expect(ext).not.toMatch(/[/\\]/);
      expect(ext).not.toContain('..');
    }
  });

  it('caps a pathologically long extension', () => {
    expect(safeIconExtension('application/octet-stream', `x.${'a'.repeat(500)}`)).toHaveLength(8);
  });
});
