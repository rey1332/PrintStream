// AI providers behind one interface (P3, 20261012000049): Anthropic,
// OpenAI, Azure OpenAI, Ollama and any OpenAI-compatible endpoint. Every call
// goes through the connector network guard (public addresses; internal ones
// ETNA allows; loopback only at listed local endpoints) with a longer timeout.
// Keys come from the vault and never leave the worker.

import type { AiConfig, AiKind } from '@/lib/terminal/aiProviders';
import { GuardedHttp, type HttpResponse } from '@/server/connectors/http';
import { TerminalError } from '@/server/terminal/session';

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  json: boolean;
}

export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiTarget {
  kind: AiKind;
  config: AiConfig;
  key: string | null;
  http: GuardedHttp;
}

const TIMEOUT_MS = 120_000;

function fail(res: HttpResponse): TerminalError {
  if (res.status === 401 || res.status === 403) return new TerminalError('authFailed');
  if (res.status === 429) return new TerminalError('rateLimited');
  if (res.status === 404) return new TerminalError('aiModelNotFound');
  if (res.status >= 500) return new TerminalError('remoteDown', { status: res.status });
  return new TerminalError('aiRejected', { status: res.status });
}

async function post(t: AiTarget, url: string, headers: Record<string, string>, body: unknown) {
  const res = await t.http.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    timeoutMs: TIMEOUT_MS,
    maxBytes: 5 * 1024 * 1024,
  });
  if (res.status !== 200) throw fail(res);
  return res.json();
}

const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);

async function openAiStyle(t: AiTarget, req: CompletionRequest): Promise<Completion> {
  const messages = [
    { role: 'system', content: req.system },
    { role: 'user', content: req.user },
  ];
  const body: Record<string, unknown> = { model: t.config.model, messages };
  // OpenAI's newer models take max_completion_tokens; others still max_tokens.
  if (t.kind === 'openai') body.max_completion_tokens = req.maxTokens;
  else body.max_tokens = req.maxTokens;
  if (req.json && t.config.json_output) body.response_format = { type: 'json_object' };
  let url: string;
  const headers: Record<string, string> = {};
  if (t.kind === 'azure_openai') {
    url = `${t.config.base_url}/openai/deployments/${encodeURIComponent(t.config.deployment ?? '')}/chat/completions?api-version=${encodeURIComponent(t.config.api_version ?? '2024-10-21')}`;
    if (t.key) headers['api-key'] = t.key;
    delete body.model;
  } else {
    url = `${t.config.base_url}/chat/completions`;
    if (t.key) headers.Authorization = `Bearer ${t.key}`;
  }
  const json = await post(t, url, headers, body);
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new TerminalError('badResponse');
  return {
    text,
    inputTokens: int(json.usage?.prompt_tokens),
    outputTokens: int(json.usage?.completion_tokens),
  };
}

async function anthropic(t: AiTarget, req: CompletionRequest): Promise<Completion> {
  const json = await post(
    t,
    `${t.config.base_url}/v1/messages`,
    { 'x-api-key': t.key ?? '', 'anthropic-version': '2023-06-01' },
    {
      model: t.config.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }
  );
  const text = (Array.isArray(json?.content) ? json.content : [])
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => String(c.text))
    .join('');
  if (!text) throw new TerminalError('badResponse');
  return {
    text,
    inputTokens: int(json.usage?.input_tokens),
    outputTokens: int(json.usage?.output_tokens),
  };
}

async function ollama(t: AiTarget, req: CompletionRequest): Promise<Completion> {
  const json = await post(
    t,
    `${t.config.base_url}/api/chat`,
    {},
    {
      model: t.config.model,
      stream: false,
      ...(req.json && t.config.json_output ? { format: 'json' } : {}),
      options: { num_predict: req.maxTokens },
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }
  );
  const text = json?.message?.content;
  if (typeof text !== 'string') throw new TerminalError('badResponse');
  return { text, inputTokens: int(json.prompt_eval_count), outputTokens: int(json.eval_count) };
}

/** One completion from the provider. */
export function complete(t: AiTarget, req: CompletionRequest): Promise<Completion> {
  if (t.kind === 'anthropic') return anthropic(t, req);
  if (t.kind === 'ollama') return ollama(t, req);
  return openAiStyle(t, req);
}
