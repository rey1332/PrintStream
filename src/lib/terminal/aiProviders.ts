// TERMINAL AI providers (P3, 20261012000049): which kinds PrintStream can
// call, what each needs, and the capabilities it declares. One interface for
// all (src/server/ai/providers.ts); shared by the screens and the worker.

export type AiKind = 'anthropic' | 'openai' | 'azure_openai' | 'ollama' | 'openai_compatible';
export const AI_KINDS: readonly AiKind[] = [
  'anthropic',
  'openai',
  'azure_openai',
  'ollama',
  'openai_compatible',
];

export interface AiConfig {
  base_url: string;
  model: string;
  /** Azure OpenAI: the deployment name and API version. */
  deployment?: string;
  api_version?: string;
  /** Declared capabilities (shown as declared, not guessed). */
  context_tokens: number;
  json_output: boolean;
  tools: boolean;
  /** Price per million tokens, in the workspace's budget currency. */
  price_in: number;
  price_out: number;
  max_output_tokens: number;
}

export interface AiKindDef {
  base_url: string;
  /** The address must be given (no usable default). */
  base_required: boolean;
  key: 'required' | 'optional' | 'none';
  model: string;
  deployment?: boolean;
  defaults: Pick<AiConfig, 'context_tokens' | 'json_output' | 'tools'>;
}

export const AI_KIND_DEFS: Record<AiKind, AiKindDef> = {
  anthropic: {
    base_url: 'https://api.anthropic.com',
    base_required: false,
    key: 'required',
    model: 'claude-sonnet-5-5',
    defaults: { context_tokens: 200_000, json_output: true, tools: true },
  },
  openai: {
    base_url: 'https://api.openai.com/v1',
    base_required: false,
    key: 'required',
    model: '',
    defaults: { context_tokens: 128_000, json_output: true, tools: true },
  },
  azure_openai: {
    base_url: '',
    base_required: true,
    key: 'required',
    model: '',
    deployment: true,
    defaults: { context_tokens: 128_000, json_output: true, tools: true },
  },
  ollama: {
    base_url: 'http://localhost:11434',
    base_required: false,
    key: 'none',
    model: '',
    defaults: { context_tokens: 8_192, json_output: true, tools: false },
  },
  openai_compatible: {
    base_url: '',
    base_required: true,
    key: 'optional',
    model: '',
    defaults: { context_tokens: 8_192, json_output: false, tools: false },
  },
};

export const isAiKind = (v: unknown): v is AiKind =>
  typeof v === 'string' && (AI_KINDS as readonly string[]).includes(v);

const num = (v: unknown, min: number, max: number, fallback: number) => {
  if (v === '' || v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/** The settings to keep, or the field that is wrong. */
export function parseAiConfig(kind: AiKind, v: any): AiConfig | { field: string } {
  const def = AI_KIND_DEFS[kind];
  const base = String(v?.base_url ?? '').trim() || def.base_url;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return { field: 'base_url' };
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || base.length > 300)
    return { field: 'base_url' };
  const model = String(v?.model ?? '').trim() || def.model;
  if (!model || model.length > 120 || /\s/.test(model)) return { field: 'model' };
  const deployment = String(v?.deployment ?? '').trim();
  if (def.deployment && !/^[A-Za-z0-9._-]{1,100}$/.test(deployment)) return { field: 'deployment' };
  const apiVersion = String(v?.api_version ?? '').trim();
  if (apiVersion && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-preview)?$/.test(apiVersion))
    return { field: 'api_version' };
  const context = num(v?.context_tokens, 512, 10_000_000, def.defaults.context_tokens);
  if (context === null) return { field: 'context_tokens' };
  const priceIn = num(v?.price_in, 0, 1_000_000, 0);
  if (priceIn === null) return { field: 'price_in' };
  const priceOut = num(v?.price_out, 0, 1_000_000, 0);
  if (priceOut === null) return { field: 'price_out' };
  const maxOut = num(v?.max_output_tokens, 64, 32_000, 1500);
  if (maxOut === null) return { field: 'max_output_tokens' };
  const flag = (x: unknown, d: boolean) =>
    x === undefined || x === null || x === '' ? d : x === true || x === 'true';
  return {
    base_url: base.replace(/\/+$/, ''),
    model,
    ...(def.deployment ? { deployment, api_version: apiVersion || '2024-10-21' } : {}),
    context_tokens: Math.round(context),
    json_output: flag(v?.json_output, def.defaults.json_output),
    tools: flag(v?.tools, def.defaults.tools),
    price_in: priceIn,
    price_out: priceOut,
    max_output_tokens: Math.round(maxOut),
  };
}

/** A rough token count (about four characters a token). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** What a call costs at the provider's declared prices. */
export const costOf = (
  config: Pick<AiConfig, 'price_in' | 'price_out'>,
  input: number,
  output: number
) => (input * config.price_in + output * config.price_out) / 1_000_000;
