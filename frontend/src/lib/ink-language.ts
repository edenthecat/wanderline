// CodeMirror 6 StreamLanguage for Ink (https://github.com/inkle/ink).
//
// A real lexer + parser would use Lezer, but Ink is line-oriented enough
// that a stream tokenizer covers the cases authors actually look at:
//
//   - `=== knot ===` / `== knot ==` / `=== knot ===  #tag` — knot heading
//   - `= stitch` — stitch heading
//   - `* choice text` / `+ sticky choice` / `*[bracket]` — choice
//   - `-> target` / `<- thread` — divert
//   - `# tag` (line-end) — tag
//   - `// line comment` and `/* block comment */`
//   - `~ statement` — logic line
//   - `VAR`, `LIST`, `CONST`, `INCLUDE`, `EXTERNAL` — preamble keywords
//   - `{conditional|alternative}` — interpolation block (highlights braces)
//   - `-` after a knot/stitch — gather
//   - text and whitespace fall through to default
//
// Highlight tags are the standard CodeMirror highlight tags; the user's
// active theme decides the actual colors. Comments + tags + diverts +
// headings render distinctly in every default theme we ship.

import { StreamLanguage, StreamParser } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

interface InkState {
  inBlockComment: boolean;
  // The first '{' on a line opens a conditional/alternative block;
  // we track depth so nested braces still close cleanly.
  braceDepth: number;
}

const PREAMBLE_KEYWORDS = /^(VAR|LIST|CONST|INCLUDE|EXTERNAL|EXTEND|DONE|END)\b/;

const inkParser: StreamParser<InkState> = {
  name: 'ink',

  startState() {
    return { inBlockComment: false, braceDepth: 0 };
  },

  token(stream, state) {
    // Block comment passthrough — Ink supports `/* … */` even
    // across lines. The opener/closer are tokenized in one shot.
    if (state.inBlockComment) {
      if (stream.skipTo('*/')) {
        stream.match('*/');
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return 'comment';
    }

    if (stream.sol()) {
      stream.eatSpace();

      // Knot / stitch headings.
      if (stream.match(/^={2,}\s*[A-Za-z_][\w.]*/)) {
        stream.match(/\s*={2,}/);
        return 'heading';
      }
      if (stream.match(/^=\s*[A-Za-z_][\w.]*/)) {
        return 'heading';
      }

      // Preamble keywords (VAR, LIST, CONST, INCLUDE, EXTERNAL).
      if (stream.match(PREAMBLE_KEYWORDS)) return 'keyword';

      // Logic lines: ~ expr
      if (stream.match(/^~/)) return 'operator';

      // Choices: * (one-time) / + (sticky). Followed by optional
      // brackets or label markers.
      if (stream.match(/^[*+]+/)) return 'controlKeyword';

      // Gather: - at line start (after stitches typically).
      if (stream.match(/^-(?!>)/)) return 'controlKeyword';
    }

    // Mid-line tokens.

    // Comments.
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match('/*')) {
      state.inBlockComment = true;
      if (stream.skipTo('*/')) {
        stream.match('*/');
        state.inBlockComment = false;
      } else {
        stream.skipToEnd();
      }
      return 'comment';
    }

    // Diverts: -> target / <- thread.
    if (stream.match(/->\s*[A-Za-z_][\w.]*/)) return 'link';
    if (stream.match(/<-\s*[A-Za-z_][\w.]*/)) return 'link';
    if (stream.match(/->/)) return 'link';

    // Tags: anything after `#` to end of line, including inline tags.
    if (stream.match(/#[^\n]*/)) return 'meta';

    // Bracket runs in choice text: *[bracket-only]
    if (stream.match(/\[[^\]\n]*\]/)) return 'string';

    // Conditional / alternative blocks. Brace tracking so nested
    // blocks still highlight the closing bracket.
    if (stream.match('{')) {
      state.braceDepth += 1;
      return 'bracket';
    }
    if (stream.match('}')) {
      if (state.braceDepth > 0) state.braceDepth -= 1;
      return 'bracket';
    }
    if (state.braceDepth > 0) {
      if (stream.match('|')) return 'separator';
      if (stream.match(/[A-Za-z_]\w*/)) return 'variableName';
      if (stream.match(/\d+/)) return 'number';
    }

    // Default: consume one char and emit nothing (plain text).
    stream.next();
    return null;
  },

  tokenTable: {
    heading: t.heading,
    keyword: t.keyword,
    controlKeyword: t.controlKeyword,
    operator: t.operator,
    comment: t.lineComment,
    link: t.link,
    meta: t.meta,
    string: t.string,
    bracket: t.bracket,
    separator: t.separator,
    variableName: t.variableName,
    number: t.number,
  },
};

export const inkLanguage = StreamLanguage.define(inkParser);
