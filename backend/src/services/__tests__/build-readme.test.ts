// tests for the README shipped inside every generated build.
// Kept out of build-service.test.ts for the same reason as
// build-html.test.ts: importing build-service pulls in a top-level
// `import.meta.url` that ts-jest's default-esm preset can't parse.

import { renderBuildReadme, DEFAULT_README_TEMPLATE } from '../build-readme.js';

describe('renderBuildReadme', () => {
  it('substitutes the project name into the default template', () => {
    const out = renderBuildReadme({ projectName: 'The Long Dark' });
    expect(out).toContain('# The Long Dark');
    expect(out).not.toContain('{{PROJECT_NAME}}');
  });

  // The whole point of the feature: an author's document wins.
  it('prefers an author-supplied template', () => {
    const out = renderBuildReadme({
      projectName: 'Ignored',
      template: '# Custom\n\nMy own words.',
    });
    expect(out).toBe('# Custom\n\nMy own words.');
    expect(out).not.toContain('Install it as an app');
  });

  it('substitutes placeholders inside a custom template too', () => {
    const out = renderBuildReadme({
      projectName: 'Ghost Radio',
      template: 'Welcome to {{PROJECT_NAME}}.',
    });
    expect(out).toBe('Welcome to Ghost Radio.');
  });

  // An empty or whitespace-only override is almost always a cleared
  // textarea rather than a deliberate empty README; shipping a blank
  // file would be a silent downgrade.
  it.each(['', '   ', '\n\n', null, undefined])('falls back when template is %p', (template) => {
    const out = renderBuildReadme({ projectName: 'Fallback', template });
    expect(out).toContain('Install it as an app');
  });

  // A surviving `{{FOO}}` is a visible signal to the author. Replacing
  // it with an empty string would make their text quietly disappear.
  it('leaves unknown placeholders intact', () => {
    const out = renderBuildReadme({
      projectName: 'X',
      template: 'Hello {{NOPE}} and {{PROJECT_NAME}}.',
    });
    expect(out).toBe('Hello {{NOPE}} and X.');
  });

  it('tolerates whitespace inside placeholder braces', () => {
    expect(renderBuildReadme({ projectName: 'Y', template: '{{  PROJECT_NAME  }}' })).toBe('Y');
  });

  // Every build is meant to tell listeners to install as a web app.
  it('default template covers all three install platforms', () => {
    expect(DEFAULT_README_TEMPLATE).toContain('Add to Home Screen');
    expect(DEFAULT_README_TEMPLATE).toMatch(/Android/);
    expect(DEFAULT_README_TEMPLATE).toMatch(/Desktop/);
  });
});
