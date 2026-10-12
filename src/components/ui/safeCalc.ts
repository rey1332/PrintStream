export type CalcResult = { ok: boolean; value?: number; error?: string };

const MAX_LENGTH = 500;
const MAX_DEPTH = 64;

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log10,
  ln: Math.log,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  max: Math.max,
  min: Math.min,
};
const VARIADIC = new Set(['max', 'min']);

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string };

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d*)?|\.\d+)|([a-z]+)|([-+*/%^(),]))/giy;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match) return /^\s*$/.test(text.slice(index)) ? tokens : null;
    if (match[1] !== undefined) tokens.push({ kind: 'num', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ kind: 'name', value: match[2] });
    else tokens.push({ kind: 'op', value: match[3] });
    index = pattern.lastIndex;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private depth = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): number {
    const value = this.expr();
    if (this.pos !== this.tokens.length) throw new Error('Invalid expression');
    return value;
  }

  private peekOp(...ops: string[]): string | null {
    const t = this.tokens[this.pos];
    return t?.kind === 'op' && ops.includes(t.value) ? t.value : null;
  }

  private expect(op: string) {
    if (!this.peekOp(op)) throw new Error('Invalid expression');
    this.pos += 1;
  }

  private nested<T>(fn: () => T): T {
    if (++this.depth > MAX_DEPTH) throw new Error('Expression is too deep');
    try {
      return fn();
    } finally {
      this.depth -= 1;
    }
  }

  private expr(): number {
    let value = this.term();
    for (let op = this.peekOp('+', '-'); op; op = this.peekOp('+', '-')) {
      this.pos += 1;
      value = op === '+' ? value + this.term() : value - this.term();
    }
    return value;
  }

  private term(): number {
    let value = this.unary();
    for (let op = this.peekOp('*', '/', '%'); op; op = this.peekOp('*', '/', '%')) {
      this.pos += 1;
      const right = this.unary();
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }

  private unary(): number {
    const op = this.peekOp('+', '-');
    if (op) {
      this.pos += 1;
      return this.nested(() => (op === '-' ? -this.unary() : this.unary()));
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (!this.peekOp('^')) return base;
    this.pos += 1;
    return base ** this.nested(() => this.unary());
  }

  private primary(): number {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('Invalid expression');
    if (t.kind === 'num') {
      this.pos += 1;
      return t.value;
    }
    if (t.kind === 'op' && t.value === '(') {
      this.pos += 1;
      const value = this.nested(() => this.expr());
      this.expect(')');
      return value;
    }
    if (t.kind === 'name') {
      this.pos += 1;
      if (t.value.toLowerCase() === 'pi') return Math.PI;
      if (t.value === 'e') return Math.E;
      const name = t.value.toLowerCase();
      const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
      if (!fn || !this.peekOp('(')) throw new Error('Invalid expression');
      this.pos += 1;
      const args = [this.nested(() => this.expr())];
      while (this.peekOp(',')) {
        this.pos += 1;
        args.push(this.nested(() => this.expr()));
      }
      this.expect(')');
      if (!VARIADIC.has(name) && args.length !== 1) throw new Error('Invalid expression');
      return fn(...args);
    }
    throw new Error('Invalid expression');
  }
}

export function safeCalc(expr: string): CalcResult {
  const cleaned = expr.replace(/\s+/g, '');
  if (!cleaned || cleaned.length > MAX_LENGTH) return { ok: false };
  if (!/^[0-9+\-*/%^().,a-z]+$/i.test(cleaned)) return { ok: false };
  if (!/\d/.test(cleaned)) return { ok: false };
  if (!/[+\-*/%^()]/.test(cleaned)) return { ok: false };

  const tokens = tokenize(cleaned);
  if (!tokens) return { ok: false };
  const known = (name: string) =>
    /^pi$/i.test(name) || name === 'e' || Object.hasOwn(FUNCTIONS, name.toLowerCase());
  if (tokens.some((t) => t.kind === 'name' && !known(t.value))) return { ok: false };

  try {
    const value = new Parser(tokens).parse();
    if (!Number.isFinite(value)) return { ok: true, error: 'Not a finite number' };
    return { ok: true, value };
  } catch (error) {
    return { ok: true, error: (error as Error).message || 'Invalid expression' };
  }
}
