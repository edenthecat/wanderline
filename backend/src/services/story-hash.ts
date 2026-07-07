// canonical hash of a project's story graph for build dedup.
//
// A "canonical hash" is stable across insertion order + whitespace of
// the input JSON: two structurally identical stories always hash to
// the same value, so the dedup lookup at enqueue can quickly match
// "we already built THIS story" without a JSONB deep-equal on the
// original snapshot.
//
// Scope (slice 1) — INPUTS INCLUDED IN THE HASH:
//   - project_stories.story_graph (the story graph JSONB)
//
// Scope (slice 1) — INPUTS NOT YET IN THE HASH (defaults-off reason):
//   - audio_files (re-upload with same filename → dedup would serve
//     the old audio)
//   - project_settings (theme, voiceoverVolume, backgroundMusicVolume,
//     indicatorVolume, choiceAudioDelayMs, showChoiceList,
//     bluetoothControls, captionsDefault, etc. — a theme tweak alone
//     would dedup to the pre-theme artifact)
//
// USE_BUILD_DEDUP defaults off precisely because of the above gaps.
// The next slice widens the hash to cover audio + settings before
// flipping the default.
//
// See documents/build-system-refactor-plan.md § Phase 5 dedup.

import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialiser — sorts object keys at every depth
 * before emitting, so `{a: 1, b: 2}` and `{b: 2, a: 1}` produce
 * identical strings. Arrays keep their order because ordering
 * matters in a story graph (choice order affects the built player).
 *
 * NULL / undefined / number / string / boolean fall through as
 * JSON.stringify handles them. undefined values (which JSON.stringify
 * ordinarily elides) still get elided — matching JSON.stringify's
 * usual behaviour so the round-trip parse-then-serialise is stable.
 *
 * NOT safe against cyclic references: the story graph in Wanderline
 * is a DAG-with-back-edges (choices point at nodes by ID, not by
 * embedded reference), so this restriction doesn't hit real inputs.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify returns undefined (not the string 'undefined') for
    // undefined / function / symbol values. Emitting that verbatim
    // would break JSON parsability + let hash collisions leak (e.g.
    // `{a: undefined, b: undefined}` and `{a: undefined}` would both
    // canonicalize to `{}` via the object branch below, but a bare
    // undefined value under canonicalize would emit the literal
    // string "undefined"). Coerce to null to match JSON.stringify's
    // array-element behaviour.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    // JSON.stringify([undefined]) === '[null]', NOT '[]'. Preserving
    // array length matters — `[undefined]` vs `[]` are different
    // shapes and must hash differently.
    return '[' + value.map((el) => canonicalize(el)).join(',') + ']';
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = rec[k];
    // Object properties whose value is undefined ARE elided by
    // JSON.stringify (unlike array holes), so mirror that here.
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalize(v));
  }
  return '{' + parts.join(',') + '}';
}

/**
 * SHA-256 hex of the canonical form of `storyGraph`. Returns a
 * lowercase 64-char string safe to persist in a VARCHAR(64) column
 * and to include verbatim in structured logs.
 *
 * Accepts unknown because the story_graph JSONB blob comes back
 * loosely-typed from node-postgres; the canonicaliser handles any
 * JSON-shaped value.
 *
 * Throws on null / undefined so a regression in an upstream guard
 * (enqueue rejects null-story projects at line 195; build-service
 * skips the write when rawStoryGraph is nullish) can't quietly
 * collapse every empty project onto the same hash — sha256('null')
 * is otherwise a stable, colliding value.
 */
export function storyHash(storyGraph: unknown): string {
  if (storyGraph === null || storyGraph === undefined) {
    throw new Error('storyHash: refusing to hash null / undefined story graph');
  }
  return createHash('sha256').update(canonicalize(storyGraph)).digest('hex');
}

/**
 * feature flag: opt-in to serving dedup matches at enqueue.
 * Off by default while the hash only covers the story graph (audio
 * changes are not detected — see file-header note). Read as a function
 * so tests can flip env between cases without a module reload.
 */
export function useBuildDedup(): boolean {
  return process.env.USE_BUILD_DEDUP === 'true';
}
