import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetPreviewCachesForTests, renderPreviewHtml } from '../projects-preview.js';
import { COMPONENT_SPECS, type ComponentId } from '@wanderline/shared';

// End-to-end integration test for the theme injection pipeline: the
// unit tests in services/__tests__/theme-render.test.ts prove that
// each helper (renderThemeCss / renderThemeForPreview) emits the
// right CSS variables in isolation; the tests here prove they actually
// reach the served preview HTML — with the correct CSP nonce, in the
// right position, and alongside the story payload — for every knob
// the theme editor exposes. If someone deletes the theme injection
// line in renderPreviewHtml, the unit tests still pass; this file is
// what catches it.

let tmpDist: string;
let prevPlayerDist: string | undefined;

beforeAll(() => {
  tmpDist = mkdtempSync(join(tmpdir(), 'wanderline-preview-theme-'));
  mkdirSync(join(tmpDist, 'assets'), { recursive: true });
  // Vite-shaped shell — must include a <head> so themeFragment has an
  // insertion point, and a script tag that matches the SRI injector's
  // regex so we don't leave the template mid-transform.
  writeFileSync(
    join(tmpDist, 'index.html'),
    `<!doctype html><html><head><title>Player</title><script type="module" crossorigin src="./assets/index-abcdef.js"></script></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(tmpDist, 'assets', 'index-abcdef.js'), '/* fake bundle */');
  writeFileSync(
    join(tmpDist, 'bundle-info.json'),
    JSON.stringify({
      version: '0.1.0-test',
      mainScript: 'assets/index-abcdef.js',
      sriAlgorithm: 'sha384',
      sriHash: 'sha384-fakebundlehashformatchingassertions',
      scripts: [
        {
          path: 'assets/index-abcdef.js',
          sriHash: 'sha384-fakebundlehashformatchingassertions',
          sizeBytes: 12,
        },
      ],
    }),
  );
  prevPlayerDist = process.env.PLAYER_DIST;
  process.env.PLAYER_DIST = tmpDist;
  _resetPreviewCachesForTests();
});

afterAll(() => {
  process.env.PLAYER_DIST = prevPlayerDist;
  rmSync(tmpDist, { recursive: true, force: true });
  _resetPreviewCachesForTests();
});

// Build a storyData payload with a theme covering every author-facing
// knob: all seven globals, both fonts + weight arrays, customCss, and
// every declared component × prop. Values are markers so the
// assertions below can find them uniquely.
function buildFullyThemedStoryData() {
  const components: Partial<Record<ComponentId, Record<string, string>>> = {};
  for (const spec of COMPONENT_SPECS) {
    components[spec.id] = Object.fromEntries(spec.props.map((p) => [p.key, `E2E-${p.key}`]));
  }
  return {
    id: 'story-1',
    title: 'Dear Anna',
    audioBaseUrl: './audio/',
    startNode: 'start',
    nodes: {
      start: {
        id: 'start',
        type: 'knot',
        content: [],
        choices: [],
        divert: null,
        tags: [],
        audio: {},
      },
    },
    settings: {
      theme: {
        variables: {
          pageBackground: '#0a0a0a',
          cardBackground: '#111111',
          textColor: '#eaeaea',
          accentColor: '#4ecdc4',
          headingColor: '#ffffff',
          chromeColor: '#909090',
          iconColor: '#dddddd',
        },
        bodyFont: 'Inter',
        bodyFontWeights: ['300', '600'],
        headingFont: 'Playfair Display',
        headingFontWeights: ['700', '900'],
        customCss: '.wl-preview-banner { display: none; }',
        components,
      },
    },
  };
}

describe('renderPreviewHtml — theme injection', () => {
  const NONCE = 'THEME-NONCE-XYZ';

  it('injects a <style data-wanderline-theme> block with the CSP nonce', () => {
    const html = renderPreviewHtml(buildFullyThemedStoryData(), 'T', 'Preview', NONCE);
    expect(html).toContain(`<style nonce="${NONCE}" data-wanderline-theme>`);
  });

  it('emits every global CSS variable inside the theme <style> block', () => {
    const html = renderPreviewHtml(buildFullyThemedStoryData(), 'T', 'Preview', NONCE);
    for (const [line] of [
      ['--wl-page-bg: #0a0a0a;'],
      ['--wl-card-bg: #111111;'],
      ['--wl-text: #eaeaea;'],
      ['--wl-accent: #4ecdc4;'],
      ['--wl-heading: #ffffff;'],
      ['--wl-chrome: #909090;'],
      ['--wl-icon-color: #dddddd;'],
    ] as Array<[string]>) {
      expect(html).toContain(line);
    }
  });

  it('emits every font variable + Google Fonts link (with weight params) in the head', () => {
    const html = renderPreviewHtml(buildFullyThemedStoryData(), 'T', 'Preview', NONCE);
    expect(html).toContain('--wl-font-body: Inter;');
    expect(html).toContain("--wl-font-heading: 'Playfair Display';");
    expect(html).toContain('--wl-font-body-weight: 300;');
    expect(html).toContain('--wl-font-heading-weight: 700;');
    // Google Fonts <link>.
    expect(html).toContain('https://fonts.googleapis.com/css2?family=Inter:wght@300;600');
    expect(html).toContain('family=Playfair+Display:wght@700;900');
    expect(html).toContain('<link rel="preconnect" href="https://fonts.googleapis.com">');
    expect(html).toContain('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
  });

  it('appends customCss after the :root block', () => {
    const html = renderPreviewHtml(buildFullyThemedStoryData(), 'T', 'Preview', NONCE);
    expect(html).toContain('.wl-preview-banner { display: none; }');
    // customCss must live inside the same nonce'd style block, AFTER
    // the :root declarations — otherwise author overrides couldn't
    // win over the variables.
    const styleBlock =
      /<style nonce="[^"]+" data-wanderline-theme>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    expect(styleBlock).toMatch(/:root \{[\s\S]*?\}[\s\S]*wl-preview-banner/);
  });

  // Exhaustive per-component × prop enumeration. If someone adds a
  // knob to COMPONENT_SPECS but forgets to wire the emitter (or breaks
  // the injection into the preview head), this loop catches it.
  describe('per-component overrides land in the preview HTML', () => {
    for (const spec of COMPONENT_SPECS) {
      for (const prop of spec.props) {
        it(`--wl-${spec.id}-${prop.key} present with author value`, () => {
          const html = renderPreviewHtml(buildFullyThemedStoryData(), 'T', 'Preview', NONCE);
          expect(html).toContain(`--wl-${spec.id}-${prop.key}: E2E-${prop.key};`);
        });
      }
    }
  });

  it('inlines the resolved story title in window.__WANDERLINE_STORY__', () => {
    // resolveStoryTitle is unit-tested in story-data-builder.test.ts;
    // this asserts its output actually rides the preview payload out
    // to the player.
    const html = renderPreviewHtml(buildFullyThemedStoryData(), 'T', 'Preview', NONCE);
    expect(html).toMatch(/window\.__WANDERLINE_STORY__=[^;]*"title":"Dear Anna"/);
  });

  it('omits the theme block entirely when no theme is present', () => {
    const html = renderPreviewHtml(
      { id: 's', title: 'x', audioBaseUrl: './', startNode: 'a', nodes: {} },
      'T',
      'Preview',
      NONCE,
    );
    expect(html).not.toContain('data-wanderline-theme');
    expect(html).not.toContain('fonts.googleapis.com');
  });
});
