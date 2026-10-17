// Terminal remote MCP sources (20261012000048): what a sync of an MCP
// server reads — the result of one approved tool called with fixed
// arguments, or one resource — and how results become records. Pure
// functions shared by the screens, the app and the worker.
//
// Tool descriptions come from the server and are shown as quoted text only;
// PrintStream never treats them as instructions.

import { flattenRecord, getPath, isFieldPath } from './restSource';

export interface McpSource {
  mode: 'mcp';
  /** A tool's result, or a resource's contents. */
  what: 'tool' | 'resource';
  /** The tool's name, or the resource's URI. */
  name: string;
  /** Tool arguments: a JSON object (text). */
  arguments: string;
  /** Where the records are in a JSON result ("" for the result itself). */
  records: string;
  key: string | null;
}

export interface McpTool {
  name: string;
  title: string | null;
  description: string | null;
  input_schema: Record<string, unknown> | null;
  read_only: boolean | null;
}

export const MAX_ARGUMENTS = 20_000;
const TOOL_NAME_RE = /^[A-Za-z0-9_.\-/]{1,128}$/;

/** The source to keep, or null when something is missing or wrong. */
export function parseMcpSource(v: any): McpSource | null {
  if (!v || typeof v !== 'object' || v.mode !== 'mcp') return null;
  const what = v.what === 'resource' ? 'resource' : v.what === 'tool' ? 'tool' : null;
  if (!what || typeof v.name !== 'string') return null;
  const name = v.name.trim();
  if (what === 'tool' && !TOOL_NAME_RE.test(name)) return null;
  if (what === 'resource' && (!name || name.length > 1000 || /\s/.test(name))) return null;
  const args = typeof v.arguments === 'string' && v.arguments.trim() ? v.arguments.trim() : '{}';
  if (args.length > MAX_ARGUMENTS) return null;
  try {
    const parsed = JSON.parse(args);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }
  const records = v.records ?? '';
  if (!isFieldPath(records, true)) return null;
  const key = v.key == null || v.key === '' ? null : v.key;
  if (key !== null && (typeof key !== 'string' || key.length > 60)) return null;
  return {
    mode: 'mcp',
    what,
    name,
    arguments: what === 'tool' ? args : '{}',
    records,
    key,
  };
}

/** What a sync of this source is called on the screens. */
export const mcpSourceLabel = (s: McpSource) =>
  `${s.what === 'tool' ? 'tool' : 'resource'} ${s.name}`.slice(0, 200);

/** JSON with keys sorted, so equal values always give equal text (for hashes). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson((value as any)[k])}`)
    .join(',')}}`;
}

/** Text that might be JSON: the value, or undefined. */
function tryJson(text: string): unknown {
  const t = text.trim();
  if (!t || !'[{'.includes(t[0])) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function recordsOf(value: unknown, path: string): unknown[] {
  const found = getPath(value, path);
  if (Array.isArray(found)) return found;
  if (found && typeof found === 'object') return [found];
  return found === undefined || found === null ? [] : [{ value: found }];
}

/**
 * A tool result as records: its structured content, else JSON text content,
 * else one record per content item (type and text).
 */
export function toolResultRows(result: any, path: string): Record<string, unknown>[] {
  if (result?.structuredContent && typeof result.structuredContent === 'object')
    return recordsOf(result.structuredContent, path).map(flattenRecord);
  const content: any[] = Array.isArray(result?.content) ? result.content : [];
  const texts = content.filter((c) => c?.type === 'text' && typeof c.text === 'string');
  if (texts.length === 1) {
    const json = tryJson(texts[0].text);
    if (json !== undefined) return recordsOf(json, path).map(flattenRecord);
  }
  const rows: Record<string, unknown>[] = [];
  for (const c of content) {
    if (c?.type === 'text') {
      const json = tryJson(String(c.text ?? ''));
      if (json !== undefined) rows.push(...recordsOf(json, path).map(flattenRecord));
      else rows.push({ type: 'text', text: String(c.text ?? '') });
    } else if (c?.type === 'resource' && c.resource)
      rows.push({ type: 'resource', uri: c.resource.uri ?? null, text: c.resource.text ?? null });
    else if (c?.type === 'resource_link')
      rows.push({ type: 'resource_link', uri: c.uri ?? null, text: c.name ?? null });
    // Images and audio are not kept as data.
  }
  return rows;
}

/** A resource's contents as records: JSON when it is JSON, else its text. */
export function resourceRows(result: any, path: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const c of Array.isArray(result?.contents) ? result.contents : []) {
    if (typeof c?.text !== 'string') continue;
    const json = tryJson(c.text);
    if (json !== undefined) rows.push(...recordsOf(json, path).map(flattenRecord));
    else rows.push({ uri: c.uri ?? null, mime_type: c.mimeType ?? null, text: c.text });
  }
  return rows;
}

/** A starting set of arguments from a tool's input schema (defaults, else empty values). */
export function argumentsTemplate(schema: any): string {
  const out: Record<string, unknown> = {};
  const props = schema && typeof schema === 'object' ? (schema.properties ?? {}) : {};
  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  for (const [k, p] of Object.entries<any>(props)) {
    if (p && Object.hasOwn(p, 'default')) out[k] = p.default;
    else if (required.includes(k))
      out[k] =
        p?.type === 'number' || p?.type === 'integer'
          ? 0
          : p?.type === 'boolean'
            ? false
            : p?.type === 'array'
              ? []
              : p?.type === 'object'
                ? {}
                : '';
  }
  return JSON.stringify(out, null, 2);
}
