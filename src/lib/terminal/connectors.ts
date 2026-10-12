// TERMINAL connectors (P2): which ERPs PrintStream connects to, what each
// needs, and which lists it syncs into datasets. Every ERP's lists come out
// with the same columns (customers look alike whether they come from Odoo or
// SAP), so pipelines can treat them alike. Shared by the screens and the worker.

import type { ColumnType } from './tabular';

export type ConnectorKind =
  | 'accurate'
  | 'jurnal'
  | 'odoo'
  | 'sap_b1'
  | 'postgres'
  | 'rest'
  | 'web'
  | 'mcp';
export const CONNECTOR_KINDS: readonly ConnectorKind[] = [
  'accurate',
  'jurnal',
  'odoo',
  'sap_b1',
  'postgres',
  'rest',
  'web',
  'mcp',
];

export type ObjectKey =
  | 'customers'
  | 'suppliers'
  | 'products'
  | 'sales_invoices'
  | 'purchase_invoices';

export interface ObjectColumn {
  label: string;
  type: ColumnType;
  key?: boolean;
}

const PARTY: ObjectColumn[] = [
  { label: 'id', type: 'text', key: true },
  { label: 'code', type: 'text' },
  { label: 'name', type: 'text' },
  { label: 'email', type: 'text' },
  { label: 'phone', type: 'text' },
  { label: 'city', type: 'text' },
  { label: 'balance', type: 'decimal' },
  { label: 'updated_at', type: 'timestamp' },
];
const PRODUCT: ObjectColumn[] = [
  { label: 'id', type: 'text', key: true },
  { label: 'code', type: 'text' },
  { label: 'name', type: 'text' },
  { label: 'unit', type: 'text' },
  { label: 'sale_price', type: 'decimal' },
  { label: 'cost_price', type: 'decimal' },
  { label: 'on_hand', type: 'decimal' },
  { label: 'updated_at', type: 'timestamp' },
];
const INVOICE: ObjectColumn[] = [
  { label: 'id', type: 'text', key: true },
  { label: 'number', type: 'text' },
  { label: 'date', type: 'date' },
  { label: 'partner', type: 'text' },
  { label: 'total', type: 'decimal' },
  { label: 'outstanding', type: 'decimal' },
  { label: 'status', type: 'text' },
  { label: 'currency', type: 'text' },
  { label: 'updated_at', type: 'timestamp' },
];

export const OBJECT_COLUMNS: Record<ObjectKey, ObjectColumn[]> = {
  customers: PARTY,
  suppliers: PARTY,
  products: PRODUCT,
  sales_invoices: INVOICE,
  purchase_invoices: INVOICE,
};
export const OBJECT_KEYS = Object.keys(OBJECT_COLUMNS) as ObjectKey[];

export interface ConfigField {
  key: string;
  kind: 'text' | 'url' | 'secret' | 'select' | 'textarea';
  required?: boolean;
  /** Longest value kept (default 500). */
  max?: number;
  options?: readonly string[];
  placeholder?: string;
  /** Shown (and kept) only while other fields have one of these values. */
  when?: Record<string, readonly string[]>;
  /** Under "Advanced" in the form. */
  advanced?: boolean;
  /** A secret of several lines (a private key, header lines). */
  multiline?: boolean;
}

/** Whether a field applies, given the values of the others. */
export function fieldShown(field: ConfigField, values: Record<string, unknown>): boolean {
  if (!field.when) return true;
  return Object.entries(field.when).every(([k, allowed]) =>
    allowed.includes(String(values[k] ?? ''))
  );
}

// A system published through a Cloudflare Tunnel behind Cloudflare Access: a
// service token sent with every request to the connection's own host (never
// to other hosts, such as token endpoints).
const ACCESS: ConfigField[] = [
  { key: 'cf_access_client_id', kind: 'text', advanced: true, placeholder: 'xxxx.access' },
  { key: 'cf_access_client_secret', kind: 'secret', advanced: true },
];

export const REST_AUTH = [
  'none',
  'api_key',
  'bearer',
  'basic',
  'oauth2_client',
  'oauth2_code',
  'hmac',
] as const;
export type RestAuth = (typeof REST_AUTH)[number];
const OAUTH = ['oauth2_client', 'oauth2_code'] as const;

export interface ConnectorDef {
  /** Settings; `secret` fields are sealed in the vault and never shown again. */
  fields: ConfigField[];
  objects: ObjectKey[];
  /** Lists that can be read "changed since" (others are read in full every time). */
  incremental: ObjectKey[];
  /** Authorised in the ERP's own page (OAuth) after saving. */
  oauth?: boolean;
  /** A database: syncs pick tables or queries (src/lib/terminal/dbSource.ts), not lists. */
  database?: boolean;
  /** A REST API: syncs pick endpoints (src/lib/terminal/restSource.ts), not lists. */
  rest?: boolean;
  /** A website: syncs pick pages and what to read in them (src/lib/terminal/webSource.ts). */
  web?: boolean;
  /** A remote MCP server: syncs call an approved tool or read a resource (src/lib/terminal/mcpSource.ts). */
  mcp?: boolean;
}

export const CONNECTORS: Record<ConnectorKind, ConnectorDef> = {
  odoo: {
    fields: [
      { key: 'url', kind: 'url', required: true, placeholder: 'https://company.odoo.com' },
      { key: 'database', kind: 'text', required: true },
      { key: 'username', kind: 'text', required: true, placeholder: 'user@company.com' },
      { key: 'api_key', kind: 'secret', required: true },
      ...ACCESS,
    ],
    objects: OBJECT_KEYS,
    incremental: OBJECT_KEYS,
  },
  sap_b1: {
    fields: [
      { key: 'url', kind: 'url', required: true, placeholder: 'https://sap-server:50000/b1s/v1' },
      { key: 'company_db', kind: 'text', required: true },
      { key: 'username', kind: 'text', required: true },
      { key: 'password', kind: 'secret', required: true },
      { key: 'tls_fingerprint', kind: 'text', placeholder: 'AB:CD:…' },
      ...ACCESS,
    ],
    objects: OBJECT_KEYS,
    incremental: OBJECT_KEYS,
  },
  accurate: {
    fields: [
      { key: 'client_id', kind: 'text', required: true },
      { key: 'client_secret', kind: 'secret', required: true },
      { key: 'database_id', kind: 'text' },
    ],
    objects: OBJECT_KEYS,
    incremental: OBJECT_KEYS,
    oauth: true,
  },
  jurnal: {
    fields: [
      { key: 'environment', kind: 'select', required: true, options: ['production', 'sandbox'] },
      { key: 'client_id', kind: 'secret', required: true },
      { key: 'client_secret', kind: 'secret', required: true },
    ],
    objects: OBJECT_KEYS,
    incremental: [],
  },
  postgres: {
    fields: [
      { key: 'host', kind: 'text', required: true, placeholder: 'db.company.co.id' },
      { key: 'port', kind: 'text', placeholder: '5432' },
      { key: 'database', kind: 'text', required: true },
      { key: 'username', kind: 'text', required: true },
      { key: 'password', kind: 'secret', required: true },
      {
        key: 'ssl',
        kind: 'select',
        required: true,
        options: ['verify-full', 'verify-ca', 'disable'],
      },
      {
        key: 'ca_pem',
        kind: 'textarea',
        max: 6000,
        placeholder: '-----BEGIN CERTIFICATE-----',
      },
    ],
    objects: [],
    incremental: [],
    database: true,
  },
  rest: {
    fields: [
      { key: 'base_url', kind: 'url', required: true, placeholder: 'https://api.company.co.id' },
      { key: 'auth', kind: 'select', required: true, options: REST_AUTH },
      // Static secrets.
      {
        key: 'api_key_in',
        kind: 'select',
        required: true,
        options: ['header', 'query'],
        when: { auth: ['api_key'] },
      },
      {
        key: 'api_key_name',
        kind: 'text',
        required: true,
        placeholder: 'X-API-Key',
        when: { auth: ['api_key'] },
      },
      { key: 'api_key', kind: 'secret', required: true, when: { auth: ['api_key'] } },
      { key: 'token', kind: 'secret', required: true, when: { auth: ['bearer'] } },
      { key: 'username', kind: 'text', required: true, when: { auth: ['basic'] } },
      { key: 'password', kind: 'secret', required: true, when: { auth: ['basic'] } },
      // OAuth2: client credentials, or authorisation code (consent, PKCE).
      {
        key: 'authorize_url',
        kind: 'url',
        required: true,
        placeholder: 'https://auth.provider.com/oauth/authorize',
        when: { auth: ['oauth2_code'] },
      },
      {
        key: 'token_url',
        kind: 'url',
        required: true,
        placeholder: 'https://auth.provider.com/oauth/token',
        when: { auth: OAUTH },
      },
      { key: 'client_id', kind: 'text', required: true, when: { auth: OAUTH } },
      { key: 'client_secret', kind: 'secret', required: true, when: { auth: ['oauth2_client'] } },
      { key: 'client_secret', kind: 'secret', when: { auth: ['oauth2_code'] } },
      { key: 'scope', kind: 'text', when: { auth: OAUTH } },
      { key: 'audience', kind: 'text', advanced: true, when: { auth: OAUTH } },
      {
        key: 'client_auth',
        kind: 'select',
        required: true,
        options: ['in_header', 'in_body'],
        when: { auth: OAUTH },
      },
      {
        key: 'pkce',
        kind: 'select',
        required: true,
        options: ['S256', 'off'],
        when: { auth: ['oauth2_code'] },
      },
      { key: 'revoke_url', kind: 'url', advanced: true, when: { auth: ['oauth2_code'] } },
      // Signed requests (HMAC): a template, or a provider's own rules.
      {
        key: 'hmac_scheme',
        kind: 'select',
        required: true,
        options: ['custom', 'mekari'],
        when: { auth: ['hmac'] },
      },
      { key: 'hmac_key_id', kind: 'text', when: { auth: ['hmac'] } },
      { key: 'hmac_secret', kind: 'secret', required: true, when: { auth: ['hmac'] } },
      {
        key: 'hmac_algorithm',
        kind: 'select',
        required: true,
        options: ['sha256', 'sha512', 'sha1'],
        when: { auth: ['hmac'], hmac_scheme: ['custom'] },
      },
      {
        key: 'hmac_encoding',
        kind: 'select',
        required: true,
        options: ['hex', 'base64'],
        when: { auth: ['hmac'], hmac_scheme: ['custom'] },
      },
      {
        key: 'hmac_string',
        kind: 'textarea',
        required: true,
        max: 1000,
        placeholder: '{method}\n{path}\n{timestamp}\n{body_sha256}',
        when: { auth: ['hmac'], hmac_scheme: ['custom'] },
      },
      {
        key: 'hmac_headers',
        kind: 'textarea',
        required: true,
        max: 2000,
        placeholder: 'X-Signature: {signature}\nX-Timestamp: {timestamp}',
        when: { auth: ['hmac'], hmac_scheme: ['custom'] },
      },
      // With any sign-in.
      {
        key: 'headers',
        kind: 'textarea',
        advanced: true,
        max: 3000,
        placeholder: 'Accept: application/json',
      },
      { key: 'secret_headers', kind: 'secret', advanced: true, multiline: true },
      {
        key: 'client_cert_pem',
        kind: 'textarea',
        advanced: true,
        max: 6000,
        placeholder: '-----BEGIN CERTIFICATE-----',
      },
      { key: 'client_key_pem', kind: 'secret', advanced: true, multiline: true },
      { key: 'tls_fingerprint', kind: 'text', advanced: true, placeholder: 'AB:CD:…' },
      ...ACCESS,
      {
        key: 'openapi_url',
        kind: 'url',
        advanced: true,
        placeholder: 'https://api.company.co.id/openapi.json',
      },
      { key: 'test_path', kind: 'text', advanced: true, placeholder: '/v1/me' },
    ],
    objects: [],
    incremental: [],
    rest: true,
  },
  web: {
    fields: [
      { key: 'base_url', kind: 'url', required: true, placeholder: 'https://www.supplier.co.id' },
      {
        key: 'headers',
        kind: 'textarea',
        advanced: true,
        max: 3000,
        placeholder: 'Accept-Language: id-ID',
      },
      ...ACCESS,
    ],
    objects: [],
    incremental: [],
    web: true,
  },
  mcp: {
    fields: [
      { key: 'mcp_url', kind: 'url', required: true, placeholder: 'https://mcp.provider.com/mcp' },
      {
        key: 'auth',
        kind: 'select',
        required: true,
        options: ['none', 'bearer', 'api_key', 'oauth2_code'],
      },
      { key: 'token', kind: 'secret', required: true, when: { auth: ['bearer'] } },
      {
        key: 'api_key_name',
        kind: 'text',
        required: true,
        placeholder: 'X-API-Key',
        when: { auth: ['api_key'] },
      },
      { key: 'api_key', kind: 'secret', required: true, when: { auth: ['api_key'] } },
      // Empty addresses and client ID are found from the server (MCP authorization discovery).
      { key: 'authorize_url', kind: 'url', advanced: true, when: { auth: ['oauth2_code'] } },
      { key: 'token_url', kind: 'url', advanced: true, when: { auth: ['oauth2_code'] } },
      { key: 'client_id', kind: 'text', when: { auth: ['oauth2_code'] } },
      { key: 'client_secret', kind: 'secret', when: { auth: ['oauth2_code'] } },
      { key: 'scope', kind: 'text', when: { auth: ['oauth2_code'] } },
      {
        key: 'client_auth',
        kind: 'select',
        required: true,
        options: ['in_header', 'in_body'],
        advanced: true,
        when: { auth: ['oauth2_code'] },
      },
      { key: 'revoke_url', kind: 'url', advanced: true, when: { auth: ['oauth2_code'] } },
      { key: 'headers', kind: 'textarea', advanced: true, max: 3000 },
      ...ACCESS,
    ],
    objects: [],
    incremental: [],
    mcp: true,
  },
};

export const isConnectorKind = (v: unknown): v is ConnectorKind =>
  typeof v === 'string' && (CONNECTOR_KINDS as readonly string[]).includes(v);
export const isObjectKey = (v: unknown): v is ObjectKey =>
  typeof v === 'string' && Object.hasOwn(OBJECT_COLUMNS, v);
