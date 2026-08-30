// tests for the language tag baked into every generated build.
//
// This value is written straight into `<html lang>` and the manifest's
// `lang`, both consumed by the OS and the screen reader. The two things
// worth pinning are that a real tag survives untouched, and that
// anything else falls back to 'en' rather than reaching the attribute.

import { DEFAULT_BUILD_LANGUAGE, normalizeBuildLanguage } from '../build-language.js';

describe('normalizeBuildLanguage', () => {
  it.each(['en', 'fr', 'de', 'pt-BR', 'en-GB', 'zh-Hant-TW', 'es-419'])(
    'passes through the valid BCP-47 tag %p',
    (tag) => {
      expect(normalizeBuildLanguage(tag)).toBe(tag);
    },
  );

  it('trims surrounding whitespace', () => {
    expect(normalizeBuildLanguage('  fr  ')).toBe('fr');
  });

  it.each([undefined, null, '', '   ', 42, {}, ['fr']])(
    'falls back to the default for %p',
    (value) => {
      expect(normalizeBuildLanguage(value)).toBe(DEFAULT_BUILD_LANGUAGE);
    },
  );

  // The tag lands inside a double-quoted attribute, so a value that
  // could close it must never survive. A wrong-but-safe 'en' is a much
  // smaller problem than a broken <html> tag.
  it.each(['en" onload="alert(1)', 'e', 'toolongprimary', 'fr_CA', 'fr-', '<script>'])(
    'rejects the malformed tag %p',
    (tag) => {
      expect(normalizeBuildLanguage(tag)).toBe(DEFAULT_BUILD_LANGUAGE);
    },
  );
});
