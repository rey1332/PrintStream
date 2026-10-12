// TERMINAL REST sources (20261012000046): what a sync of a generic REST API
// reads (one endpoint, its pagination, where the records are), and how JSON
// records become dataset columns. Checked the same way by the screens, the
// app and the worker; pure functions, no network.

import type { ColumnType } from './tabular';
import { isDbName } from './dbSource';

export type PaginationStyle = 'none' | 'page' | 'offset' | 'cursor' | 'next_url' | 'link';
export const PAGINATION_STYLES: readonly PaginationStyle[] = [
  'none',
  'page',
  'offset',
  'cursor',
  'next_url',
  'link',
];

export interface Pagination {
  style: PaginationStyle;
  /** page: the page number's parameter, and the first page's number (0 or 1). */
  page_param?: string;
  first_page?: number;
  /** page, offset, cursor: the page size's parameter and value. */
  size_param?: string;
  size?: number;
  /** offset: the offset's parameter. */
  offset_param?: string;
  /** cursor: the parameter that carries the cursor. */
  cursor_param?: string;
  /**
   * cursor: where the next cursor is in the answer (a path such as
   * "meta.next_cursor"), or "$last.<field>" for a field of the page's last
   * record (Stripe's starting_after).
   */
  cursor_path?: string;
  /** next_url: where the next page's address is in the answer. */
  next_path?: string;
  /** Any style: a true/false field saying whether there are more pages. */
  has_more_path?: string;
  /** Pagination parameters go in the query, or (POST) in the JSON body. */
  params_in?: 'query' | 'body';
}

export interface RestSource {
  mode: 'rest';
  method: 'GET' | 'POST';
  /** Below the connection's base address: /v1/customers */
  path: string;
  query: [string, string][];
  /** POST-as-query: a JSON object sent with every request. */
  body?: string | null;
  /** Where the list of records is in the answer ("" when the answer is the list). */
  records: string;
  pagination: Pagination;
  /** The parameter that asks for records changed since the last run (incremental). */
  since_param?: string | null;
  key?: string | null;
  changed?: string | null;
}

export const MAX_REST_PAGE_SIZE = 10_000;
export const MAX_QUERY_PARAMS = 30;
export const MAX_REST_BODY = 20_000;
export const MAX_REST_COLUMNS = 200;
/** How deep nested objects are spread into columns ("customer.address.city"). */
export const FLATTEN_DEPTH = 3;

const PARAM_RE = /^[A-Za-z0-9_.\-[\]$:]{1,100}$/;
const FIELD_PATH_RE = /^[A-Za-z0-9_$@-]+(\.[A-Za-z0-9_$@-]+){0,9}$/;

export const isParamName = (v: unknown): v is string => typeof v === 'string' && PARAM_RE.test(v);
/** A path into a JSON answer ("data.items"), or "" for the answer itself. */
export const isFieldPath = (v: unknown, allowEmpty = false): v is string =>
  typeof v === 'string' && (v === '' ? allowEmpty : FIELD_PATH_RE.test(v));

/** An endpoint below the base address: starts with one "/", no "..", no spaces. */
export function isEndpointPath(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= 500 &&
    /^\/(?!\/)[^\s?#]*$/.test(v) &&
    !v.split('/').some((part) => part === '..' || part === '.')
  );
}

const optName = (v: unknown) => (v == null || v === '' ? null : v);

function parsePagination(v: any): Pagination | null {
  if (!v || typeof v !== 'object' || !PAGINATION_STYLES.includes(v.style)) return null;
  const p: Pagination = { style: v.style };
  const params_in = v.params_in === 'body' ? 'body' : 'query';
  const name = (key: keyof Pagination, required: boolean): boolean => {
    const value = optName(v[key]);
    if (value === null) return !required;
    if (!isParamName(value)) return false;
    (p as any)[key] = value;
    return true;
  };
  const size = (required: boolean): boolean => {
    if (v.size == null || v.size === '') return !required;
    const n = Number(v.size);
    if (!Number.isInteger(n) || n < 1 || n > MAX_REST_PAGE_SIZE) return false;
    p.size = n;
    return true;
  };
  switch (v.style) {
    case 'page':
      if (!name('page_param', true) || !name('size_param', false) || !size(!!p.size_param))
        return null;
      p.first_page = Number(v.first_page) === 0 ? 0 : 1;
      break;
    case 'offset':
      if (!name('offset_param', true) || !name('size_param', true) || !size(true)) return null;
      break;
    case 'cursor':
      if (!name('cursor_param', true) || !name('size_param', false) || !size(!!p.size_param))
        return null;
      if (
        typeof v.cursor_path !== 'string' ||
        !(v.cursor_path.startsWith('$last.')
          ? isFieldPath(v.cursor_path.slice(6))
          : isFieldPath(v.cursor_path))
      )
        return null;
      p.cursor_path = v.cursor_path;
      break;
    case 'next_url':
      if (!isFieldPath(v.next_path)) return null;
      p.next_path = v.next_path;
      break;
  }
  if (v.style !== 'none' && v.style !== 'next_url' && v.style !== 'link') p.params_in = params_in;
  const more = optName(v.has_more_path);
  if (more !== null) {
    if (!isFieldPath(more)) return null;
    p.has_more_path = more as string;
  }
  return p;
}

/** The source to keep, or null when something is missing or wrong. */
export function parseRestSource(v: any): RestSource | null {
  if (!v || typeof v !== 'object' || v.mode !== 'rest') return null;
  const method = v.method === 'POST' ? 'POST' : v.method === 'GET' ? 'GET' : null;
  if (!method || !isEndpointPath(v.path)) return null;
  const query: [string, string][] = [];
  if (v.query != null) {
    if (!Array.isArray(v.query) || v.query.length > MAX_QUERY_PARAMS) return null;
    for (const pair of v.query) {
      if (!Array.isArray(pair) || pair.length !== 2) return null;
      const [k, val] = pair;
      if (!isParamName(k) || typeof val !== 'string' || val.length > 1000) return null;
      query.push([k, val]);
    }
  }
  let body: string | null = null;
  if (v.body != null && v.body !== '') {
    if (method !== 'POST' || typeof v.body !== 'string' || v.body.length > MAX_REST_BODY)
      return null;
    try {
      const parsed = JSON.parse(v.body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    } catch {
      return null;
    }
    body = v.body;
  }
  const records = v.records ?? '';
  if (!isFieldPath(records, true)) return null;
  const pagination = parsePagination(v.pagination ?? { style: 'none' });
  if (!pagination) return null;
  if (pagination.params_in === 'body' && method !== 'POST') return null;
  const since_param = optName(v.since_param);
  if (since_param !== null && !isParamName(since_param)) return null;
  const key = optName(v.key);
  const changed = optName(v.changed);
  if (key !== null && !isDbName(key)) return null;
  if (changed !== null && !isDbName(changed)) return null;
  return {
    mode: 'rest',
    method,
    path: v.path,
    query,
    body,
    records,
    pagination,
    since_param: since_param as string | null,
    key: key as string | null,
    changed: changed as string | null,
  };
}

/** What a sync of this endpoint is called on the screens. */
export const restSourceLabel = (s: RestSource) => `${s.method} ${s.path}`.slice(0, 200);

// ─── Reading answers ─────────────────────────────────────────────────────────

/** The value at a path ("data.items", "items.0.id"); "" is the value itself. */
export function getPath(value: unknown, path: string): unknown {
  if (path === '') return value;
  let v: any = value;
  for (const part of path.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, part)) return undefined;
    v = v[part];
  }
  return v;
}

/** A copy of a JSON object with the value at a path set (for paging in POST bodies). */
export function setPath(target: Record<string, any>, path: string, value: unknown) {
  const parts = path.split('.');
  let v: any = target;
  for (const part of parts.slice(0, -1)) {
    if (v[part] === null || typeof v[part] !== 'object') v[part] = {};
    v = v[part];
  }
  v[parts[parts.length - 1]] = value;
}

/**
 * One record as dataset values: nested objects spread into "a.b" columns (up
 * to FLATTEN_DEPTH levels), lists and deeper objects kept as JSON text.
 */
export function flattenRecord(record: unknown): Record<string, unknown> {
  if (record === null || typeof record !== 'object' || Array.isArray(record))
    return { value: record === undefined ? null : scalar(record) };
  const out: Record<string, unknown> = {};
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && depth < FLATTEN_DEPTH)
        walk(v as Record<string, unknown>, name, depth + 1);
      else out[name] = scalar(v);
    }
  };
  walk(record as Record<string, unknown>, '', 1);
  return out;
}

const scalar = (v: unknown) =>
  v !== null && typeof v === 'object' ? JSON.stringify(v) : v === undefined ? null : v;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The column type that fits every value seen (nulls do not count). */
export function inferType(values: unknown[]): ColumnType {
  let type: ColumnType | null = null;
  const merge = (next: ColumnType) => {
    if (type === null || type === next) type = next;
    else if (
      (type === 'integer' && next === 'decimal') ||
      (type === 'decimal' && next === 'integer')
    )
      type = 'decimal';
    else if ((type === 'date' && next === 'timestamp') || (type === 'timestamp' && next === 'date'))
      type = 'timestamp';
    else type = 'text';
  };
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'boolean') merge('boolean');
    else if (typeof v === 'number')
      merge(Number.isSafeInteger(v) ? 'integer' : Number.isFinite(v) ? 'decimal' : 'text');
    else if (typeof v === 'string' && DATE_RE.test(v)) merge('date');
    else if (typeof v === 'string' && STAMP_RE.test(v) && !Number.isNaN(Date.parse(v)))
      merge('timestamp');
    else merge('text');
    if (type === 'text') break;
  }
  return type ?? 'text';
}

export interface RestColumn {
  name: string;
  type: ColumnType;
  /** Where the type came from: the sample, or the OpenAPI description. */
  from?: 'sample' | 'schema';
}

/** Columns from sample records (flattened), in the order first seen. */
export function columnsFromSample(records: unknown[]): RestColumn[] {
  const values = new Map<string, unknown[]>();
  for (const r of records.slice(0, 200)) {
    for (const [k, v] of Object.entries(flattenRecord(r))) {
      if (!isDbName(k)) continue;
      if (!values.has(k)) {
        if (values.size >= MAX_REST_COLUMNS) continue;
        values.set(k, []);
      }
      values.get(k)!.push(v);
    }
  }
  return [...values].map(([name, vs]) => ({ name, type: inferType(vs), from: 'sample' }));
}

/** The next page's address from an HTTP Link header (rel="next"). */
export function linkNext(header: string | string[] | undefined): string | null {
  const text = Array.isArray(header) ? header.join(',') : header;
  if (!text) return null;
  for (const part of text.split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]+)>(.*)$/.exec(part);
    if (m && /;\s*rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?/i.test(m[2])) return m[1];
  }
  return null;
}

/** Whether a "has more" field says there are no more pages. */
export const saysNoMore = (v: unknown) =>
  v === false || v === 0 || v === 'false' || v === '0' || v === null;

// ─── OpenAPI ─────────────────────────────────────────────────────────────────

export interface RestOperation {
  method: 'GET' | 'POST';
  path: string;
  summary: string | null;
  /** Query parameters the description names (for picking pagination). */
  params: string[];
  /** Suggested records path, pagination and columns, from the response schema. */
  records: string | null;
  pagination: Pagination | null;
  columns: RestColumn[];
}

export const MAX_OPERATIONS = 500;

/** Follows local "$ref"s (#/components/schemas/X, #/definitions/X). */
function deref(doc: any, node: any, depth = 0): any {
  let n = node;
  for (let i = 0; i < 8 && n && typeof n === 'object' && typeof n.$ref === 'string'; i += 1) {
    if (!n.$ref.startsWith('#/')) return null;
    n = getPath(
      doc,
      n.$ref
        .slice(2)
        .split('/')
        .map((p: string) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
        .join('.')
    );
  }
  if (n && typeof n === 'object' && Array.isArray(n.allOf) && depth < 4) {
    const merged: any = { type: 'object', properties: {} };
    for (const part of n.allOf) {
      const p = deref(doc, part, depth + 1);
      if (p?.properties) Object.assign(merged.properties, p.properties);
    }
    return merged;
  }
  return n ?? null;
}

const SCHEMA_TYPE: Record<string, ColumnType> = {
  integer: 'integer',
  number: 'decimal',
  boolean: 'boolean',
};

function schemaColumns(doc: any, schema: any): RestColumn[] {
  const out: RestColumn[] = [];
  const walk = (s: any, prefix: string, depth: number) => {
    const node = deref(doc, s);
    for (const [k, raw] of Object.entries<any>(node?.properties ?? {})) {
      if (out.length >= MAX_REST_COLUMNS) return;
      const p = deref(doc, raw) ?? {};
      const name = prefix ? `${prefix}.${k}` : k;
      if (!isDbName(name)) continue;
      const type = Array.isArray(p.type) ? p.type.find((x: string) => x !== 'null') : p.type;
      if ((type === 'object' || p.properties) && depth < FLATTEN_DEPTH) walk(p, name, depth + 1);
      else
        out.push({
          name,
          type:
            type === 'string' && p.format === 'date'
              ? 'date'
              : type === 'string' && p.format === 'date-time'
                ? 'timestamp'
                : (SCHEMA_TYPE[type] ?? (type === 'object' || type === 'array' ? 'json' : 'text')),
          from: 'schema',
        });
    }
  };
  walk(schema, '', 1);
  return out;
}

/** Where the list is in a response schema: the answer itself, or an array property (two levels). */
function findRecords(doc: any, schema: any): { records: string; item: any } | null {
  const s = deref(doc, schema);
  if (!s) return null;
  if (s.type === 'array') return { records: '', item: s.items };
  for (const [k, raw] of Object.entries<any>(s.properties ?? {})) {
    const p = deref(doc, raw);
    if (p?.type === 'array') return { records: k, item: p.items };
  }
  for (const [k, raw] of Object.entries<any>(s.properties ?? {})) {
    const p = deref(doc, raw);
    for (const [k2, raw2] of Object.entries<any>(p?.properties ?? {})) {
      const p2 = deref(doc, raw2);
      if (p2?.type === 'array') return { records: `${k}.${k2}`, item: p2.items };
    }
  }
  return null;
}

/** A pagination guess from the query parameters an operation takes. */
export function guessPagination(params: string[]): Pagination | null {
  const has = (re: RegExp) => params.find((p) => re.test(p));
  const size = has(
    /^(per_page|page_size|pageSize|size|limit|count|max_results|maxResults|top|\$top)$/
  );
  const cursor = has(
    /^(cursor|after|starting_after|page_token|pageToken|next_token|nextToken|continuation(_token)?)$/i
  );
  if (cursor)
    return {
      style: 'cursor',
      cursor_param: cursor,
      cursor_path: cursor === 'starting_after' ? '$last.id' : 'next_cursor',
      ...(size ? { size_param: size, size: 100 } : {}),
    };
  const offset = has(/^(offset|skip|start|\$skip)$/i);
  if (offset && size) return { style: 'offset', offset_param: offset, size_param: size, size: 100 };
  const page = has(/^(page|page_number|pageNumber|p)$/);
  if (page)
    return {
      style: 'page',
      page_param: page,
      first_page: 1,
      ...(size ? { size_param: size, size: 100 } : {}),
    };
  return null;
}

/** The list endpoints of an OpenAPI 3 or Swagger 2 description (JSON). */
export function openApiOperations(doc: any): RestOperation[] {
  if (!doc || typeof doc !== 'object' || (!doc.openapi && !doc.swagger)) return [];
  const ops: RestOperation[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    if (!isEndpointPath(path.replace(/\{[^}]*\}/g, 'x')) || !item || typeof item !== 'object')
      continue;
    for (const method of ['get', 'post'] as const) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      if (ops.length >= MAX_OPERATIONS) return ops;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])]
        .map((p: any) => deref(doc, p))
        .filter((p: any) => p?.in === 'query' && typeof p.name === 'string')
        .map((p: any) => p.name as string);
      const ok = op.responses?.['200'] ?? op.responses?.['201'] ?? op.responses?.default;
      const res = deref(doc, ok);
      const schema = res?.content?.['application/json']?.schema ?? res?.schema ?? null;
      const found = schema ? findRecords(doc, schema) : null;
      ops.push({
        method: method === 'get' ? 'GET' : 'POST',
        path,
        summary:
          typeof op.summary === 'string'
            ? op.summary.slice(0, 200)
            : typeof op.operationId === 'string'
              ? op.operationId.slice(0, 200)
              : null,
        params: [...new Set(params)].slice(0, 50),
        records: found ? found.records : null,
        pagination: guessPagination(params),
        columns: found?.item ? schemaColumns(doc, found.item) : [],
      });
    }
  }
  return ops;
}

// ─── Connection settings ─────────────────────────────────────────────────────

/** "Name: value" lines (extra headers); wrong lines are left out. */
export function parseHeaderLines(text: unknown): [string, string][] {
  if (typeof text !== 'string') return [];
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]{1,100})\s*:\s*(.*?)\s*$/.exec(line);
    if (m && !/[\r\n\0]/.test(m[2]) && m[2].length <= 4000) out.push([m[1], m[2]]);
  }
  return out.slice(0, 30);
}

/** Whether every non-empty line of a header block is "Name: value". */
export const headerLinesOk = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .every((l) => parseHeaderLines(l).length === 1);

/** Ready-made settings for well-known APIs (filled into the forms; checked on first use). */
export interface RestTemplate {
  id: string;
  values: Record<string, string>;
  /** A first endpoint to suggest in the sync wizard. */
  endpoint?: Partial<RestSource>;
}

export const REST_TEMPLATES: RestTemplate[] = [
  { id: 'blank', values: { auth: 'none' } },
  {
    id: 'github',
    values: {
      base_url: 'https://api.github.com',
      auth: 'bearer',
      headers: 'Accept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28',
    },
    endpoint: {
      method: 'GET',
      path: '/user/repos',
      records: '',
      pagination: { style: 'link' },
      query: [['per_page', '100']],
      key: 'id',
      changed: 'updated_at',
    },
  },
  {
    id: 'stripe',
    values: { base_url: 'https://api.stripe.com', auth: 'bearer' },
    endpoint: {
      method: 'GET',
      path: '/v1/customers',
      records: 'data',
      pagination: {
        style: 'cursor',
        cursor_param: 'starting_after',
        cursor_path: '$last.id',
        size_param: 'limit',
        size: 100,
        has_more_path: 'has_more',
      },
      query: [],
      key: 'id',
    },
  },
  {
    id: 'shopify',
    values: {
      base_url: 'https://your-shop.myshopify.com/admin/api/2025-01',
      auth: 'api_key',
      api_key_in: 'header',
      api_key_name: 'X-Shopify-Access-Token',
    },
    endpoint: {
      method: 'GET',
      path: '/customers.json',
      records: 'customers',
      pagination: { style: 'link' },
      query: [['limit', '250']],
      key: 'id',
      changed: 'updated_at',
      since_param: 'updated_at_min',
    },
  },
  {
    id: 'notion',
    values: {
      base_url: 'https://api.notion.com',
      auth: 'bearer',
      headers: 'Notion-Version: 2022-06-28',
    },
    endpoint: {
      method: 'POST',
      path: '/v1/databases/DATABASE_ID/query',
      body: '{}',
      records: 'results',
      pagination: {
        style: 'cursor',
        cursor_param: 'start_cursor',
        cursor_path: 'next_cursor',
        size_param: 'page_size',
        size: 100,
        has_more_path: 'has_more',
        params_in: 'body',
      },
      query: [],
      key: 'id',
      changed: 'last_edited_time',
    },
  },
];
