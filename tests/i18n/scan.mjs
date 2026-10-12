import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const EXCLUDED = new Set([
  'src/components/ui/DevConsole.tsx',
  'src/components/ui/devConsoleChat.ts',
  'src/components/ui/DinoGame.tsx',
]);

// Individual strings intentionally left as-is, with the reason.
const KNOWN_EXCEPTIONS = [
  { file: 'src/app/page.tsx', text: /^ETNA Realtime Console$|^Press ` to toggle/ },
];

const VISIBLE_ATTRIBUTES = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'description', 'confirmLabel', 'message']);
const MESSAGE_CALLS = /^(toast(\.\w+)?|set\w*(Error|Message)|alert|confirm)$/;

// Tokens that are the same in every language (brands, codes, units, symbols).
const ALLOWED = /^(ETNA|ERP|CSV|RMB|Del|ms|JSON|XLSX|PDF|SKU|ID|USD|OK|KDE|QQ|R²|VaR|CVaR|ETNA-XXXXX-XXXXX-XXXXX-XXXXX|MB|RESTORE|RESEND_API_KEY|EMAIL_FROM|••••••••|admin@business\.com|finance@business\.com\\nmanager@business\.com)$/;

function looksLikeText(value) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || ALLOWED.test(text)) return false;
  // Developer invariants (never shown to users), abbreviations, sample emails.
  if (/must be used within/.test(text)) return false;
  if (/^[·\s]*(PO|SO|SKU|ID)[·\s]*$/.test(text)) return false;
  if (/^([\w.+-]+@[\w-]+\.[\w.]+\s*)+$/.test(text)) return false;
  // CSS values and Tailwind class lists (lowercase tokens with -, [, :, /, var()).
  if (/^var\(|^#[0-9a-f]{3,8}$/i.test(text)) return false;
  if (!/[A-Z]/.test(text) && /^[a-z0-9\-[\]().:/%#!_ ]+$/.test(text) && /[-[:]/.test(text)) return false;
  // Needs at least one word of two or more letters (Latin or CJK).
  return /[A-Za-z]{2,}|[一-鿿]/.test(text) && !/^[\w.-]+\.(csv|json|xlsx|png|svg)$/i.test(text);
}

function listSourceFiles() {
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = path.posix.join(dir, name);
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) files.push(rel);
    }
  })('src');
  return files;
}

export function reachableUiFiles() {
  const all = listSourceFiles();
  const resolve = (from, spec) => {
    let base;
    if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else return null;
    return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => all.includes(c)) ?? null;
  };
  const entries = all.filter((f) => /\/(page|layout|not-found)\.tsx$/.test(f));
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || EXCLUDED.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(/(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const next = resolve(file, match[1]);
      if (next) queue.push(next);
    }
  }
  return [...seen].filter((f) => f.endsWith('.tsx') && !f.startsWith('src/lib/i18n/')).sort();
}

function isInsideJsxExpression(node) {
  for (let p = node.parent; p; p = p.parent) {
    // Values of style={{...}} and similar objects are never rendered text.
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) return false;
    if (ts.isJsxExpression(p)) {
      // Attribute values count only for visible attributes (handled separately).
      return !ts.isJsxAttribute(p.parent);
    }
    if (ts.isCallExpression(p) || ts.isFunctionLike(p) || ts.isBinaryExpression(p) && p.operatorToken.kind !== ts.SyntaxKind.BarBarToken && p.operatorToken.kind !== ts.SyntaxKind.QuestionQuestionToken && p.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return false;
    if (ts.isElementAccessExpression(p) || ts.isPropertyAccessExpression(p) || ts.isArrayLiteralExpression(p) && !ts.isJsxExpression(p.parent)) return false;
    if (ts.isJsxAttribute(p)) return false;
  }
  return false;
}

function calleeName(call) {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = ts.isIdentifier(expr.expression) ? expr.expression.text : '';
    return left ? `${left}.${expr.name.text}` : expr.name.text;
  }
  return '';
}

export function scanFile(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const report = (node, text, kind) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (KNOWN_EXCEPTIONS.some((e) => e.file === file && e.text.test(clean))) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file, line: line + 1, text: clean.slice(0, 80), kind });
  };

  function visit(node) {
    if (ts.isJsxText(node) && looksLikeText(node.text)) report(node, node.text, 'jsx-text');

    if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) && looksLikeText(init.text)) report(init, init.text, 'attribute');
      if (ts.isJsxExpression(init) && init.expression && (ts.isStringLiteral(init.expression) || ts.isNoSubstitutionTemplateLiteral(init.expression)) && looksLikeText(init.expression.text)) {
        report(init, init.expression.text, 'attribute');
      }
    }

    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && looksLikeText(node.text) && isInsideJsxExpression(node)) {
      report(node, node.text, 'jsx-expression');
    }
    if (ts.isTemplateExpression(node) && isInsideJsxExpression(node)) {
      const pieces = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
      if (looksLikeText(pieces)) report(node, pieces, 'jsx-template');
    }

    if ((ts.isCallExpression(node) && MESSAGE_CALLS.test(calleeName(node))) || (ts.isNewExpression(node) && node.expression.getText(sf) === 'Error')) {
      for (const arg of node.arguments ?? []) {
        const literals = [];
        const collect = (n) => {
          if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.push(n);
          else if (ts.isTemplateExpression(n)) literals.push(n);
          else if (ts.isConditionalExpression(n)) { collect(n.whenTrue); collect(n.whenFalse); }
          else if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.BarBarToken || n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) { collect(n.left); collect(n.right); }
        };
        collect(arg);
        for (const lit of literals) {
          const text = ts.isTemplateExpression(lit) ? [lit.head.text, ...lit.templateSpans.map((s) => s.literal.text)].join(' ') : lit.text;
          if (looksLikeText(text)) report(lit, text, 'message');
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return findings;
}

export function scanAll() {
  return reachableUiFiles().flatMap(scanFile);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const findings = scanAll();
  const byFile = new Map();
  for (const f of findings) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  const detail = process.argv.includes('--detail');
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(4)}  ${file}`);
    if (detail || process.argv.includes(file)) {
      for (const f of findings.filter((x) => x.file === file)) console.log(`        ${f.line}: [${f.kind}] ${f.text}`);
    }
  }
  console.log(`total ${findings.length} in ${byFile.size} files (scanned ${reachableUiFiles().length})`);
  // Every user-visible string goes through t(); any finding fails the check.
  if (findings.length > 0) process.exitCode = 1;
}
