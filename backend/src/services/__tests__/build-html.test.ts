// tests for the index.html post-process transforms baked
// into every project build. Pinned in a separate file from
// build-service.test.ts because that suite transitively imports
// build-service.ts, which uses `import.meta.url` at module
// top-level — ts-jest's default-esm preset can't parse it, so
// importing build-service into a test currently fails the suite.
// build-html.ts has no such dependency.

import { prepareDistHtml } from '../build-html.js';

describe('prepareDistHtml', () => {
  // Mirrors the shape player-app/index.html builds to: a hardcoded
  // `lang`, the player's default theme-color, and the generic
  // <noscript> that the export rewrites to name the story.
  const baseHtml = `<!DOCTYPE html>
<html lang="en"><head>
<meta name="theme-color" content="#1a1a2e" />
<title>Wanderline Player</title>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-def.css">
</head><body><div id="root"></div>
<noscript><div><p>Placeholder fallback.</p></div></noscript>
</body></html>`;
  const storyData = { id: 'p1', title: 'Demo', nodes: {} };

  it('strips type=module + crossorigin and adds defer for file:// compat', () => {
    const out = prepareDistHtml(baseHtml, {
      title: 'Demo',
      storyData: storyData,
    });
    expect(out).not.toMatch(/type="module"/);
    expect(out).not.toMatch(/ crossorigin/);
    expect(out).toMatch(/<script defer /);
  });

  it('replaces the <title> with the project name', () => {
    const out = prepareDistHtml(baseHtml, {
      title: 'Demo',
      storyData: storyData,
    });
    expect(out).toMatch(/<title>Demo<\/title>/);
    expect(out).not.toMatch(/Wanderline Player/);
  });

  it('rewrites absolute /assets/ paths to relative', () => {
    const out = prepareDistHtml(baseHtml, {
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
    expect(() => prepareDistHtml(broken, { title: 'X', storyData })).toThrow(/missing <\/head>/);
  });

  // The player ships `lang="en"`; before this, a story written in
  // French exported as English and a screen reader read its captions
  // with an English voice and English phonetics.
  describe('language', () => {
    it('rewrites <html lang> to the project language', () => {
      const out = prepareDistHtml(baseHtml, { title: 'X', storyData, language: 'fr' });
      expect(out).toMatch(/<html lang="fr"/i);
      expect(out).not.toMatch(/<html lang="en"/i);
    });

    it('defaults to en when no language is given', () => {
      const out = prepareDistHtml(baseHtml, { title: 'X', storyData });
      expect(out).toMatch(/<html lang="en"/i);
    });

    // `?? DEFAULT` would let an empty string through, and
    // `<html lang="">` is worse than no attribute at all.
    it.each(['', '   ', 'not a tag'])('falls back to en for %p', (language) => {
      const out = prepareDistHtml(baseHtml, { title: 'X', storyData, language });
      expect(out).toMatch(/<html lang="en"/i);
    });

    it('adds lang when the source document has none', () => {
      const noLang = baseHtml.replace('<html lang="en">', '<html>');
      const out = prepareDistHtml(noLang, { title: 'X', storyData, language: 'pt-BR' });
      expect(out).toMatch(/<html lang="pt-BR"/i);
    });

    it('keeps other attributes on the <html> tag', () => {
      const withAttr = baseHtml.replace('<html lang="en">', '<html data-x="1" lang="en">');
      const out = prepareDistHtml(withAttr, { title: 'X', storyData, language: 'de' });
      expect(out).toMatch(/<html data-x="1" lang="de"/i);
    });

    // Missing a single-quoted attribute would fall through to the
    // add-branch and emit `<html lang="de" lang='en'>`, where the
    // browser honours the FIRST — so the stale tag would win.
    it('rewrites a single-quoted lang rather than adding a second', () => {
      const singleQuoted = baseHtml.replace('<html lang="en">', "<html lang='en'>");
      const out = prepareDistHtml(singleQuoted, { title: 'X', storyData, language: 'de' });
      const htmlTag = /<html[^>]*>/i.exec(out)![0];
      expect(htmlTag).toMatch(/lang="de"/);
      expect(htmlTag.match(/lang=/gi)).toHaveLength(1);
    });
  });

  // The manifest already carried the author's themeColor; the HTML
  // kept the player's default navy, so mobile browser chrome and the
  // installed status bar disagreed with the story's palette.
  describe('theme-color', () => {
    it('rewrites the meta from the manifest colour', () => {
      const out = prepareDistHtml(baseHtml, { title: 'X', storyData, themeColor: '#ffeedd' });
      expect(out).toMatch(/<meta name="theme-color" content="#ffeedd"/i);
      expect(out).not.toMatch(/content="#1a1a2e"/i);
    });

    it('leaves the meta alone when no colour is supplied', () => {
      const out = prepareDistHtml(baseHtml, { title: 'X', storyData });
      expect(out).toMatch(/content="#1a1a2e"/i);
    });

    it('does not add a second theme-color meta', () => {
      const out = prepareDistHtml(baseHtml, { title: 'X', storyData, themeColor: '#ffeedd' });
      expect(out.match(/name="theme-color"/gi)).toHaveLength(1);
    });

    // Otherwise dropping the tag from player-app/index.html would
    // silently reinstate the bug: chrome painted the player's default
    // navy while the manifest carried the author's colour.
    it('adds the meta when the source document has none', () => {
      const noMeta = baseHtml.replace('<meta name="theme-color" content="#1a1a2e" />\n', '');
      expect(noMeta).not.toContain('theme-color');
      const out = prepareDistHtml(noMeta, { title: 'X', storyData, themeColor: '#ffeedd' });
      expect(out).toMatch(/<meta name="theme-color" content="#ffeedd"[^>]*>[\s\S]*<\/head>/i);
    });

    // `name` is not required to come first. Missing that shape falls
    // through to the add-branch and ships TWO metas; the browser
    // honours the first, so the build silently reverts to the
    // player's default navy.
    it.each([
      ['name is not the first attribute', '<meta content="#1a1a2e" name="theme-color" />'],
      ['name is single-quoted', "<meta name='theme-color' content='#1a1a2e' />"],
    ])('rewrites the meta when %s', (_label, tag) => {
      const variant = baseHtml.replace('<meta name="theme-color" content="#1a1a2e" />', tag);
      const out = prepareDistHtml(variant, { title: 'X', storyData, themeColor: '#ffeedd' });
      expect(out.match(/name=("|')theme-color("|')/gi)).toHaveLength(1);
      expect(out).toMatch(/content="#ffeedd"/);
      expect(out).not.toMatch(/#1a1a2e/);
    });
  });

  // With JS off, or the bundle failing to load (routine for a file://
  // build or a stale offline cache), #root stays empty and the reader
  // gets a blank white page with no explanation.
  describe('noscript fallback', () => {
    it('names the story and explains that JavaScript is required', () => {
      const out = prepareDistHtml(baseHtml, { title: 'Ghost Radio', storyData });
      const block = /<noscript>[\s\S]*?<\/noscript>/i.exec(out);
      expect(block).not.toBeNull();
      expect(block![0]).toContain('Ghost Radio');
      expect(block![0]).toMatch(/needs JavaScript/i);
    });

    it('replaces the player placeholder rather than adding a second block', () => {
      const out = prepareDistHtml(baseHtml, { title: 'Ghost Radio', storyData });
      expect(out.match(/<noscript>/gi)).toHaveLength(1);
      expect(out).not.toContain('Placeholder fallback');
    });

    it('adds one before </body> when the source document has none', () => {
      const noNoscript = baseHtml.replace(
        '<noscript><div><p>Placeholder fallback.</p></div></noscript>\n',
        '',
      );
      expect(noNoscript).not.toContain('<noscript');
      const out = prepareDistHtml(noNoscript, { title: 'Ghost Radio', storyData });
      expect(out).toMatch(/<noscript>[\s\S]*Ghost Radio[\s\S]*<\/noscript>\s*<\/body>/i);
    });

    it('survives a title containing String.replace back-references', () => {
      const out = prepareDistHtml(baseHtml, { title: 'Cost $& $1 $$', storyData });
      const block = /<noscript>[\s\S]*?<\/noscript>/i.exec(out);
      expect(block![0]).toContain('Cost $& $1 $$');
    });

    // The message is ours and it is English; the document around it is
    // tagged with the story's language, so without this a French story
    // has its fallback read aloud with French phonetics.
    // A reader is shown the story's name, not the project's slug —
    // the same name the manifest and the preview use.
    it('prefers the story name over the project name', () => {
      const out = prepareDistHtml(baseHtml, {
        title: 'wanderline-demo-2',
        storyName: 'Ghost Radio',
        storyData,
      });
      const block = /<noscript>[\s\S]*?<\/noscript>/i.exec(out)![0];
      expect(block).toContain('Ghost Radio');
      expect(block).not.toContain('wanderline-demo-2');
      // The tab title still uses the project name.
      expect(out).toContain('<title>wanderline-demo-2</title>');
    });

    it.each([undefined, '', '   '])('falls back to the project name for %p', (storyName) => {
      const out = prepareDistHtml(baseHtml, { title: 'Fallback Name', storyName, storyData });
      const block = /<noscript>[\s\S]*?<\/noscript>/i.exec(out)![0];
      expect(block).toContain('Fallback Name');
    });

    it('marks the English message as English', () => {
      const out = prepareDistHtml(baseHtml, { title: 'Le Fantôme', storyData, language: 'fr' });
      const block = /<noscript>[\s\S]*?<\/noscript>/i.exec(out)![0];
      expect(block).toMatch(/<p lang="en">/);
      // The story title is not ours to relabel — it stays in the
      // document's language.
      expect(block).toMatch(/<h1>Le Fantôme<\/h1>/);
    });

    // The preview endpoint serves this same document under a CSP whose
    // style-src has no 'unsafe-inline' (buildPreviewCsp in
    // backend/src/routes/projects-preview.ts), so a style="..."
    // attribute here renders unstyled plus console violations.
    it('styles the fallback with classes, not inline style attributes', () => {
      const out = prepareDistHtml(baseHtml, { title: 'Ghost Radio', storyData });
      const block = /<noscript>[\s\S]*?<\/noscript>/i.exec(out)![0];
      expect(block).not.toMatch(/style="/);
      expect(block).toContain('class="wl-noscript"');
    });
  });
});
