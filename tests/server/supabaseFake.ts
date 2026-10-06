/**
 * A tiny in-memory stand-in for the Supabase PostgREST query builder, used by
 * the Phase 6 repository tests.
 *
 * It deliberately behaves like the real client for the subset of the API the
 * repositories use (`select`/`insert`/`update`/`delete`, `eq`/`gte`/`lte`/
 * `ilike`, `order`/`limit`, `single`/`maybeSingle`, and `await` on the builder).
 * Filters are actually applied, so a query that forgets to scope by `user_id`
 * would visibly return another user's rows — that is exactly what the tests
 * assert against.
 *
 * No network or live database is touched.
 */

export type FakeRow = Record<string, unknown>;

let idCounter = 0;

function nextId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Translates a SQL LIKE/ILIKE pattern (with `%`/`_` and `\` escapes) to a regex. */
function likeToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\' && i + 1 < pattern.length) {
      out += escapeRegExp(pattern[i + 1]);
      i += 1;
      continue;
    }
    if (char === '%') {
      out += '.*';
      continue;
    }
    if (char === '_') {
      out += '.';
      continue;
    }
    out += escapeRegExp(char);
  }
  return new RegExp(`^${out}$`, 'i');
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  return (a as string) < (b as string) ? -1 : 1;
}

interface Ordering {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}

export class FakePostgrestQuery {
  /** Every `eq`/`gte`/`lte`/`ilike` call, in order, for scoping assertions. */
  readonly filterCalls: Array<[string, unknown]> = [];

  private operation: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private payload: FakeRow | FakeRow[] | null = null;
  private conflictColumns: string[] = ['id'];
  private readonly predicates: Array<(row: FakeRow) => boolean> = [];
  private readonly orderings: Ordering[] = [];
  private maxRows: number | null = null;

  constructor(private readonly rows: FakeRow[]) {}

  select(): this {
    return this;
  }

  insert(payload: FakeRow | FakeRow[]): this {
    this.operation = 'insert';
    this.payload = payload;
    return this;
  }

  upsert(payload: FakeRow | FakeRow[], options?: { onConflict?: string }): this {
    this.operation = 'upsert';
    this.payload = payload;
    // Support PostgREST's comma-separated composite conflict targets, e.g.
    // `{ onConflict: 'user_id,notion_database_id' }`.
    this.conflictColumns = (options?.onConflict ?? 'id')
      .split(',')
      .map((column) => column.trim())
      .filter((column) => column.length > 0);
    if (this.conflictColumns.length === 0) this.conflictColumns = ['id'];
    return this;
  }

  update(payload: FakeRow): this {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.operation = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filterCalls.push([column, value]);
    this.predicates.push((row) => row[column] === value);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filterCalls.push([column, value]);
    this.predicates.push((row) => {
      const cell = row[column];
      if (cell === null || cell === undefined) return false;
      return (cell as string) >= (value as string);
    });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filterCalls.push([column, value]);
    this.predicates.push((row) => {
      const cell = row[column];
      if (cell === null || cell === undefined) return false;
      return (cell as string) <= (value as string);
    });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filterCalls.push([column, value]);
    this.predicates.push((row) => {
      const cell = row[column];
      if (cell === null || cell === undefined) return false;
      return (cell as string) < (value as string);
    });
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filterCalls.push([column, value]);
    this.predicates.push((row) => {
      const cell = row[column];
      if (cell === null || cell === undefined) return false;
      return (cell as string) > (value as string);
    });
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.filterCalls.push([column, pattern]);
    const regex = likeToRegExp(pattern);
    this.predicates.push((row) => typeof row[column] === 'string' && regex.test(row[column] as string));
    return this;
  }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const ascending = options?.ascending ?? true;
    this.orderings.push({
      column,
      ascending,
      nullsFirst: options?.nullsFirst ?? !ascending,
    });
    return this;
  }

  limit(count: number): this {
    this.maxRows = count;
    return this;
  }

  private matched(): FakeRow[] {
    let result = this.rows.filter((row) => this.predicates.every((predicate) => predicate(row)));

    for (const ordering of [...this.orderings].reverse()) {
      const { column, ascending, nullsFirst } = ordering;
      result = [...result].sort((left, right) => {
        const leftValue = left[column];
        const rightValue = right[column];
        const leftNull = leftValue === null || leftValue === undefined;
        const rightNull = rightValue === null || rightValue === undefined;

        if (leftNull || rightNull) {
          if (leftNull && rightNull) return 0;
          const nullRank = nullsFirst ? -1 : 1;
          return leftNull ? nullRank : -nullRank;
        }

        const base = compareValues(leftValue, rightValue);
        return ascending ? base : -base;
      });
    }

    return result;
  }

  private execute(): { data: unknown; error: unknown } {
    if (this.operation === 'upsert') {
      const items = Array.isArray(this.payload)
        ? this.payload
        : [this.payload as FakeRow];
      const now = new Date().toISOString();
      const affected: FakeRow[] = [];

      for (const item of items) {
        const existing = this.rows.find((row) =>
          this.conflictColumns.every((column) => row[column] === item[column])
        );
        if (existing) {
          Object.assign(existing, item, { updated_at: now });
          affected.push(existing);
        } else {
          const created = { id: nextId(), created_at: now, updated_at: now, ...item };
          this.rows.push(created);
          affected.push(created);
        }
      }

      return { data: affected, error: null };
    }

    if (this.operation === 'insert') {
      const items = Array.isArray(this.payload)
        ? this.payload
        : [this.payload as FakeRow];
      const now = new Date().toISOString();
      const created = items.map((item) => ({
        id: nextId(),
        created_at: now,
        updated_at: now,
        ...item,
      }));
      this.rows.push(...created);
      return { data: created, error: null };
    }

    if (this.operation === 'update') {
      const matched = this.matched();
      for (const row of matched) {
        Object.assign(row, this.payload as FakeRow);
      }
      return { data: matched, error: null };
    }

    if (this.operation === 'delete') {
      const matched = this.matched();
      for (const row of matched) {
        const index = this.rows.indexOf(row);
        if (index >= 0) this.rows.splice(index, 1);
      }
      return { data: matched.map((row) => ({ id: row.id })), error: null };
    }

    let result = this.matched();
    if (this.maxRows !== null) {
      result = result.slice(0, this.maxRows);
    }
    return { data: result, error: null };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    const { data, error } = this.execute();
    const row = Array.isArray(data) ? data[0] ?? null : data;
    return { data: row, error };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    return this.single();
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

export interface FakeSupabaseClient {
  from: (table: string) => FakePostgrestQuery;
  __store: Record<string, FakeRow[]>;
  __queries: FakePostgrestQuery[];
}

/** Creates a fresh fake admin client with its own in-memory tables. */
export function createSupabaseFake(): FakeSupabaseClient {
  const store: Record<string, FakeRow[]> = {};
  const queries: FakePostgrestQuery[] = [];

  return {
    from(table: string) {
      if (!store[table]) store[table] = [];
      const query = new FakePostgrestQuery(store[table]);
      queries.push(query);
      return query;
    },
    __store: store,
    __queries: queries,
  };
}
