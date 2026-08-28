import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeTab from '../ThemeTab';

// The Theme tab used to let an author ship an unreadable pair with no
// warning anywhere: no contrast maths in the editor, and a backend
// that sanitised control characters and angle brackets before writing
// the value straight into --wl-text / --wl-page-bg. Set both to the
// same colour and the first person to discover it was a listener.
//
// These cover the wiring, not the arithmetic — the ratios themselves
// are pinned in player-app/src/theme-contrast.test.ts against the same
// shared implementation.

vi.mock('../../api/client', () => ({
  fetchProjectSettings: vi.fn(),
  updateProjectSettings: vi.fn(),
}));

// FontPicker fetches the Google Fonts catalog on mount; irrelevant here.
vi.mock('../../api/google-fonts', () => ({
  CATEGORY_LABEL: {},
  buildCatalogFontsUrl: () => '',
  filterFonts: () => [],
}));

const { fetchProjectSettings, updateProjectSettings } = await import('../../api/client');
const mockedFetch = vi.mocked(fetchProjectSettings);
const mockedUpdate = vi.mocked(updateProjectSettings);

function mount(theme: Record<string, unknown> = {}) {
  const settings = { theme };
  mockedFetch.mockResolvedValue({ settings } as never);
  mockedUpdate.mockResolvedValue({ settings } as never);
  return render(<ThemeTab projectId="p1" />);
}

beforeEach(() => {
  mockedFetch.mockReset();
  mockedUpdate.mockReset();
});

afterEach(cleanup);

describe('Theme tab contrast warning', () => {
  it('stays quiet on the shipped defaults', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Colors (global)')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('theme-contrast-warning')).toBeNull());
    expect(screen.queryByTestId('theme-contrast-unknown')).toBeNull();
  });

  it('warns when body text and page background are the same colour', async () => {
    mount({ variables: { textColor: '#336699', pageBackground: '#336699' } });
    const warning = await screen.findByTestId('theme-contrast-warning');
    expect(warning).toHaveTextContent(/Body text on the page background/);
    // The measured ratio is shown, so the author can see how far off
    // they are rather than just being told "no".
    expect(warning).toHaveTextContent(/1\.00:1/);
    expect(warning).toHaveTextContent(/needs 4\.5:1/);
  });

  it('warns when only the page is changed and the default text no longer suits it', async () => {
    // The unset-knob case: nothing in `variables` says what the text
    // colour is, so the check has to resolve it to the player default
    // rather than treat it as absent.
    mount({ variables: { pageBackground: '#ffffff' } });
    const warning = await screen.findByTestId('theme-contrast-warning');
    expect(warning).toHaveTextContent(/Body text on the page background/);
  });

  // The per-component panels live in this same tab and win in the
  // player's CSS, so a check that looked only at the global knobs
  // would clear a palette the listener can't read.
  it('warns about a per-component override, not just the global knobs', async () => {
    mount({ components: { page: { background: '#ffffff' } } });
    const warning = await screen.findByTestId('theme-contrast-warning');
    expect(warning).toHaveTextContent(/Body text on the page background/);
  });

  it('says so when it could not read a colour, rather than staying silent', async () => {
    mount({ variables: { pageBackground: 'oklch(0.95 0.02 250)' } });
    const unknown = await screen.findByTestId('theme-contrast-unknown');
    expect(unknown).toHaveTextContent(/oklch\(0\.95 0\.02 250\)/);
    // And it isn't dressed up as a measured failure.
    expect(screen.queryByTestId('theme-contrast-warning')).toBeNull();
  });

  // Polite, not assertive: this recomputes as the author types into a
  // colour field, and an alert would cut them off mid-word.
  it('announces politely rather than interrupting', async () => {
    mount({ variables: { textColor: '#336699', pageBackground: '#336699' } });
    const warning = await screen.findByTestId('theme-contrast-warning');
    expect(warning).toHaveAttribute('role', 'status');
  });
});
