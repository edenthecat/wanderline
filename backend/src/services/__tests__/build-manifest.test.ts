// tests for the per-project PWA manifest written into each build.
// stageAppIcon shells out to ffmpeg and is covered by the build
// pipeline's own integration path; this suite pins the pure renderer,
// which is where the OS-facing contract lives.

import { renderManifest } from '../build-manifest.js';

function parse(json: string) {
  return JSON.parse(json) as Record<string, unknown>;
}

describe('renderManifest', () => {
  it('names the app after the story, not Wanderline', () => {
    const m = parse(renderManifest({ storyTitle: 'Ghost Radio', hasCustomIcon: false }));
    expect(m.name).toBe('Ghost Radio');
    expect(m.short_name).toBe('Ghost Radio');
  });

  // Home-screen labels truncate around 12 characters; better to
  // shorten deliberately than let the OS cut mid-word.
  it('truncates a long short_name', () => {
    const m = parse(
      renderManifest({ storyTitle: 'An Extremely Long Story Title', hasCustomIcon: false }),
    );
    expect((m.short_name as string).length).toBeLessThanOrEqual(12);
    expect(m.name).toBe('An Extremely Long Story Title');
  });

  it('points at the custom icon only when one was staged', () => {
    const withIcon = parse(renderManifest({ storyTitle: 'S', hasCustomIcon: true }));
    const without = parse(renderManifest({ storyTitle: 'S', hasCustomIcon: false }));
    const src = (m: Record<string, unknown>) =>
      (m.icons as Array<{ src: string }>).map((i) => i.src);
    expect(src(withIcon).every((s) => s.startsWith('./icons/app-'))).toBe(true);
    expect(src(without).every((s) => s.startsWith('./icon-'))).toBe(true);
  });

  it('honours author colours', () => {
    const m = parse(
      renderManifest({
        storyTitle: 'S',
        hasCustomIcon: false,
        icon: { backgroundColor: '#ffeecc', themeColor: '#123' },
      }),
    );
    expect(m.background_color).toBe('#ffeecc');
    expect(m.theme_color).toBe('#123');
  });

  // A malformed colour makes some Android launchers refuse the
  // install outright, so anything that isn't a hex literal is dropped
  // rather than passed through.
  it.each(['red', 'rgb(0,0,0)', '#12345', 'javascript:alert(1)', ''])(
    'rejects invalid colour %p',
    (backgroundColor) => {
      const m = parse(
        renderManifest({ storyTitle: 'S', hasCustomIcon: false, icon: { backgroundColor } }),
      );
      expect(m.background_color).toBe('#1a1a2e');
    },
  );

  it('defaults theme_color to the background when unset', () => {
    const m = parse(
      renderManifest({ storyTitle: 'S', hasCustomIcon: false, icon: { backgroundColor: '#abc' } }),
    );
    expect(m.theme_color).toBe('#abc');
  });

  it('falls back to a usable name for an empty title', () => {
    const m = parse(renderManifest({ storyTitle: '   ', hasCustomIcon: false }));
    expect(m.name).toBe('Audio narrative');
  });

  // Android crops to the launcher shape only when a maskable icon is
  // offered; without it the artwork gets a white circle around it.
  it('offers a maskable icon', () => {
    const m = parse(renderManifest({ storyTitle: 'S', hasCustomIcon: true }));
    const purposes = (m.icons as Array<{ purpose: string }>).map((i) => i.purpose);
    expect(purposes).toContain('maskable');
  });
});
