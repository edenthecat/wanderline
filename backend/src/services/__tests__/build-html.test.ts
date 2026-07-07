// tests for the index.html post-process transforms baked
// into every project build. Pinned in a separate file from
// build-service.test.ts because that suite transitively imports
// build-service.ts, which uses `import.meta.url` at module
// top-level — ts-jest's default-esm preset can't parse it, so
// importing build-service into a test currently fails the suite.
// build-html.ts has no such dependency.

import { prepareDistHtml } from '../build-html.js';

describe('prepareDistHtml', () => {
  const baseHtml = `<!DOCTYPE html>
<html><head>
<title>Wanderline Player</title>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-def.css">
</head><body><div id="root"></div></body></html>`;
  const storyData = { id: 'p1', title: 'Demo', nodes: {} };

  it('strips type=module + crossorigin and adds defer for file:// compat', () => {
    const out = prepareDistHtml(baseHtml, {
      rewriteForPrebuiltDist: true,
      title: 'Demo',
      storyData: storyData,
    });
    expect(out).not.toMatch(/type="module"/);
    expect(out).not.toMatch(/ crossorigin/);
    expect(out).toMatch(/<script defer /);
  });

  it('replaces the prebuilt-dist default title when rewriteForPrebuiltDist is true', () => {
    const out = prepareDistHtml(baseHtml, {
      rewriteForPrebuiltDist: true,
      title: 'Demo',
      storyData: storyData,
    });
    expect(out).toMatch(/<title>Demo<\/title>/);
    expect(out).not.toMatch(/Wanderline Player/);
  });

  it('does NOT touch the title when rewriteForPrebuiltDist is false (legacy path)', () => {
    const legacyHtml = baseHtml.replace(
      '<title>Wanderline Player</title>',
      '<title>My Game</title>',
    );
    const out = prepareDistHtml(legacyHtml, {
      rewriteForPrebuiltDist: false,
      storyData,
    });
    expect(out).toMatch(/<title>My Game<\/title>/);
  });

  it('rewrites absolute /assets/ paths to relative on the prebuilt-dist path', () => {
    const out = prepareDistHtml(baseHtml, {
      rewriteForPrebuiltDist: true,
      title: 'X',
      storyData: storyData,
    });
    expect(out).toMatch(/src="\.\/assets\/index-abc\.js"/);
    expect(out).toMatch(/href="\.\/assets\/index-def\.css"/);
    expect(out).not.toMatch(/src="\/assets\//);
    expect(out).not.toMatch(/href="\/assets\//);
  });

  it('does NOT rewrite already-relative ./assets/ paths', () => {
    const relativeHtml = baseHtml
      .replace('src="/assets/index-abc.js"', 'src="./assets/index-abc.js"')
      .replace('href="/assets/index-def.css"', 'href="./assets/index-def.css"');
    const out = prepareDistHtml(relativeHtml, {
      rewriteForPrebuiltDist: true,
      title: 'X',
      storyData: storyData,
    });
    // No over-rewriting → no `././assets/` artifacts.
    expect(out).not.toMatch(/\.\/\.\/assets\//);
    expect(out).toMatch(/src="\.\/assets\/index-abc\.js"/);
  });

  it('survives a project title containing String.replace back-references ($&, $$, $1)', () => {
    // Regression for the previous bug where `String.replace(re, string)`
    // interpreted $-sequences in the replacement — a project named
    // "Foo $& Bar" expanded to the whole matched title, nesting itself.
    const tricky = 'Cost $50 & $&-rating $$ $1';
    const out = prepareDistHtml(baseHtml, {
      rewriteForPrebuiltDist: true,
      title: tricky,
      storyData: storyData,
    });
    expect(out).toContain(`<title>${tricky}</title>`);
    expect(out).not.toMatch(/Wanderline Player/);
  });

  it('escapes </script> inside the injected story JSON so the inline tag cannot break out', () => {
    const malicious = {
      title: '</script><script>alert("xss")</script>',
      body: 'normal',
      nodes: {},
    };
    const out = prepareDistHtml(baseHtml, {
      rewriteForPrebuiltDist: true,
      title: 'X',
      storyData: malicious,
    });
    expect(out).toMatch(/window\.__WANDERLINE_STORY__=/);
    // The literal </script> from the malicious title must not
    // appear inside the JSON payload — it'd terminate our script.
    const storyStart = out.indexOf('window.__WANDERLINE_STORY__=');
    const storyEnd = out.indexOf('</script>', storyStart);
    const payload = out.slice(storyStart, storyEnd);
    expect(payload).not.toMatch(/<\/script>/i);
    expect(payload).toMatch(/\\u003c\/script>/);
  });

  it('emits \\u2028 / \\u2029 escapes in the injected JSON', () => {
    const data = { lineSep: '\u2028', paraSep: '\u2029', nodes: {} };
    const out = prepareDistHtml(baseHtml, {
      rewriteForPrebuiltDist: true,
      title: 'X',
      storyData: data,
    });
    expect(out).toMatch(/\\u2028/);
    expect(out).toMatch(/\\u2029/);
  });

  it('handles a $-back-reference inside the injected JSON without corrupting the script tag', () => {
    // Regression for the `String.replace('</head>', stringLiteral)` bug:
    // story content like a node title containing `$&` would otherwise
    // expand to the entire `</head>` match and double-inject the tag.
    const trickyStory = {
      id: 'x',
      title: 'Cost $& Price $1 Total $$',
      body: '$`-prefix',
      nodes: {},
    };
    const out = prepareDistHtml(baseHtml, {
      rewriteForPrebuiltDist: true,
      title: 'X',
      storyData: trickyStory,
    });
    // The injection produces exactly one </head> in total (the one we
    // intentionally re-emit). A back-reference expansion would yield
    // two.
    expect(out.match(/<\/head>/g)).toHaveLength(1);
    // The literal $-sequences survive in the embedded JSON.
    expect(out).toMatch(/Cost \$& Price \$1 Total \$\$/);
  });

  it('throws when </head> is missing — without it we cannot inject the story script', () => {
    const broken = '<html><body>no head here</body></html>';
    expect(() =>
      prepareDistHtml(broken, { rewriteForPrebuiltDist: true, title: 'X', storyData }),
    ).toThrow(/missing <\/head>/);
  });
});
