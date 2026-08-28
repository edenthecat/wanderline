// Navigation accessibility for the project workspace.
//
// Below 767px the desktop sidebar is display:none, so the mobile
// bottom-bar sheet is the ONLY way to change tab. It used to be
// rendered inside an aria-hidden="true" backdrop, which took the
// sheet, its heading and every one of its buttons out of the
// accessibility tree while leaving them in the tab order — the editor
// could not be navigated at all with a screen reader at that width.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ProjectDetail } from '../../api/client';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  const project: ProjectDetail = {
    id: 'p1',
    name: 'Nightjar',
    description: null,
    owner_id: 'u1',
    story_graph: null,
    ink_source: null,
    twee_source: null,
    source_language: 'ink',
    settings: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  return { ...actual, fetchProject: vi.fn().mockResolvedValue({ project }) };
});

// The page is nav plumbing; the tabs themselves are covered by their
// own tests, and mounting them here would drag in codemirror, the
// collab socket and a dozen fetches for no added coverage.
vi.mock('../../components/StoryTab', () => ({ default: () => <div data-testid="tab-story" /> }));
vi.mock('../../components/AudioTab', () => ({ default: () => <div data-testid="tab-audio" /> }));
vi.mock('../../components/MusicTab', () => ({ default: () => <div data-testid="tab-music" /> }));
vi.mock('../../components/CharactersTab', () => ({
  default: () => <div data-testid="tab-characters" />,
}));
vi.mock('../../components/BuildsTab', () => ({ default: () => <div data-testid="tab-builds" /> }));
vi.mock('../../components/HistoryTab', () => ({
  default: () => <div data-testid="tab-history" />,
}));
vi.mock('../../components/SettingsTab', () => ({
  default: () => <div data-testid="tab-settings" />,
}));
vi.mock('../../components/PreviewTab', () => ({
  default: () => <div data-testid="tab-preview" />,
}));
vi.mock('../../components/GraphTab', () => ({ default: () => <div data-testid="tab-graph" /> }));
vi.mock('../../components/ThemeTab', () => ({ default: () => <div data-testid="tab-theme" /> }));
vi.mock('../../components/VolumesTab', () => ({
  default: () => <div data-testid="tab-volumes" />,
}));
vi.mock('../../components/SystemSoundsTab', () => ({
  default: () => <div data-testid="tab-systemSounds" />,
}));
vi.mock('../../components/HeadphoneControlsTab', () => ({
  default: () => <div data-testid="tab-headphone" />,
}));
vi.mock('../../components/PlayerDisplayTab', () => ({
  default: () => <div data-testid="tab-playerDisplay" />,
}));
vi.mock('../../components/EditableProjectTitle', () => ({
  default: ({ name }: { name: string }) => <h1>{name}</h1>,
}));

vi.mock('../../hooks/useYjs', () => ({
  useYjs: () => ({ doc: null, awareness: null, status: 'disconnected' }),
}));
vi.mock('../../hooks/useYjsUndo', () => ({ useYjsUndo: () => {} }));
vi.mock('../../hooks/usePresence', () => ({ usePresence: () => [] }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', displayName: 'Ren' } }),
}));

import ProjectDetailPage from '../ProjectDetailPage';

async function renderPage() {
  const utils = render(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Nightjar' });
  return utils;
}

/** The four bottom-bar group buttons, which only exist on mobile. */
function mobileNav() {
  return screen.getByRole('navigation', { name: 'Project sections (mobile)' });
}

/** The open sheet. Scoped queries matter: the desktop sidebar renders
 * the same tab labels, and jsdom applies no CSS so both are present. */
function sheet(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.workspace-mobile-sheet');
  if (!el) throw new Error('no open mobile sheet');
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.title = '';
});

describe('ProjectDetailPage navigation accessibility', () => {
  it('exposes the mobile sheet to assistive tech instead of hiding it', async () => {
    const { container } = await renderPage();

    fireEvent.click(within(mobileNav()).getByRole('button', { name: 'Sound' }));

    const backdrop = container.querySelector('.workspace-mobile-sheet-backdrop');
    expect(backdrop).toBeTruthy();
    // The whole bug in one assertion: nothing on the path from the
    // page root to the sheet's buttons may be aria-hidden.
    expect(backdrop?.getAttribute('aria-hidden')).toBeNull();

    // ...and the buttons inside it are reachable by accessible name,
    // which they were not while an ancestor was aria-hidden.
    const music = within(sheet()).getByRole('button', { name: 'Music' });
    expect(music.closest('.workspace-mobile-sheet-backdrop')).toBe(backdrop);
    for (const el of [music, sheet(), ...sheet().querySelectorAll('*')]) {
      expect(el.closest('[aria-hidden="true"]')).toBeNull();
    }
  });

  it('switches tab from the mobile sheet', async () => {
    await renderPage();
    expect(screen.getByTestId('tab-story')).toBeTruthy();

    fireEvent.click(within(mobileNav()).getByRole('button', { name: 'Sound' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Music' }));

    expect(screen.getByTestId('tab-music')).toBeTruthy();
    expect(document.querySelector('.workspace-mobile-sheet')).toBeNull();
  });

  // role="menu" promises arrow-key roving focus, Home/End and focus
  // moved in on open. None of that was implemented, and an
  // unimplemented menu is worse than no menu. These are disclosures.
  it('uses disclosure semantics, not an unimplemented menu', async () => {
    await renderPage();

    const exportBtn = screen.getByRole('button', { name: 'Export' });
    expect(exportBtn.getAttribute('aria-haspopup')).toBeNull();
    expect(exportBtn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(exportBtn);
    expect(exportBtn).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(within(mobileNav()).getByRole('button', { name: 'Ship' }));

    expect(screen.queryAllByRole('menu')).toHaveLength(0);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('moves focus into the sheet on open and back to the trigger on Escape', async () => {
    await renderPage();

    const soundBtn = within(mobileNav()).getByRole('button', { name: 'Sound' });
    fireEvent.click(soundBtn);
    // First tool in the group. The sheet renders after the bottom bar
    // in the DOM, so Tab alone walks the other groups first.
    await waitFor(() =>
      expect(document.activeElement).toBe(within(sheet()).getByRole('button', { name: 'Audio' })),
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.workspace-mobile-sheet')).toBeNull());
    expect(document.activeElement).toBe(soundBtn);
  });

  // The whole <main> swaps on a tab change and nothing said so: no
  // aria-controls, no focus move, and the one element naming the
  // current view was a plain span (and is display:none on mobile).
  it('announces and focuses the panel when the tab changes', async () => {
    await renderPage();

    const panel = document.getElementById('workspace-panel');
    expect(panel).toBeTruthy();
    const graphBtn = screen.getAllByRole('button', { name: 'Graph' })[0];
    expect(graphBtn).toHaveAttribute('aria-controls', 'workspace-panel');

    fireEvent.click(graphBtn);

    await waitFor(() => expect(document.activeElement).toBe(panel));
    expect(panel).toHaveAttribute('aria-label', 'Graph panel');
    // Live region so the swap is announced even when focus is
    // somewhere else entirely.
    expect(screen.getByRole('status')).toHaveTextContent('Graph');
  });

  it('names the document after the current view, and restores it on leaving', async () => {
    document.title = 'Wanderline';
    const { unmount } = await renderPage();
    await waitFor(() => expect(document.title).toBe('Story · Nightjar · Wanderline'));

    fireEvent.click(screen.getAllByRole('button', { name: 'Builds' })[0]);
    await waitFor(() => expect(document.title).toBe('Builds · Nightjar · Wanderline'));

    // A title that lies after you navigate away is worse than the
    // generic one it replaced.
    unmount();
    expect(document.title).toBe('Wanderline');
  });

  // The backdrop is an opaque fixed scrim, so everything behind it is
  // dimmed and unclickable — but still focusable, and still fires on
  // Enter, since the outside-click handler only listens for mousedown.
  it('keeps Tab inside the open sheet', async () => {
    await renderPage();
    fireEvent.click(within(mobileNav()).getByRole('button', { name: 'Style' }));

    const links = Array.from(sheet().querySelectorAll<HTMLButtonElement>('button'));
    expect(links.length).toBeGreaterThan(1);
    const first = links[0];
    const last = links[links.length - 1];

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
