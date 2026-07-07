// vitest setup for the editor frontend.
//
// - jest-dom adds React Testing Library's semantic matchers
//   (toBeInTheDocument, toHaveTextContent, etc.).
// - matchMedia + ResizeObserver are stubbed because jsdom doesn't
//   ship them and several editor components read them on mount
//   (theme detection, split-pane sizing).

import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

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

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
