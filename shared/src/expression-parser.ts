/**
 * Parser + printer for the canonical expression/statement textual
 * surface. This is Ink's own expression grammar (`x > 5 && seen_market`,
 * `~ gold += 10`) — chosen as the canonical surface because Ink's
 * parser already needs to understand it natively (see the plan doc),
 * so Ink's own source lines can be fed straight into `parseExpression`/
 * `parseStatement` with no translation step. The three Twine dialects'
 * own native syntax (Harlowe's `$x`, SugarCube's `<<if>>`, Chapbook's
 * `[if]`) is translated INTO this surface by each dialect's own parser
 * before it ever reaches here — this module has no dialect awareness.
 *
 * LIST literals/operators (DEV-199 Phase 10) need a bare identifier
 * like `cold` to resolve as a list member reference rather than a
 * plain variable — something the TEXT alone can't disambiguate, so
 * `parseExpression`/`parseStatement` take an optional `context`
 * naming the known list members. Every existing caller that omits it
 * keeps treating every identifier as a plain variable, unchanged.
 *
 * Deliberately NOT supported yet (not needed until function-knots
 * land): user-defined function calls (only the fixed LIST_* builtins
 * parse as calls), and the `MOD`/`and`/`or`/`not` word-form operators
 * (Ink accepts both symbol and word forms for logical operators;
 * only the symbol forms `&&`/`||`/`!` are recognized here — a dialect
 * or Ink-source normalization step can translate word-forms to
 * symbol-forms before calling this parser).
 */

import type {
  AssignmentOperator,
  AssignmentStatement,
  BinaryOperator,
  Expression,
  ListFunctionName,
  ListItem,
  LogicalOperator,
  Statement,
  VariableValue,
} from './expression-types.js';

export class ExpressionParseError extends Error {}

/** Every LIST_* builtin query function's name — a bare function-call
 * name that isn't one of these is a parse error, since user-defined
 * function calls don't parse yet (no function-knot interpreter
 * exists to run them against). */
const LIST_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  'LIST_COUNT',
  'LIST_MIN',
  'LIST_MAX',
  'LIST_ALL',
  'LIST_RANGE',
  'LIST_VALUE',
  'LIST_INVERT',
]);

/** Where a bare identifier should resolve as a LIST member reference
 * instead of a plain variable — absent identifiers are always plain
 * variables, so omitting `context` entirely preserves every existing
 * non-LIST caller's behavior unchanged. */
export interface ExpressionParseContext {
  /** identifier -> which LIST declares it, and its ordinal position
   * in that declaration's member order. */
  listMembers?: Record<string, { origin: string; ordinal: number }>;
  /** origin LIST name -> every member it declares, in declaration
   * order — becomes a literal's `allItems` (see ListValue) without a
   * second lookup structure at evaluation time. */
  listDefinitions?: Record<string, ListItem[]>;
}

// === Tokenizer ===

type TokenType =
  'number' | 'string' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
  type: TokenType;
  value: string;
}

const MULTI_CHAR_OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '!?'];
const SINGLE_CHAR_OPERATORS = ['+', '-', '*', '/', '%', '<', '>', '=', '!', '?'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ',' });
      i++;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          value += source[j + 1];
          j += 2;
        } else {
          value += source[j];
          j++;
        }
      }
      if (j >= source.length) {
        throw new ExpressionParseError(`Unterminated string literal in: ${source}`);
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j++;
      tokens.push({ type: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      tokens.push({ type: 'identifier', value: source.slice(i, j) });
      i = j;
      continue;
    }
    const twoChar = source.slice(i, i + 2);
    if (MULTI_CHAR_OPERATORS.includes(twoChar)) {
      tokens.push({ type: 'operator', value: twoChar });
      i += 2;
      continue;
    }
    if (SINGLE_CHAR_OPERATORS.includes(ch)) {
      tokens.push({ type: 'operator', value: ch });
      i++;
      continue;
    }
    throw new ExpressionParseError(`Unexpected character '${ch}' in: ${source}`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

// === Recursive-descent parser ===
//
// Precedence, low to high: || , && , ==/!= , </<=/>/>= , +/- , */%  ,
// unary -/! , primary. Each level's function parses everything at its
// own precedence or higher, deferring to the next-higher level for
// operands — the standard structure for a hand-written expression
// parser without a Pratt table.

class Parser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly context: ExpressionParseContext = {},
  ) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private peekAt(offset: number): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType, context: string): Token {
    const token = this.peek();
    if (token.type !== type) {
      throw new ExpressionParseError(
        `Expected ${type} ${context}, got '${token.value || '<eof>'}'`,
      );
    }
    return this.advance();
  }

  parseExpression(): Expression {
    const expr = this.parseLogicalOr();
    if (this.peek().type !== 'eof') {
      throw new ExpressionParseError(
        `Unexpected trailing input starting at '${this.peek().value}'`,
      );
    }
    return expr;
  }

  parseStatement(): Statement {
    const nameToken = this.expect('identifier', 'at start of statement');
    const opToken = this.peek();
    const assignmentOps: AssignmentOperator[] = ['=', '+=', '-=', '*=', '/='];
    if (
      opToken.type !== 'operator' ||
      !assignmentOps.includes(opToken.value as AssignmentOperator)
    ) {
      throw new ExpressionParseError(
        `Expected an assignment operator (=, +=, -=, *=, /=) after '${nameToken.value}', got '${opToken.value || '<eof>'}'`,
      );
    }
    this.advance();
    const value = this.parseLogicalOr();
    if (this.peek().type !== 'eof') {
      throw new ExpressionParseError(
        `Unexpected trailing input starting at '${this.peek().value}'`,
      );
    }
    const statement: AssignmentStatement = {
      kind: 'assignment',
      name: nameToken.value,
      operator: opToken.value as AssignmentOperator,
      value,
    };
    return statement;
  }

  private parseLogicalOr(): Expression {
    let left = this.parseLogicalAnd();
    while (this.peek().type === 'operator' && this.peek().value === '||') {
      this.advance();
      const right = this.parseLogicalAnd();
      left = { kind: 'logical', operator: '||', left, right };
    }
    return left;
  }

  private parseLogicalAnd(): Expression {
    let left = this.parseEquality();
    while (this.peek().type === 'operator' && this.peek().value === '&&') {
      this.advance();
      const right = this.parseEquality();
      left = { kind: 'logical', operator: '&&', left, right };
    }
    return left;
  }

  /** `?`/`has` and `!?`/`hasnt` — Ink's LIST membership tests — both
   * canonicalize to one AST operator ('has'/'hasnt') regardless of
   * which spelling the author used, so the printer doesn't need to
   * remember which one was typed. `has`/`hasnt` are WORD forms (the
   * tokenizer sees them as plain identifiers, not operators), so
   * this checks the identifier's text rather than a token type. */
  private matchListMembershipOperator(): 'has' | 'hasnt' | null {
    const token = this.peek();
    if (token.type === 'operator' && token.value === '?') return 'has';
    if (token.type === 'operator' && token.value === '!?') return 'hasnt';
    if (token.type === 'identifier' && token.value === 'has') return 'has';
    if (token.type === 'identifier' && token.value === 'hasnt') return 'hasnt';
    return null;
  }

  private parseEquality(): Expression {
    let left = this.parseRelational();
    for (;;) {
      if (
        this.peek().type === 'operator' &&
        (this.peek().value === '==' || this.peek().value === '!=')
      ) {
        const operator = this.advance().value as BinaryOperator;
        const right = this.parseRelational();
        left = { kind: 'binary', operator, left, right };
        continue;
      }
      const membershipOp = this.matchListMembershipOperator();
      if (membershipOp) {
        this.advance();
        const right = this.parseRelational();
        left = { kind: 'binary', operator: membershipOp, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseRelational(): Expression {
    let left = this.parseAdditive();
    while (this.peek().type === 'operator' && ['<', '<=', '>', '>='].includes(this.peek().value)) {
      const operator = this.advance().value as BinaryOperator;
      const right = this.parseAdditive();
      left = { kind: 'binary', operator, left, right };
    }
    return left;
  }

  private parseAdditive(): Expression {
    let left = this.parseMultiplicative();
    while (
      this.peek().type === 'operator' &&
      (this.peek().value === '+' || this.peek().value === '-')
    ) {
      const operator = this.advance().value as BinaryOperator;
      const right = this.parseMultiplicative();
      left = { kind: 'binary', operator, left, right };
    }
    return left;
  }

  private parseMultiplicative(): Expression {
    let left = this.parseUnary();
    while (this.peek().type === 'operator' && ['*', '/', '%'].includes(this.peek().value)) {
      const operator = this.advance().value as BinaryOperator;
      const right = this.parseUnary();
      left = { kind: 'binary', operator, left, right };
    }
    return left;
  }

  private parseUnary(): Expression {
    if (
      this.peek().type === 'operator' &&
      (this.peek().value === '-' || this.peek().value === '!')
    ) {
      const operator = this.advance().value as '-' | '!';
      const operand = this.parseUnary();
      return { kind: 'unary', operator, operand };
    }
    return this.parsePrimary();
  }

  /** A single bare identifier's list-member info, from `context`, or
   * null when it isn't one (and should be parsed as a plain
   * variable instead). */
  private listMemberInfo(name: string): { origin: string; ordinal: number } | null {
    return this.context.listMembers?.[name] ?? null;
  }

  private listMemberLiteral(name: string): Expression {
    const info = this.listMemberInfo(name);
    if (!info) throw new ExpressionParseError(`'${name}' is not a known LIST member`);
    const allItems = this.context.listDefinitions?.[info.origin];
    if (!allItems) {
      // A real caller always populates listDefinitions alongside
      // listMembers for every origin it registers — reaching here
      // means the caller passed an inconsistent context. Fail loud
      // rather than fabricating an incomplete allItems that would
      // silently corrupt downstream LIST_ALL/LIST_INVERT/LIST_RANGE.
      throw new ExpressionParseError(
        `list member '${name}' is known but its origin LIST '${info.origin}' has no registered definition — inconsistent parse context`,
      );
    }
    return {
      kind: 'literal',
      value: {
        kind: 'list',
        origin: info.origin,
        items: [{ name, ordinal: info.ordinal }],
        allItems,
      },
    };
  }

  private parsePrimary(): Expression {
    const token = this.peek();
    if (token.type === 'number') {
      this.advance();
      return { kind: 'literal', value: Number(token.value) };
    }
    if (token.type === 'string') {
      this.advance();
      return { kind: 'literal', value: token.value };
    }
    if (token.type === 'identifier') {
      if (token.value === 'true' || token.value === 'false') {
        this.advance();
        return { kind: 'literal', value: token.value === 'true' };
      }
      // Function call: a bare name immediately followed by '(' — only
      // the fixed LIST_* builtins are recognized (no user-defined
      // function-knot interpreter exists yet to run anything else).
      if (this.peekAt(1).type === 'lparen') {
        return this.parseFunctionCall();
      }
      this.advance();
      if (this.listMemberInfo(token.value)) {
        return this.listMemberLiteral(token.value);
      }
      return { kind: 'variable', name: token.value };
    }
    if (token.type === 'lparen') {
      return this.parseParenthesized();
    }
    throw new ExpressionParseError(`Unexpected token '${token.value || '<eof>'}'`);
  }

  private parseFunctionCall(): Expression {
    const name = this.advance().value;
    if (!LIST_FUNCTION_NAMES.has(name)) {
      throw new ExpressionParseError(
        `'${name}' is not a recognized function (only LIST_COUNT, LIST_MIN, LIST_MAX, LIST_ALL, LIST_RANGE, LIST_VALUE, LIST_INVERT are supported)`,
      );
    }
    this.expect('lparen', `after function name '${name}'`);
    const args: Expression[] = [];
    if (this.peek().type !== 'rparen') {
      args.push(this.parseLogicalOr());
      while (this.peek().type === 'comma') {
        this.advance();
        args.push(this.parseLogicalOr());
      }
    }
    this.expect('rparen', `to close call to '${name}'`);
    return { kind: 'listFunction', name: name as ListFunctionName, args };
  }

  /**
   * `(`, after ruling out a function call, is one of three things:
   * an empty LIST literal `()`, a multi-member LIST literal
   * `(member1, member2)`, or a plain parenthesized sub-expression.
   * Disambiguated by looking at what's immediately inside: nothing
   * (empty list), or a bare identifier that's a known list member
   * AND is followed by a comma or the closing paren (unambiguously a
   * list literal — a normal sub-expression starting with a list
   * member would still need to continue with an operator, not a
   * comma/close-paren, to mean anything else).
   */
  private parseParenthesized(): Expression {
    this.advance(); // '('
    if (this.peek().type === 'rparen') {
      this.advance();
      return { kind: 'literal', value: { kind: 'list', origin: '', items: [], allItems: [] } };
    }
    const first = this.peek();
    const looksLikeListLiteral =
      first.type === 'identifier' &&
      this.listMemberInfo(first.value) !== null &&
      (this.peekAt(1).type === 'comma' || this.peekAt(1).type === 'rparen');
    if (looksLikeListLiteral) {
      const items: { name: string; info: { origin: string; ordinal: number } }[] = [];
      for (;;) {
        const nameToken = this.expect('identifier', 'as a LIST member in a list literal');
        const info = this.listMemberInfo(nameToken.value);
        if (!info) {
          throw new ExpressionParseError(`'${nameToken.value}' is not a known LIST member`);
        }
        if (items.length > 0 && info.origin !== items[0].info.origin) {
          // A list literal's members must all come from the SAME
          // declared LIST — mixing origins would produce a ListValue
          // whose `items` claims a member absent from its own
          // `allItems` (that member's real origin's definition),
          // silently corrupting any downstream LIST_ALL/LIST_INVERT/
          // LIST_RANGE on the value.
          throw new ExpressionParseError(
            `list literal mixes members from different LISTs ('${items[0].name}' is from ${items[0].info.origin}, '${nameToken.value}' is from ${info.origin})`,
          );
        }
        items.push({ name: nameToken.value, info });
        if (this.peek().type === 'comma') {
          this.advance();
          continue;
        }
        break;
      }
      this.expect('rparen', "to close list literal '('");
      const origin = items[0].info.origin;
      const allItems = this.context.listDefinitions?.[origin];
      if (!allItems) {
        throw new ExpressionParseError(
          `list member '${items[0].name}' is known but its origin LIST '${origin}' has no registered definition — inconsistent parse context`,
        );
      }
      return {
        kind: 'literal',
        value: {
          kind: 'list',
          origin,
          items: items.map((i) => ({ name: i.name, ordinal: i.info.ordinal })),
          allItems,
        },
      };
    }
    const expr = this.parseLogicalOr();
    this.expect('rparen', "to close '('");
    return expr;
  }
}

export function parseExpression(source: string, context?: ExpressionParseContext): Expression {
  return new Parser(tokenize(source), context).parseExpression();
}

export function parseStatement(source: string, context?: ExpressionParseContext): Statement {
  return new Parser(tokenize(source), context).parseStatement();
}

// === Printer ===
//
// Re-prints an AST back to the canonical textual surface, adding
// parentheses only where precedence would otherwise change the
// parsed meaning — so `parseExpression(printExpression(e))` always
// reproduces an AST equivalent to `e`, without the output being more
// cluttered with parens than necessary.

const BINARY_PRECEDENCE: Record<BinaryOperator, number> = {
  '==': 3,
  '!=': 3,
  has: 3,
  hasnt: 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const LOGICAL_PRECEDENCE: Record<LogicalOperator, number> = {
  '||': 1,
  '&&': 2,
};

function precedenceOf(expr: Expression): number {
  if (expr.kind === 'binary') return BINARY_PRECEDENCE[expr.operator];
  if (expr.kind === 'logical') return LOGICAL_PRECEDENCE[expr.operator];
  // literal / variable / unary / listFunction never need wrapping
  // based on their own precedence — unary binds tighter than every
  // binary/logical operator, and the rest are atomic (a call's own
  // parens already delimit it).
  return Infinity;
}

function printValue(value: VariableValue): string {
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value !== 'object') return String(value);
  // ListValue: () for empty, a bare name for a single member, a
  // parenthesized comma list for several — same forms the parser
  // accepts back, in declaration order (not insertion order) so a
  // round-trip is stable regardless of how the items were combined.
  if (value.items.length === 0) return '()';
  const sorted = [...value.items].sort((a, b) => a.ordinal - b.ordinal);
  const names = sorted.map((item) => item.name);
  return names.length === 1 ? names[0] : `(${names.join(', ')})`;
}

/**
 * Every precedence tier in this grammar parses strictly
 * left-associatively (`a - b - c` always builds `(a - b) - c`, never
 * `a - (b - c)` — and the same is true of every other operator, not
 * just the non-associative ones). So the only way a right-nested
 * same-precedence child can exist in the AST at all is if the source
 * had explicit parens there, and the printer must put them back or
 * the reprinted source parses into a different tree. A left child at
 * the same precedence is exactly what plain left-to-right parsing
 * already produces with no parens, so it only needs them at strictly
 * lower precedence.
 */
function printChild(child: Expression, parentPrecedence: number, isRightOperand: boolean): string {
  const childPrecedence = precedenceOf(child);
  const needsParens = isRightOperand
    ? childPrecedence <= parentPrecedence
    : childPrecedence < parentPrecedence;
  const printed = printExpression(child);
  return needsParens ? `(${printed})` : printed;
}

export function printExpression(expr: Expression): string {
  switch (expr.kind) {
    case 'literal':
      return printValue(expr.value);
    case 'variable':
      return expr.name;
    case 'unary': {
      const operandPrecedence = precedenceOf(expr.operand);
      const operand = printExpression(expr.operand);
      // Unary binds tighter than every binary/logical operator, so
      // the operand only needs parens if it itself is a binary/
      // logical expression (finite precedence).
      return operandPrecedence < Infinity
        ? `${expr.operator}(${operand})`
        : `${expr.operator}${operand}`;
    }
    case 'binary': {
      const precedence = BINARY_PRECEDENCE[expr.operator];
      const left = printChild(expr.left, precedence, false);
      const right = printChild(expr.right, precedence, true);
      return `${left} ${expr.operator} ${right}`;
    }
    case 'logical': {
      const precedence = LOGICAL_PRECEDENCE[expr.operator];
      const left = printChild(expr.left, precedence, false);
      const right = printChild(expr.right, precedence, true);
      return `${left} ${expr.operator} ${right}`;
    }
    case 'listFunction':
      return `${expr.name}(${expr.args.map((arg) => printExpression(arg)).join(', ')})`;
  }
}

export function printStatement(stmt: Statement): string {
  return `${stmt.name} ${stmt.operator} ${printExpression(stmt.value)}`;
}
