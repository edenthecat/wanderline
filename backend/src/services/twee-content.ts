/**
 * Twee passage body helpers shared between the generic parser
 * (twee-parser.ts) and every dialect-specific macro module
 * (harlowe-macros.ts, and its SugarCube/Chapbook siblings).
 *
 * Pulled out of twee-parser.ts specifically to avoid a circular
 * import: a dialect module needs these to fall back to generic
 * handling for content it doesn't specially recognize (an
 * unsupported macro, plain prose), but twee-parser.ts also needs to
 * call INTO the dialect module to process a passage body in the
 * first place. Neither module imports the other; both import this.
 */

import type { Choice, TextContent } from '../types.js';

/**
 * Extract every `[[...]]` link from `body`, returning the links as
 * Choices and the body with those links removed (they're modelled as
 * choices, not inline text). The optional trailing `[cond]` Harlowe/
 * SugarCube conditional-link suffix is matched and discarded here —
 * dialect modules that understand it extract their own condition
 * from the SURROUNDING macro/hook instead (see harlowe-macros.ts's
 * block-flattening), not from this suffix form.
 */
export function extractLinks(body: string): { choices: Choice[]; contentBody: string } {
  const choices: Choice[] = [];
  const linkPattern = /\[\[([^\][]*?)\]\](?:\[[^\]]*\])?/g;
  const contentBody = body.replace(linkPattern, (_full, inner: string) => {
    const link = parseLinkInner(inner);
    if (link) choices.push(link);
    return '';
  });
  return { choices, contentBody };
}

function parseLinkInner(inner: string): Choice | null {
  const trimmed = inner.trim();
  if (!trimmed) return null;
  let text: string;
  let target: string;
  // Split on the FIRST occurrence of the delimiter — `String.split`
  // returns every segment, so `'a->b->c'.split('->')` yields three
  // parts and destructuring silently drops `->c`. Use indexOf so a
  // delimiter appearing later in the text/target survives.
  //
  // Delimiter priority when multiple are present in the same link:
  // `|` beats `->`/`<-`. A link like `[[Attack -> retreat|Cave]]`
  // is authored as pipe form (text on the left, target on the right)
  // — splitting at `->` first would produce text='Attack' and
  // target='retreat|Cave' which is neither what the author wrote nor
  // a resolvable passage. Arrow-form links exist too but they never
  // legitimately contain a `|` in the text or target (Twee 3 spec).
  let idx: number;
  if ((idx = trimmed.indexOf('|')) !== -1) {
    // Shape: [[Text|Target]]
    text = trimmed.slice(0, idx).trim();
    target = trimmed.slice(idx + 1).trim();
  } else if ((idx = trimmed.indexOf('->')) !== -1) {
    // Shape: [[Text->Target]]
    text = trimmed.slice(0, idx).trim();
    target = trimmed.slice(idx + 2).trim();
  } else if ((idx = trimmed.indexOf('<-')) !== -1) {
    // Shape: [[Target<-Text]] (reversed)
    target = trimmed.slice(0, idx).trim();
    text = trimmed.slice(idx + 2).trim();
  } else {
    // Shape: [[Target]] — display text is the target name.
    text = trimmed;
    target = trimmed;
  }
  if (!target) return null;
  return {
    text: text || target,
    target,
    sticky: false,
    fallback: false,
    tags: [],
  };
}

/**
 * Parse the raw body content into a TextContent[]. Twee stores prose
 * as a single flat block; we split on blank lines to give each paragraph
 * its own TextContent (parity with Ink's stitch-per-paragraph feel).
 */
export function bodyToContent(body: string): TextContent[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((text): TextContent => ({
      // reverse the `\::` line-start escape the emitter
      // writes. Without this, a genuine `::` paragraph starts
      // gets a permanent leading backslash on every round-trip.
      // Only strips the ONE backslash that guards the delimiter;
      // authors who want a literal `\::` at line-start can
      // double-escape as `\\::` (and that only affects them if
      // they later mutate the graph, which is a fine trade).
      kind: 'text',
      text: text.replace(/(^|\n)\\::/g, '$1::'),
      tags: [],
    }));
}
