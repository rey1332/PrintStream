// The Model Context Protocol over Streamable HTTP, server side, as far as a
// tool server needs it: initialize, ping, tools/list and tools/call
// (JSON-RPC 2.0, one message per POST, answered with JSON; no server-sent
// events, no sessions). See /api/mcp and src/server/mcp/tools.ts.

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const SERVER_INFO = {
  name: 'printstream-terminal',
  title: 'PrintStream Terminal',
  version: '1.0.0',
};

export interface McpTool<C> {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Changes something (pipeline drafts); only for connections allowed to write. */
  write?: boolean;
  run: (ctx: C, args: Record<string, unknown>) => Promise<unknown>;
}

/** An error the tool reports to the model (isError result), not a protocol error. */
export class ToolError extends Error {}

type Id = string | number | null;
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

const reply = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const MAX_TEXT = 200_000;

/** A tool's answer as MCP content: JSON text, cut down when very large. */
export function toolResult(value: unknown) {
  let text = JSON.stringify(value, null, 1);
  if (text.length > MAX_TEXT)
    text = `${text.slice(0, MAX_TEXT)}\n… (cut at ${MAX_TEXT} characters)`;
  const structured =
    value && typeof value === 'object' && !Array.isArray(value) && text.length <= MAX_TEXT
      ? { structuredContent: value }
      : {};
  return { content: [{ type: 'text', text }], ...structured };
}

/**
 * One JSON-RPC message. Returns the response, or null for a notification
 * (the route answers 202 Accepted).
 */
export async function handleMessage<C>(
  message: unknown,
  ctx: C,
  tools: McpTool<C>[]
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message))
    return fail(null, INVALID_REQUEST, 'Invalid request');
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const isRequest = 'id' in m;
  const id: Id =
    typeof m.id === 'string' || typeof m.id === 'number' ? (m.id as string | number) : null;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    // A response sent to the server (to one of its requests: it makes none).
    return isRequest && !('result' in m || 'error' in m)
      ? fail(id, INVALID_REQUEST, 'Invalid request')
      : null;
  }
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, …
  const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<
    string,
    unknown
  >;

  switch (m.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked
        : PROTOCOL_VERSIONS[0];
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: tools.some((t) => t.write)
          ? 'Access to one PrintStream Terminal with the rights of the member who connected it: its pipelines, runs and datasets, insights into datasets, and building pipelines. Pipelines you create or change are drafts: a person reviews and publishes them in PrintStream; nothing you build runs on its own. To build: list_node_types (and list_datasets, list_erp_fields), then validate_pipeline, test_pipeline, create_pipeline or update_pipeline.'
          : 'Read-only access to one PrintStream Terminal: its pipelines (graphs, schedules, chains), their runs and its datasets, insights into datasets, and checking or test-running pipeline ideas (nothing is saved), with the rights of the member who connected it. Start with list_pipelines.',
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.write
            ? {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
              }
            : { readOnlyHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        return reply(id, toolResult(await tool.run(ctx, args)));
      } catch (error) {
        if (error instanceof ToolError)
          return reply(id, { content: [{ type: 'text', text: error.message }], isError: true });
        throw error;
      }
    }
    default:
      return fail(id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  }
}
