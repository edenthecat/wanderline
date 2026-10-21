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
 * Deliberately NOT supported yet (not needed until Phase 10): Ink's
 * `LIST` values, function calls, and the `MOD`/`and`/`or`/`not`
 * word-form operators (Ink accepts both symbol and word forms for
 * logical operators; only the symbol forms `&&`/`||`/`!` are
 * recognized here — a dialect or Ink-source normalization step can
 * translate word-forms to symbol-forms before calling this parser).
 */

import type {
  AssignmentOperator,
  AssignmentStatement,
  BinaryOperator,
  Expression,
  LogicalOperator,
  Statement,
  VariableValue,
} from './expression-types.js';

export class ExpressionParseError extends Error {}

// === Tokenizer ===

type TokenType = 'number' | 'string' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'eof';

interface Token {
  type: TokenType;
  value: string;
}

const MULTI_CHAR_OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/='];
const SINGLE_CHAR_OPERATORS = ['+', '-', '*', '/', '%', '<', '>', '=', '!'];

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
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
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

  private parseEquality(): Expression {
    let left = this.parseRelational();
    while (
      this.peek().type === 'operator' &&
      (this.peek().value === '==' || this.peek().value === '!=')
    ) {
      const operator = this.advance().value as BinaryOperator;
      const right = this.parseRelational();
      left = { kind: 'binary', operator, left, right };
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
      this.advance();
      return { kind: 'variable', name: token.value };
    }
    if (token.type === 'lparen') {
      this.advance();
      const expr = this.parseLogicalOr();
      this.expect('rparen', "to close '('");
      return expr;
    }
    throw new ExpressionParseError(`Unexpected token '${token.value || '<eof>'}'`);
  }
}

export function parseExpression(source: string): Expression {
  return new Parser(tokenize(source)).parseExpression();
}

export function parseStatement(source: string): Statement {
  return new Parser(tokenize(source)).parseStatement();
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
  // literal / variable / unary never need wrapping based on their own
  // precedence — unary binds tighter than every binary/logical
  // operator, and literal/variable are atomic.
  return Infinity;
}

function printValue(value: VariableValue): string {
  if (typeof value === 'string') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return String(value);
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
  }
}

export function printStatement(stmt: Statement): string {
  return `${stmt.name} ${stmt.operator} ${printExpression(stmt.value)}`;
}
