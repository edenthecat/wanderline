import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewTab from '../PreviewTab';
import * as client from '../../api/client';

// "Preview from here": the editor pins the preview to a passage and
// the player opens on it. Without this a reviewer verifying a fix
// forty minutes into a story had to play the forty minutes again.

beforeEach(() => {
  vi.spyOn(client, 'fetchMe').mockResolvedValue({} as Awaited<ReturnType<typeof client.fetchMe>>);
});

afterEach(() => vi.restoreAllMocks());

function renderTab(props: Partial<React.ComponentProps<typeof PreviewTab>> = {}) {
  return render(
    <MemoryRouter>
      <PreviewTab projectId="p1" hasStory {...props} />
    </MemoryRouter>,
  );
}

const frame = () => screen.getByTitle('Story preview') as HTMLIFrameElement;

describe('PreviewTab — starting from a passage', () => {
  it('previews the whole story when nothing is pinned', async () => {
    renderTab();
    await waitFor(() => expect(frame().getAttribute('src')).toBe('/api/projects/p1/preview'));
  });

  it('passes the pinned passage to the player', async () => {
    renderTab({ startNodeId: 'tell_you.middle', startRequestNonce: 1 });
    await waitFor(() =>
      expect(frame().getAttribute('src')).toBe('/api/projects/p1/preview?start=tell_you.middle'),
    );
  });

  // A node id is author-chosen text. Encoding is what keeps one with a
  // & or a # in it from truncating the parameter.
  it('encodes a passage id that needs it', async () => {
    renderTab({ startNodeId: 'a&b c', startRequestNonce: 1 });
    await waitFor(() =>
      expect(frame().getAttribute('src')).toBe('/api/projects/p1/preview?start=a%26b%20c'),
    );
  });

  // Popping the preview out must not lose the passage that was asked
  // for, or the reviewer lands at the top of the story again.
  it('carries the pin into "Open in new tab"', async () => {
    renderTab({ startNodeId: 'tell_you.middle', startRequestNonce: 1 });
    await waitFor(() =>
      expect(screen.getByText('Open in new tab').getAttribute('href')).toBe(
        '/api/projects/p1/preview?start=tell_you.middle',
      ),
    );
  });

  it('names the pinned passage on screen', async () => {
    renderTab({ startNodeId: 'tell_you.middle', startRequestNonce: 1 });
    expect(await screen.findByText('tell_you.middle')).toBeTruthy();
  });

  // The review loop is: hear the problem, fix the take, hear it again.
  // The second "Preview from here" click names the SAME passage, so
  // comparing ids alone would make it do nothing.
  it('re-mounts the player when the same passage is asked for again', async () => {
    const { rerender } = renderTab({ startNodeId: 'tell_you.middle', startRequestNonce: 1 });
    await waitFor(() => expect(frame()).toBeTruthy());
    const before = frame();
    rerender(
      <MemoryRouter>
        <PreviewTab projectId="p1" hasStory startNodeId="tell_you.middle" startRequestNonce={2} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(frame()).not.toBe(before));
  });

  it('re-mounts the player when a different passage is asked for', async () => {
    const { rerender } = renderTab({ startNodeId: 'tell_you.middle', startRequestNonce: 1 });
    await waitFor(() => expect(frame()).toBeTruthy());
    rerender(
      <MemoryRouter>
        <PreviewTab projectId="p1" hasStory startNodeId="tell_you.ending" startRequestNonce={2} />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(frame().getAttribute('src')).toBe('/api/projects/p1/preview?start=tell_you.ending'),
    );
  });

  // Restart replays what the preview is set to. Being dropped back at
  // the top of a long story is the exact cost this feature removes.
  it('restarts from the pinned passage', async () => {
    renderTab({ startNodeId: 'tell_you.middle', startRequestNonce: 1 });
    const restart = await screen.findByLabelText('Restart preview from tell_you.middle');
    const before = frame();
    fireEvent.click(restart);
    await waitFor(() => expect(frame()).not.toBe(before));
    expect(frame().getAttribute('src')).toBe('/api/projects/p1/preview?start=tell_you.middle');
  });

  it('drops the pin when asked for the beginning', async () => {
    renderTab({ startNodeId: 'tell_you.middle', startRequestNonce: 1 });
    fireEvent.click(
      await screen.findByLabelText('Play the preview from the beginning of the story'),
    );
    await waitFor(() => expect(frame().getAttribute('src')).toBe('/api/projects/p1/preview'));
    expect(screen.getByLabelText('Restart preview from the start')).toBeTruthy();
  });

  it('offers no "from the beginning" control when nothing is pinned', async () => {
    renderTab();
    await waitFor(() => expect(frame()).toBeTruthy());
    expect(screen.queryByLabelText('Play the preview from the beginning of the story')).toBeNull();
  });
});
