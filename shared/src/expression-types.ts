/**
 * Canonical expression AST shared by every source format (Ink, Harlowe,
 * SugarCube, Chapbook) and both runtimes (backend validation/preview,
 * player-app playback). Each format's parser compiles its own native
 * condition/assignment syntax into this AST; each format's emitter
 * un-parses the same AST back to native syntax on export. The player
 * and the editor's condition-editing UI only ever need to understand
 * this one shape, regardless of which format a story was authored in.
 *
 * Ink's own expression grammar is the textual surface this AST's
 * parser/printer (expression-parser.ts) understands — see that file's
 * header for why.
 */

export type VariableValue = number | string | boolean;

export type VariableType = 'number' | 'string' | 'bool';

export type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=';

export type LogicalOperator = '&&' | '||';

export type UnaryOperator = '-' | '!';

export type Expression =
  | { kind: 'literal'; value: VariableValue }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; operator: UnaryOperator; operand: Expression }
  | { kind: 'binary'; operator: BinaryOperator; left: Expression; right: Expression }
  | { kind: 'logical'; operator: LogicalOperator; left: Expression; right: Expression };

/**
 * `=` is a plain assignment; the compound forms are sugar for
 * `name = name <op> value` but are kept as their own operator (not
 * desugared at parse time) so a round-trip through the printer
 * reproduces what the author actually wrote.
 */
export type AssignmentOperator = '=' | '+=' | '-=' | '*=' | '/=';

export interface AssignmentStatement {
  kind: 'assignment';
  name: string;
  operator: AssignmentOperator;
  value: Expression;
}

export type Statement = AssignmentStatement;

export interface VariableDeclaration {
  name: string;
  type: VariableType;
  initialValue: Expression;
  isConst: boolean;
}

/**
 * A node's `content` array is a discriminated union, not a flat list
 * of text, so Ink's in-content `~` assignment lines (narration, then
 * `~ x = x + 1`, then more narration — DEV-199 Phase 1) can interleave
 * with narration in original document order, rather than needing a
 * separate parallel "statements" array kept in sync by position.
 *
 * Shared (not duplicated per format/runtime like the rest of
 * StoryGraph) because backend validation, player-app playback, and
 * the editor UI must all agree on what counts as a text block vs an
 * assignment block — see `isTextBlock`.
 *
 * `kind` is required going forward, but every *reader* of this array
 * should treat a block with no recognized `kind` (e.g. old data from
 * before this field existed) as a TextBlock — see `isTextBlock`
 * below — rather than require every existing story_graph row to be
 * migrated before this type change ships.
 */
export type ContentBlock = TextBlock | AssignmentBlock;

export interface TextBlock {
  kind: 'text';
  text: string;
  tags: string[];
  /** Ink's `{condition: text}` or a Twine dialect's hook condition (DEV-199 Phase 3/7-9). */
  condition?: Expression;
}

export interface AssignmentBlock {
  kind: 'assignment';
  statement: Statement;
}

/**
 * True for a TextBlock, including a pre-Phase-0 content item that has
 * no `kind` at all — only an explicit `kind: 'assignment'` should
 * ever be treated as non-text. Prefer this over `block.kind ===
 * 'text'` anywhere old data might still be in play.
 *
 * Accepts `null`/`undefined` (returning `false`, i.e. filtered out
 * rather than crashing) because every real caller gets this array by
 * casting loosely-typed JSONB `story_graph` data — the type system
 * doesn't actually guarantee every element is a well-formed
 * `ContentBlock`, only that it should be. A malformed element should
 * disappear from a `.filter(isTextBlock)` call, not take the whole
 * request down with `Cannot read properties of null`.
 */
export function isTextBlock(block: ContentBlock | null | undefined): block is TextBlock {
  return block != null && block.kind !== 'assignment';
}

/** @deprecated Use {@link ContentBlock} (a TextBlock | AssignmentBlock union). Kept only as an alias during the DEV-199 migration. */
export type TextContent = TextBlock;
