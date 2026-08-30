// Language tag for generated builds.
//
// Every exported surface used to hardcode `lang="en"`: the player's
// index.html, the generated smoke.html, and the manifest. A story
// written in French therefore shipped as English, so a screen reader
// read its captions with an English voice and English phonetics —
// usually unintelligible. For a product whose on-screen text IS the
// accessible alternative to its audio, that's the difference between a
// usable build and an unusable one.
//
// Authors set this from Settings → Export (`settings.language`). It is
// deliberately a plain BCP-47 tag rather than a picker of our own
// invention: the value goes straight into `<html lang>` and the
// manifest's `lang`, both of which are consumed by the OS and the
// screen reader, not by us.

/** Fallback when the project has no language set. */
export const DEFAULT_BUILD_LANGUAGE = 'en';

// A conservative BCP-47 subset: a primary subtag of 2-8 letters
// followed by any number of alphanumeric subtags ("en", "en-GB",
// "zh-Hant-TW", "es-419"). Anything else is rejected rather than
// passed through — an invalid `lang` is worse than the default (some
// screen readers fall back to the system voice rather than the
// document's), and a stray quote would break out of the attribute.
const BCP47 = /^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/;

/**
 * Normalize an author-supplied language tag for use in generated
 * builds. Returns the trimmed tag, or `'en'` when unset or malformed.
 */
export function normalizeBuildLanguage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BUILD_LANGUAGE;
  const trimmed = value.trim();
  if (!BCP47.test(trimmed)) return DEFAULT_BUILD_LANGUAGE;
  return trimmed;
}
