import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The static manifest — the one the editor preview and a directly
// installed player use. Generated builds get their own document from
// backend/src/services/build-manifest.ts; this file is the other half
// of the same contract and drifted from it before.

// Resolved from the vitest root (the player-app workspace) rather than
// import.meta.url, which is an http:// URL under the jsdom environment.
const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'public/manifest.webmanifest'), 'utf-8'),
) as Record<string, unknown>;

describe('player manifest', () => {
  // WCAG 1.3.4. This was 'portrait', so an installed player refused to
  // rotate on a device physically fixed in landscape — a
  // wheelchair-mounted tablet, a keyboard case, a car dock.
  it('never locks the installed app to one orientation', () => {
    expect(manifest.orientation).not.toBe('portrait');
    expect(manifest.orientation).not.toBe('landscape');
    if (manifest.orientation !== undefined) expect(manifest.orientation).toBe('any');
  });
});
