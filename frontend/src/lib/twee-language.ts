// CodeMirror 6 StreamLanguage for Twee 3.
//
// Twee is much more line-oriented than Ink — a stream tokenizer
// covers the cases authors care about:
//
//   - `:: PassageName` — passage header
//   - `[tag1 tag2]` — passage tag list (after header name)
//   - `{"position":"x,y"}` — JSON metadata block (after header)
//   - `[[Target]]` / `[[Text|Target]]` / `[[Text->Target]]` /
//     `[[Target<-Text]]` — links
//   - `<<macro>>` — macros (highlighted as strings, not evaluated)
//   - `//` line comments (SugarCube convention)
//   - `\::` escaped passage-header marker (matches the emitter's
//     escape output — stays as content, not a header)
//
// Highlight tags are standard CodeMirror highlight tags; the active
// editor theme decides the colours.

import { StreamLanguage, StreamParser } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

interface TweeState {
  inMacro: boolean;
  inLink: boolean;
}

const tweeParser: StreamParser<TweeState> = {
  name: 'twee',

  startState() {
    return { inMacro: false, inLink: false };
  },

  token(stream, _state) {
    // Line-start states — headers, comments, escaped headers.
    if (stream.sol()) {
      if (stream.match(/^:: /)) {
        // Passage header marker + name up to a tag/meta bracket.
        stream.match(/^[^[{]*/);
        return t.heading.toString();
      }
      if (stream.match(/^\\::/)) {
        // Escaped `::` at line start — content, not a header.
        return t.string.toString();
      }
      if (stream.match(/^\/\//)) {
        stream.skipToEnd();
        return t.lineComment.toString();
      }
    }

    // Link markup — colour the whole `[[...]]` including the brackets.
    // Must run BEFORE the single-bracket tag rule: otherwise a link
    // like `[[Home]]` gets partially consumed as the tag token
    // `[[Home]` and never highlighted as a link.
    if (stream.match(/\[\[[^\][]+\]\]/)) {
      return t.link.toString();
    }

    // Header tag list.
    if (stream.match(/\[[^\]]+\]/)) {
      return t.attributeName.toString();
    }

    // Header metadata JSON.
    if (stream.match(/\{[^{}]*\}/)) {
      return t.meta.toString();
    }

    // SugarCube macros — `<<if>>`, `<<set>>`, etc.
    if (stream.match(/<<[^<>]*>>/)) {
      return t.macroName.toString();
    }

    // Otherwise consume a single character and let the theme's
    // default fill handle it.
    stream.next();
    return null;
  },
};

export const tweeLanguage = StreamLanguage.define(tweeParser);
