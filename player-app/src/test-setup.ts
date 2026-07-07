import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock browser APIs not available in jsdom
vi.stubGlobal(
  'MediaMetadata',
  class MediaMetadata {
    title = '';
    artist = '';
    album = '';
    artwork: MediaImage[] = [];
    constructor(init?: MediaMetadataInit) {
      if (init) Object.assign(this, init);
    }
  },
);

// Mock matchMedia
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));
