/**
 * A small in-memory stand-in for the Supabase client, wide enough for the trade gateway:
 * select / insert / update / upsert / delete with eq / in / gt / gte / lt filters, single
 * and maybeSingle, unique keys (error 23505), errors per table and rpc handlers. Every
 * call is remembered so tests can assert what was asked.
 */

export type Row = Record<string, unknown>;

interface Filter {
  op: "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte";
  column: string;
  value: unknown;
}

export interface DbCall {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  filters: Filter[];
  payload?: unknown;
}

export interface DbError {
  code?: string;
  message: string;
}

type Defaults = (row: Row) => Row;

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const actual = row[filter.column];
    const wanted = filter.value;
    switch (filter.op) {
      case "eq":
        return actual === wanted;
      case "neq":
        return actual !== wanted;
      case "in":
        return (wanted as unknown[]).includes(actual);
      case "gt":
        return actual !== null && actual !== undefined && String(actual) > String(wanted);
      case "gte":
        return actual !== null && actual !== undefined && String(actual) >= String(wanted);
      case "lt":
        return actual !== null && actual !== undefined && String(actual) < String(wanted);
      case "lte":
        return actual !== null && actual !== undefined && String(actual) <= String(wanted);
    }
  });
}

export class MemoryDb {
  tables: Record<string, Row[]> = {};
  /** per table: sets of columns that must be unique */
  unique: Record<string, string[][]> = {};
  /** per table: fills in what the database would (id, status, times ...) on insert */
  defaults: Record<string, Defaults> = {};
  /** an error returned by every operation on the table */
  errors: Record<string, DbError> = {};
  rpcHandlers: Record<string, (args: Row) => { data: unknown; error: DbError | null }> = {};
  calls: DbCall[] = [];

  reset(): void {
    this.tables = {};
    this.unique = {};
    this.defaults = {};
    this.errors = {};
    this.rpcHandlers = {};
    this.calls = [];
  }

  callsTo(table: string, op?: DbCall["op"]): DbCall[] {
    return this.calls.filter((call) => call.table === table && (op === undefined || call.op === op));
  }

  rpc = async (name: string, args: Row) => {
    const handler = this.rpcHandlers[name];
    if (!handler) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } };
    return handler(args);
  };

  from = (table: string) => {
    const filters: Filter[] = [];
    let op: DbCall["op"] = "select";
    let payload: unknown;
    let conflictColumn: string | undefined;
    let returning = false;
    let single: "single" | "maybe" | null = null;
    let limit: number | null = null;

    const violatesUnique = (candidate: Row, ignore?: Row): boolean =>
      (this.unique[table] ?? []).some((columns) =>
        (this.tables[table] ?? []).some(
          (row) => row !== ignore && columns.every((column) => row[column] === candidate[column]),
        ),
      );

    const shape = (rows: Row[]) => {
      if (single === "single") {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      }
      if (single === "maybe") return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };

    const run = () => {
      this.calls.push({ table, op, filters: [...filters], payload });
      const failure = this.errors[table];
      if (failure) return { data: null, error: failure };
      const rows = (this.tables[table] ??= []);

      if (op === "insert") {
        const candidate = { ...(this.defaults[table]?.(payload as Row) ?? {}), ...(payload as Row) };
        if (violatesUnique(candidate)) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
        rows.push(candidate);
        return returning ? shape([candidate]) : { data: null, error: null };
      }

      if (op === "upsert") {
        const key = conflictColumn ?? "id";
        const existing = rows.find((row) => row[key] === (payload as Row)[key]);
        if (existing) Object.assign(existing, payload as Row);
        else rows.push({ ...(this.defaults[table]?.(payload as Row) ?? {}), ...(payload as Row) });
        return returning ? shape([existing ?? rows[rows.length - 1]]) : { data: null, error: null };
      }

      const selected = rows.filter((row) => matches(row, filters));
      if (op === "update") {
        for (const row of selected) Object.assign(row, payload as Row);
        return returning ? shape(selected) : { data: null, error: null };
      }
      if (op === "delete") {
        this.tables[table] = rows.filter((row) => !selected.includes(row));
        return returning ? shape(selected) : { data: null, error: null };
      }
      return shape(limit === null ? selected : selected.slice(0, limit));
    };

    const builder: Record<string, unknown> = {
      select: () => {
        if (op !== "select") returning = true;
        return builder;
      },
      insert: (row: Row) => {
        op = "insert";
        payload = row;
        return builder;
      },
      update: (patch: Row) => {
        op = "update";
        payload = patch;
        return builder;
      },
      upsert: (row: Row, options?: { onConflict?: string }) => {
        op = "upsert";
        payload = row;
        conflictColumn = options?.onConflict;
        return builder;
      },
      delete: () => {
        op = "delete";
        return builder;
      },
      eq: (column: string, value: unknown) => (filters.push({ op: "eq", column, value }), builder),
      neq: (column: string, value: unknown) => (filters.push({ op: "neq", column, value }), builder),
      in: (column: string, value: unknown[]) => (filters.push({ op: "in", column, value }), builder),
      gt: (column: string, value: unknown) => (filters.push({ op: "gt", column, value }), builder),
      gte: (column: string, value: unknown) => (filters.push({ op: "gte", column, value }), builder),
      lt: (column: string, value: unknown) => (filters.push({ op: "lt", column, value }), builder),
      lte: (column: string, value: unknown) => (filters.push({ op: "lte", column, value }), builder),
      order: () => builder,
      limit: (count: number) => {
        limit = count;
        return builder;
      },
      single: () => {
        single = "single";
        return builder;
      },
      maybeSingle: () => {
        single = "maybe";
        return builder;
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  };
}

/** The client shape the gateway modules use. */
export function memoryClient(db: MemoryDb) {
  return { from: db.from, rpc: db.rpc } as never;
}

/**
 * One shared instance (and one client object) for tests that mock the module returning
 * the admin client: a `vi.mock` factory cannot see the test file's own variables, but it
 * can import this module. The client is ONE object on purpose - like the memoised
 * `createAdminClient()` - because the gateway caches its heartbeat read per client.
 */
export const sharedDb = new MemoryDb();
export const sharedClient = memoryClient(sharedDb);
