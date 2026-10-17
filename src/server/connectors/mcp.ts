// A remote MCP server as a Terminal connection (20261012000048), read only.
// PrintStream speaks MCP's Streamable HTTP transport itself (JSON-RPC over
// POST; answers as JSON or as a server-sent event stream) through the same
// network guard as every connector, rather than through a library that
// would open its own connections. The older HTTP+SSE transport is not
// supported.
//
// * Sign-in: none, a bearer token, an API key header, or OAuth2 with consent
//   (the REST connector's, src/server/connectors/rest.ts).
// * Tools are listed with their input schemas and kept in ps_mcp_tools; a
//   tool can be called only after someone who manages connections (with
//   two-factor) approved it, and only while its name, description, schema and
//   hints are exactly those approved (a hash): a server that changes a tool
//   loses the approval until it is approved again.
// * Results are stored as data with their provenance (the tool or resource,
//   in the dataset's lineage); tool descriptions are shown as quoted text and
//   never used as instructions.

import { createHash } from 'node:crypto';
import { columnsFromSample } from '@/lib/terminal/restSource';
import {
  resourceRows,
  stableJson,
  toolResultRows,
  type McpSource,
  type McpTool,
} from '@/lib/terminal/mcpSource';
import { TerminalError } from '@/server/terminal/session';
import { restRequest } from './rest';
import type { Adapter, ConnectorContext, Row } from './types';

export const MCP_PROTOCOL = '2025-06-18';
const MAX_LIST_PAGES = 50;
const MAX_TOOLS = 1000;

/** The messages of a server-sent event stream: each event's data, joined. */
export function parseSse(text: string): string[] {
  const out: string[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''));
    if (data.length) out.push(data.join('\n'));
  }
  return out;
}

/** A tool as kept and approved: its fingerprint covers everything the server says about it. */
export function toolHash(tool: any): string {
  return createHash('sha256')
    .update(
      stableJson({
        name: tool?.name ?? null,
        title: tool?.title ?? null,
        description: tool?.description ?? null,
        inputSchema: tool?.inputSchema ?? null,
        annotations: tool?.annotations ?? null,
      })
    )
    .digest('hex');
}

export interface ListedTool extends McpTool {
  hash: string;
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);

export class McpClient {
  private session: string | null = null;
  private protocol: string | null = null;
  private nextId = 1;
  server: { name: string | null; version: string | null } = { name: null, version: null };
  private readonly ctx: ConnectorContext;
  private readonly url: URL;

  constructor(ctx: ConnectorContext) {
    this.ctx = ctx;
    try {
      this.url = new URL(String(ctx.config.mcp_url ?? '').trim());
    } catch {
      throw new TerminalError('fieldInvalid', { field: 'mcp_url' });
    }
  }

  /** Connects and agrees on the protocol (initialize, then initialized). */
  static async open(ctx: ConnectorContext): Promise<McpClient> {
    const client = new McpClient(ctx);
    const result = await client.request('initialize', {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'PrintStream', version: '1' },
    });
    client.protocol =
      typeof result?.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL;
    client.server = {
      name: clip(result?.serverInfo?.name, 100),
      version: clip(result?.serverInfo?.version, 50),
    };
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
    return client;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json, text/event-stream' };
    if (this.session) h['Mcp-Session-Id'] = this.session;
    if (this.protocol) h['MCP-Protocol-Version'] = this.protocol;
    return h;
  }

  private async send(message: Record<string, unknown>, answer: boolean): Promise<any> {
    const res = await restRequest(
      this.ctx,
      'POST',
      this.url,
      JSON.stringify(message),
      (s) => (s >= 200 && s < 300) || s === 404,
      this.headers()
    );
    if (res.status === 404)
      throw new TerminalError(this.session ? 'mcpSessionExpired' : 'notFoundRemote');
    const sid = res.headers['mcp-session-id'];
    if (typeof sid === 'string' && /^[\x21-\x7e]{1,200}$/.test(sid)) this.session = sid;
    if (!answer) return null;
    const type = String(res.headers['content-type'] ?? '');
    const texts = type.includes('text/event-stream') ? parseSse(res.text()) : [res.text()];
    for (const text of texts) {
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
        if (m?.id !== message.id) continue;
        if (m.error) {
          if (m.error.code === -32601) throw new TerminalError('mcpUnsupported');
          throw new TerminalError('mcpError', {
            detail: String(m.error.message ?? '').slice(0, 200),
          });
        }
        return m.result;
      }
    }
    throw new TerminalError('badResponse');
  }

  request(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId;
    this.nextId += 1;
    return this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, true);
  }

  private async listAll(method: string, key: string): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await this.request(method, cursor ? { cursor } : {});
      for (const item of Array.isArray(result?.[key]) ? result[key] : []) {
        if (out.length >= MAX_TOOLS) return out;
        out.push(item);
      }
      cursor =
        typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
      await this.ctx.beat();
    }
    return out;
  }

  /** The server's tools, as kept (descriptions and schemas trimmed to fit) with their fingerprints. */
  async tools(): Promise<ListedTool[]> {
    const raw = await this.listAll('tools/list', 'tools');
    return raw
      .filter((t) => typeof t?.name === 'string' && /^[A-Za-z0-9_.\-/]{1,128}$/.test(t.name))
      .map((t) => {
        const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : null;
        return {
          name: t.name,
          title: clip(t.title ?? t.annotations?.title, 200),
          description: clip(t.description, 4000),
          input_schema: schema && JSON.stringify(schema).length <= 30_000 ? schema : null,
          read_only:
            typeof t.annotations?.readOnlyHint === 'boolean' ? t.annotations.readOnlyHint : null,
          hash: toolHash(t),
        };
      });
  }

  /** The server's resources (when it has any). */
  async resources(): Promise<{ uri: string; name: string | null; mime_type: string | null }[]> {
    const raw = await this.listAll('resources/list', 'resources').catch((e) => {
      if (e instanceof TerminalError && e.code === 'mcpUnsupported') return [];
      throw e;
    });
    return raw
      .filter((r) => typeof r?.uri === 'string' && r.uri.length <= 1000)
      .map((r) => ({ uri: r.uri, name: clip(r.name, 200), mime_type: clip(r.mimeType, 100) }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.request('tools/call', { name, arguments: args });
    if (result?.isError) {
      const text = (Array.isArray(result.content) ? result.content : []).find(
        (c: any) => c?.type === 'text'
      )?.text;
      throw new TerminalError('mcpToolError', { detail: String(text ?? '').slice(0, 200) });
    }
    return result;
  }

  readResource(uri: string): Promise<any> {
    return this.request('resources/read', { uri });
  }

  /** Ends the session (the server may not support it; that is fine). */
  async close() {
    if (!this.session) return;
    await restRequest(this.ctx, 'DELETE', this.url, null, () => true, this.headers()).catch(
      () => undefined
    );
  }
}

/**
 * Calls the source once: the tool (which must be approved as it is now, see
 * `approved`) or the resource; the records come back flattened.
 */
export async function readMcpOnce(
  ctx: ConnectorContext,
  source: McpSource,
  approved: (name: string, hash: string) => Promise<boolean>
): Promise<{ rows: Row[]; server: McpClient['server'] }> {
  const client = await McpClient.open(ctx);
  try {
    if (source.what === 'tool') {
      const tool = (await client.tools()).find((t) => t.name === source.name);
      if (!tool) throw new TerminalError('mcpToolMissing');
      if (!(await approved(tool.name, tool.hash))) throw new TerminalError('mcpToolUnapproved');
      const result = await client.callTool(source.name, JSON.parse(source.arguments));
      return { rows: toolResultRows(result, source.records), server: client.server };
    }
    return {
      rows: resourceRows(await client.readResource(source.name), source.records),
      server: client.server,
    };
  } finally {
    await client.close();
  }
}

/** Rows already read, a thousand at a time (as a reader would give them). */
export async function* inThousands(rows: Row[]): AsyncGenerator<Row[]> {
  for (let i = 0; i < rows.length; i += 1000) yield rows.slice(i, i + 1000);
}

/** One call: the columns, a few rows to look at, and a key to suggest. */
export async function describeMcp(
  ctx: ConnectorContext,
  source: McpSource,
  approved: (name: string, hash: string) => Promise<boolean>
) {
  const { rows } = await readMcpOnce(ctx, source, approved);
  const columns = columnsFromSample(rows);
  const sample = rows
    .slice(0, 5)
    .map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v])
      )
    );
  const key = ['id', 'uuid', 'key', 'uri'].find((k) => columns.some((c) => c.name === k)) ?? null;
  return { columns, sample, count: rows.length, key };
}

export const mcp: Adapter = {
  async test(ctx) {
    const client = await McpClient.open(ctx);
    try {
      const tools = await client.tools();
      return {
        version: [client.server.name, client.server.version].filter(Boolean).join(' ') || null,
        tools: tools.length,
      };
    } finally {
      await client.close();
    }
  },
  // eslint-disable-next-line require-yield
  async *read() {
    // An MCP server is read by tool or resource (readMcpOnce), not by ERP list.
    throw new TerminalError('invalid');
  },
};
