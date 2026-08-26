import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import VersionBadge from '../VersionBadge';
import * as client from '../../api/client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VersionBadge', () => {
  it('shows the running version', async () => {
    vi.spyOn(client, 'fetchAppVersion').mockResolvedValue({
      version: '1.4.0',
      commit: '4b8fd0c',
      environment: 'production',
    });
    render(<VersionBadge />);
    expect(await screen.findByText('v1.4.0')).toBeTruthy();
  });

  // The commit is what distinguishes two deploys of the same semver —
  // exactly the case that made the drift hard to spot — so it must
  // survive into the tooltip.
  it('exposes commit and environment in the title', async () => {
    vi.spyOn(client, 'fetchAppVersion').mockResolvedValue({
      version: '1.4.0',
      commit: '4b8fd0c',
      environment: 'production',
    });
    render(<VersionBadge />);
    const badge = await screen.findByText('v1.4.0');
    expect(badge.getAttribute('title')).toContain('commit 4b8fd0c');
    expect(badge.getAttribute('title')).toContain('environment production');
  });

  it('calls out a non-production environment inline', async () => {
    vi.spyOn(client, 'fetchAppVersion').mockResolvedValue({
      version: '1.4.0',
      commit: null,
      environment: 'development',
    });
    render(<VersionBadge />);
    expect(await screen.findByText('development')).toBeTruthy();
  });

  it('stays out of the way in production', async () => {
    vi.spyOn(client, 'fetchAppVersion').mockResolvedValue({
      version: '1.4.0',
      commit: null,
      environment: 'production',
    });
    render(<VersionBadge />);
    await screen.findByText('v1.4.0');
    expect(screen.queryByText('production')).toBeNull();
  });

  // A version badge is garnish; a backend hiccup must not turn the
  // editor chrome into an error.
  it('renders nothing when the endpoint fails', async () => {
    vi.spyOn(client, 'fetchAppVersion').mockRejectedValue(new Error('boom'));
    const { container } = render(<VersionBadge />);
    await waitFor(() => expect(container.querySelector('.version-badge')).toBeNull());
  });
});
