import type { Filter, FilterOp, MutationSpec, Order, RequestSpec, RestResult } from './spec';

export type RestRunner = (spec: RequestSpec) => Promise<RestResult>;

type Row = Record<string, unknown>;

function failure(message: string, code = ''): RestResult {
  return {
    data: null,
    error: { message, code, details: null, hint: null },
    count: null,
    status: 0,
  };
}

export class RestRequest<T = any> implements PromiseLike<RestResult<T>> {
  private readonly runner: RestRunner;
  private readonly spec: RequestSpec;

  constructor(runner: RestRunner, spec: RequestSpec) {
    this.runner = runner;
    this.spec = spec;
  }

  private with(patch: Partial<RequestSpec>): RestRequest<T> {
    return new RestRequest<T>(this.runner, { ...this.spec, ...patch } as RequestSpec);
  }

  private filter(column: string, op: FilterOp, value: unknown, negate = false): RestRequest<T> {
    const next: Filter = { column, op, value, ...(negate ? { negate: true } : {}) };
    return this.with({ filters: [...this.spec.filters, next] });
  }

  eq(column: string, value: unknown) {
    return this.filter(column, 'eq', value);
  }
  neq(column: string, value: unknown) {
    return this.filter(column, 'neq', value);
  }
  gt(column: string, value: unknown) {
    return this.filter(column, 'gt', value);
  }
  gte(column: string, value: unknown) {
    return this.filter(column, 'gte', value);
  }
  lt(column: string, value: unknown) {
    return this.filter(column, 'lt', value);
  }
  lte(column: string, value: unknown) {
    return this.filter(column, 'lte', value);
  }
  like(column: string, pattern: string) {
    return this.filter(column, 'like', pattern);
  }
  ilike(column: string, pattern: string) {
    return this.filter(column, 'ilike', pattern);
  }
  anyOf(conditions: { column: string; op: Exclude<FilterOp, 'or'>; value: unknown }[]) {
    return this.filter('', 'or', conditions);
  }
  is(column: string, value: null | boolean) {
    return this.filter(column, 'is', value);
  }
  in(column: string, values: readonly unknown[]) {
    return this.filter(column, 'in', [...values]);
  }
  contains(column: string, value: unknown) {
    return this.filter(column, 'cs', value);
  }

  not(column: string, op: FilterOp, value: unknown) {
    return this.filter(column, op, value, true);
  }

  match(query: Row) {
    const added: Filter[] = Object.entries(query).map(([column, value]) => ({
      column,
      op: 'eq',
      value,
    }));
    return this.with({ filters: [...this.spec.filters, ...added] });
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const next: Order = { column, ascending: options.ascending ?? true };
    if (options.nullsFirst !== undefined) next.nullsFirst = options.nullsFirst;
    return this.with({ order: [...this.spec.order, next] });
  }

  range(from: number, to: number) {
    return this.with({ range: { from, to } });
  }
  limit(count: number) {
    return this.with({ limit: count });
  }
  single() {
    return this.with({ single: 'one' }) as unknown as RestRequest<T extends (infer U)[] ? U : T>;
  }
  maybeSingle() {
    return this.with({ single: 'maybe' }) as unknown as RestRequest<
      (T extends (infer U)[] ? U : T) | null
    >;
  }

  select(columns = '*') {
    if (this.spec.kind === 'select' || this.spec.kind === 'rpc') return this;
    return this.with({ returning: columns } as Partial<MutationSpec>);
  }

  then<R1 = RestResult<T>, R2 = never>(
    onFulfilled?: ((value: RestResult<T>) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    const run = async (): Promise<RestResult<T>> => {
      try {
        return (await this.runner(this.spec)) as RestResult<T>;
      } catch (error) {
        return failure(error instanceof Error ? error.message : 'Request failed') as RestResult<T>;
      }
    };
    return run().then(onFulfilled, onRejected);
  }
}

const empty = { filters: [] as Filter[], order: [] as Order[] };

export class RestTable {
  private readonly runner: RestRunner;
  private readonly table: string;

  constructor(runner: RestRunner, table: string) {
    this.runner = runner;
    this.table = table;
  }

  // Rows are untyped (as with an untyped supabase-js client); services map them.
  select(columns = '*', options: { count?: 'exact'; head?: boolean } = {}) {
    return new RestRequest<any[]>(this.runner, {
      ...empty,
      kind: 'select',
      table: this.table,
      select: columns,
      ...options,
    });
  }

  insert(values: Row | Row[], options: { count?: 'exact' } = {}) {
    return new RestRequest(this.runner, {
      ...empty,
      kind: 'insert',
      table: this.table,
      values,
      ...options,
    });
  }

  upsert(
    values: Row | Row[],
    options: { onConflict?: string; ignoreDuplicates?: boolean; count?: 'exact' } = {}
  ) {
    return new RestRequest(this.runner, {
      ...empty,
      kind: 'upsert',
      table: this.table,
      values,
      ...options,
    });
  }

  update(values: Row, options: { count?: 'exact' } = {}) {
    return new RestRequest(this.runner, {
      ...empty,
      kind: 'update',
      table: this.table,
      values,
      ...options,
    });
  }

  delete(options: { count?: 'exact' } = {}) {
    return new RestRequest(this.runner, {
      ...empty,
      kind: 'delete',
      table: this.table,
      ...options,
    });
  }
}

export class RestClient {
  private readonly runner: RestRunner;

  constructor(runner: RestRunner) {
    this.runner = runner;
  }

  from(table: string) {
    return new RestTable(this.runner, table);
  }

  rpc(fn: string, args: Row = {}, options: { count?: 'exact'; head?: boolean } = {}) {
    return new RestRequest(this.runner, { ...empty, kind: 'rpc', fn, args, ...options });
  }
}
