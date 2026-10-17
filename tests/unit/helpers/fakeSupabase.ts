/**
 * A very small in-memory stand-in for the Supabase admin client, just enough for
 * the terminal routes and services: select / eq / in / order / limit / maybeSingle
 * and upsert. It remembers every query so tests can assert that a query was
 * filtered by the caller's id.
 */

export type Row = Record<string, unknown>;

export interface FilterCall {
  op: "eq" | "in";
  column: string;
  value: unknown;
}

export interface QueryCall {
  table: string;
  kind: "select" | "upsert";
  filters: FilterCall[];
  limit: number | null;
  payload?: Row;
  conflictColumn?: string;
}

interface QueryError {
  code?: string;
  message: string;
}

class FakeDb {
  tables: Record<string, Row[]> = {};
  /** an error returned by every select on the table */
  selectErrors: Record<string, QueryError> = {};
  /** an error returned by every upsert on the table */
  upsertErrors: Record<string, QueryError> = {};
  calls: QueryCall[] = [];

  reset(): void {
    this.tables = {};
    this.selectErrors = {};
    this.upsertErrors = {};
    this.calls = [];
  }

  callsTo(table: string, kind: QueryCall["kind"] = "select"): QueryCall[] {
    return this.calls.filter((call) => call.table === table && call.kind === kind);
  }

  from = (table: string) => {
    const filters: FilterCall[] = [];
    let limit: number | null = null;
    let single = false;
    let upsertPayload: Row | null = null;
    let conflictColumn: string | undefined;

    const run = () => {
      if (upsertPayload) {
        this.calls.push({
          table,
          kind: "upsert",
          filters: [],
          limit: null,
          payload: upsertPayload,
          conflictColumn,
        });
        const failure = this.upsertErrors[table];
        if (failure) return { data: null, error: failure };
        const rows = (this.tables[table] ??= []);
        const key = conflictColumn ?? "id";
        const index = rows.findIndex((row) => row[key] === upsertPayload?.[key]);
        if (index >= 0) rows[index] = { ...rows[index], ...upsertPayload };
        else rows.push({ ...upsertPayload });
        return { data: null, error: null };
      }

      this.calls.push({ table, kind: "select", filters: [...filters], limit });
      const failure = this.selectErrors[table];
      if (failure) return { data: null, error: failure };
      let rows = (this.tables[table] ?? []).filter((row) =>
        filters.every((filter) =>
          filter.op === "eq"
            ? row[filter.column] === filter.value
            : (filter.value as unknown[]).includes(row[filter.column]),
        ),
      );
      if (limit !== null) rows = rows.slice(0, limit);
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push({ op: "eq", column, value });
        return builder;
      },
      in: (column: string, value: unknown[]) => {
        filters.push({ op: "in", column, value });
        return builder;
      },
      limit: (count: number) => {
        limit = count;
        return builder;
      },
      maybeSingle: () => {
        single = true;
        return builder;
      },
      upsert: (payload: Row, options?: { onConflict?: string }) => {
        upsertPayload = payload;
        conflictColumn = options?.onConflict;
        return builder;
      },
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  };
}

export const fakeDb = new FakeDb();
