import pg from 'pg';

export interface SqlTx {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface Executor {
  transaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T>;
}

const TYPE_PARSERS_SET = Symbol.for('etna.pg.typeParsers');

export function poolExecutor(
  connectionString: string,
  options: { max?: number; application_name?: string; connectionTimeoutMillis?: number } = {}
): Executor & { end(): Promise<void> } {
  const globalFlags = globalThis as Record<symbol, boolean>;
  if (!globalFlags[TYPE_PARSERS_SET]) {
    for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (value: string) => value);
    globalFlags[TYPE_PARSERS_SET] = true;
  }
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 5,
    application_name: options.application_name ?? 'etna',
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
  });
  return {
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: (text, params) => client.query(text, params as unknown[]),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
