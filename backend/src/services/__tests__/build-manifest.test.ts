// tests for the per-project PWA manifest written into each build.
// stageAppIcon shells out to ffmpeg and is covered by the build
// pipeline's own integration path; this suite pins the pure renderer,
// which is where the OS-facing contract lives.

import { renderManifest, resolveThemeColor } from '../build-manifest.js';

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

  // WCAG 1.3.4. This was 'portrait', which meant an installed story
  // refused to rotate on a device physically fixed in landscape — a
  // wheelchair-mounted tablet, a keyboard case, a car dock.
  it('never locks the installed app to one orientation', () => {
    const m = parse(renderManifest({ storyTitle: 'S', hasCustomIcon: false }));
    expect(m.orientation).not.toBe('portrait');
    expect(m.orientation).not.toBe('landscape');
    // Either 'any' or an absent key satisfies the spec's default.
    if (m.orientation !== undefined) expect(m.orientation).toBe('any');
  });

  describe('lang', () => {
    it('carries the project language', () => {
      const m = parse(renderManifest({ storyTitle: 'S', hasCustomIcon: false, language: 'pt-BR' }));
      expect(m.lang).toBe('pt-BR');
    });

    it('defaults to en when the project has no language set', () => {
      const m = parse(renderManifest({ storyTitle: 'S', hasCustomIcon: false }));
      expect(m.lang).toBe('en');
    });

    it('rejects a malformed tag rather than passing it to the OS', () => {
      const m = parse(
        renderManifest({ storyTitle: 'S', hasCustomIcon: false, language: 'not a tag' }),
      );
      expect(m.lang).toBe('en');
    });
  });

  // The generated index.html carries the same value in its theme-color
  // meta; exporting the resolution is what keeps the two in step.
  describe('resolveThemeColor', () => {
    it.each([
      [undefined, '#1a1a2e'],
      [{}, '#1a1a2e'],
      [{ themeColor: '#ff0000' }, '#ff0000'],
      // No explicit theme colour: the splash background is the better
      // guess than the player's default navy.
      [{ backgroundColor: '#abc' }, '#abc'],
      [{ backgroundColor: '#abc', themeColor: '#123456' }, '#123456'],
      // A malformed colour makes some Android launchers refuse the
      // install outright, so it never reaches the output.
      [{ themeColor: 'not-a-colour' }, '#1a1a2e'],
      [{ themeColor: 'not-a-colour', backgroundColor: '#abc' }, '#abc'],
    ])('resolves %p to %p', (icon, expected) => {
      expect(resolveThemeColor(icon)).toBe(expected);
    });

    // The generated index.html carries this value in its theme-color
    // meta. The two shipped different colours before, so pin that they
    // now come from one source.
    it('agrees with the manifest theme_color', () => {
      const icon = { backgroundColor: '#abc', themeColor: '#123456' };
      const m = parse(renderManifest({ storyTitle: 'S', hasCustomIcon: false, icon }));
      expect(resolveThemeColor(icon)).toBe(m.theme_color);
    });
  });
});
