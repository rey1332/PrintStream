export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'neg'; arg: Expr }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '%'; left: Expr; right: Expr }
  | { kind: 'call'; fn: MathFn; args: Expr[] };

const FUNCTIONS = { abs: 1, round: 1, floor: 1, ceil: 1, sqrt: 1, min: -1, max: -1 } as const;
type MathFn = keyof typeof FUNCTIONS;

export class ExpressionError extends Error {
  code: 'syntax' | 'unknownName' | 'arity' | 'tooLong';
  detail: string;
  constructor(code: ExpressionError['code'], detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

const MAX_LENGTH = 500;
const MAX_DEPTH = 40;

type Token =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string; quoted?: boolean }
  | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      tokens.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const quoted = /^\[([^[\]]{1,120})\]/.exec(src.slice(i));
    if (quoted) {
      tokens.push({ t: 'id', v: quoted[1], quoted: true });
      i += quoted[0].length;
      continue;
    }
    // `Math.round` is accepted as an alias of `round` for formulas saved earlier.
    const id = /^(Math\.)?[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) {
      tokens.push({ t: 'id', v: id[0].replace(/^Math\./, '') });
      i += id[0].length;
      continue;
    }
    if ('+-*/%(),'.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new ExpressionError('syntax', c);
  }
  return tokens;
}

export function parseExpression(src: string, variables: readonly string[]): Expr {
  if (src.length > MAX_LENGTH) throw new ExpressionError('tooLong');
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExpressionError('syntax', v);
    pos++;
  };

  function expr(depth: number): Expr {
    if (depth > MAX_DEPTH) throw new ExpressionError('syntax', 'nesting');
    let left = term(depth);
    while (isOp('+') || isOp('-')) {
      const op = (tokens[pos++] as { v: '+' | '-' }).v;
      left = { kind: 'bin', op, left, right: term(depth) };
    }
    return left;
  }
  function term(depth: number): Expr {
    let left = unary(depth);
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (tokens[pos++] as { v: '*' | '/' | '%' }).v;
      left = { kind: 'bin', op, left, right: unary(depth) };
    }
    return left;
  }
  function unary(depth: number): Expr {
    if (isOp('-')) {
      pos++;
      return { kind: 'neg', arg: unary(depth + 1) };
    }
    if (isOp('+')) {
      pos++;
      return unary(depth + 1);
    }
    return primary(depth);
  }
  function primary(depth: number): Expr {
    const tok = peek();
    if (!tok) throw new ExpressionError('syntax', 'end');
    if (tok.t === 'num') {
      pos++;
      return { kind: 'num', value: tok.v };
    }
    if (tok.t === 'op' && tok.v === '(') {
      pos++;
      const e = expr(depth + 1);
      expect(')');
      return e;
    }
    if (tok.t === 'id') {
      pos++;
      if (isOp('(')) {
        if (tok.quoted || !(tok.v in FUNCTIONS)) throw new ExpressionError('unknownName', tok.v);
        pos++;
        const args: Expr[] = [];
        if (!isOp(')')) {
          args.push(expr(depth + 1));
          while (isOp(',')) {
            pos++;
            args.push(expr(depth + 1));
          }
        }
        expect(')');
        const arity = FUNCTIONS[tok.v as MathFn];
        if ((arity === -1 && args.length === 0) || (arity !== -1 && args.length !== arity))
          throw new ExpressionError('arity', tok.v);
        return { kind: 'call', fn: tok.v as MathFn, args };
      }
      if (!variables.includes(tok.v)) throw new ExpressionError('unknownName', tok.v);
      return { kind: 'var', name: tok.v };
    }
    throw new ExpressionError('syntax', tok.v);
  }

  const result = expr(0);
  if (pos !== tokens.length) throw new ExpressionError('syntax', String(tokens[pos].v));
  return result;
}

export function evaluate(expr: Expr, vars: Record<string, number>): number | null {
  const value = evalNode(expr, vars);
  return Number.isFinite(value) ? value : null;
}

function evalNode(e: Expr, vars: Record<string, number>): number {
  switch (e.kind) {
    case 'num':
      return e.value;
    case 'var':
      return vars[e.name] ?? NaN;
    case 'neg':
      return -evalNode(e.arg, vars);
    case 'bin': {
      const l = evalNode(e.left, vars);
      const r = evalNode(e.right, vars);
      switch (e.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          return l / r;
        case '%':
          return l % r;
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'call': {
      const args = e.args.map((a) => evalNode(a, vars));
      switch (e.fn) {
        case 'abs':
          return Math.abs(args[0]);
        case 'round':
          return Math.round(args[0]);
        case 'floor':
          return Math.floor(args[0]);
        case 'ceil':
          return Math.ceil(args[0]);
        case 'sqrt':
          return Math.sqrt(args[0]);
        case 'min':
          return Math.min(...args);
        case 'max':
          return Math.max(...args);
      }
    }
  }
  return NaN;
}
