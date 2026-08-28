import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The scripting-disabled fallback, which is the only thing a reader
// sees when the player's React root never fills. Two properties of it
// are easy to break by "improving" the styling, and both make the
// message unreadable rather than merely ugly, so they are pinned here.
//
// Resolved from the vitest root (the player-app workspace) rather than
// import.meta.url, which is an http:// URL under the jsdom environment.
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf-8');
const css = read('src/index.css');
const indexHtml = read('index.html');

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('no-JS fallback styling', () => {
  // `body` resolves text through var(--wl-page-textColor, var(--wl-text)),
  // and Theme > Page > "Text color" is a separate knob from the global
  // one. Naming a colour here means an author who lightens the page
  // background and darkens the page text gets --wl-text's near-white
  // default on their own light surface.
  it.each(['.wl-noscript', '.wl-noscript h1', '.wl-noscript p'])(
    '%s inherits colour and font rather than naming its own',
    (selector) => {
      const body = ruleBody(selector);
      expect(body).not.toMatch(/(^|[\s;]) *color:/);
      expect(body).not.toMatch(/(^|[\s;]) *font-family:/);
      expect(body).not.toMatch(/(^|[\s;]) *background/);
    },
  );

  // The preview endpoint serves this same document under a CSP whose
  // style-src has no 'unsafe-inline' (buildPreviewCsp in
  // backend/src/routes/projects-preview.ts), so a style="..."
  // attribute renders unstyled there plus console violations.
  it('carries no inline style attributes in index.html', () => {
    const block = /<noscript>[\s\S]*?<\/noscript>/i.exec(indexHtml);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/style="/);
    expect(block![0]).toContain('class="wl-noscript"');
  });

  // The message is ours and it is English, while the document around
  // it carries the story's language once a build rewrites it.
  it('marks the English message as English', () => {
    const block = /<noscript>[\s\S]*?<\/noscript>/i.exec(indexHtml)![0];
    expect(block).toMatch(/<p\s+lang="en"/);
  });
});
