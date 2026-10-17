if (typeof window !== "undefined") {
  throw new Error("[wsa] api2TradeTransport is server-only.");
}

/**
 * How requests to the broker service leave this process.
 *
 * By default that is the platform `fetch`, whose connection pool closes an idle
 * connection after about four seconds. The copy worker sends a burst of orders (one
 * per follower, all at once) after seconds of silence, so most of them used to start
 * with a fresh TCP + TLS handshake. `enableApi2TradeConnectionPool()` swaps in a pool
 * that keeps connections open for half a minute and allows many parallel ones; the
 * copy worker switches it on at start-up. It is optional by design:
 *
 *  - nothing changes for the web app (it never calls it);
 *  - if the `undici` package cannot be loaded, or `API2TRADE_KEEPALIVE_POOL=false`,
 *    the platform `fetch` stays in use;
 *  - `brokerFetch` looks `fetch` up at call time, so a test can still replace it.
 */

type FetchFunction = (input: URL | string, init?: RequestInit) => Promise<Response>;

let pooledFetch: FetchFunction | null = null;
/** when the database connections were last warmed (see `warmDatabaseConnections`) */
let databaseWarmedAt = 0;

function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function brokerFetch(input: URL | string, init?: RequestInit): Promise<Response> {
  if (pooledFetch) return pooledFetch(input, init);
  return fetch(input, init);
}

export function connectionPoolEnabled(): boolean {
  return pooledFetch !== null;
}

/**
 * The same pool for the database. A worker talks to Supabase all day, and the platform
 * `fetch` drops a connection that has been idle for four seconds, so the first copy after
 * a quiet moment started every one of its database calls with a new TCP + TLS handshake
 * (three round trips, on a distant database several hundred milliseconds) right in front
 * of the order. With the pool on, those connections are still open.
 *
 * It is the platform `fetch` whenever the pool is off (the web app on Vercel never turns
 * it on), when `WSA_DB_KEEPALIVE_POOL=false`, or when the call carries a ready-made
 * `Request` object (the database client never sends one).
 */
export function databaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const pooled = pooledFetch;
  if (!pooled || process.env.WSA_DB_KEEPALIVE_POOL === "false") return fetch(input, init);
  if (typeof input === "string" || input instanceof URL) return pooled(input, init);
  return fetch(input, init);
}

/**
 * Leaves up to `count` database connections open and idle, ready for the burst of calls a
 * copy makes (one event write, then one reservation per follower, all at once). A pool only
 * keeps the connections it has used lately, and in a quiet minute that is one or two.
 * Cheap on purpose: `count` one-row reads of a small table, at most once every 8 seconds.
 */
export function warmDatabaseConnections(read: () => PromiseLike<unknown>, count: number): void {
  if (!pooledFetch || process.env.WSA_DB_KEEPALIVE_POOL === "false") return;
  const now = Date.now();
  if (now - databaseWarmedAt < 8_000) return;
  databaseWarmedAt = now;
  for (let index = 0; index < Math.min(Math.max(count, 1), 32); index += 1) {
    try {
      void Promise.resolve(read()).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // warming is an optimisation, never a reason to fail
    }
  }
}

/** Turns the keep-alive pool on. Resolves to whether it is active (false = the default fetch is used). */
export async function enableApi2TradeConnectionPool(): Promise<boolean> {
  if (pooledFetch) return true;
  if (process.env.API2TRADE_KEEPALIVE_POOL === "false") return false;
  try {
    // Loaded by name at run time (never bundled): the worker runs it from node_modules.
    const loaded = (await import(/* webpackIgnore: true */ "undici")) as unknown as {
      default?: UndiciModule;
    } & UndiciModule;
    const undici: UndiciModule = loaded.Agent ? loaded : (loaded.default as UndiciModule);
    if (!undici?.Agent || !undici.fetch) throw new Error("the undici module has no Agent / fetch");
    const agent = new undici.Agent({
      keepAliveTimeout: numberFromEnv("API2TRADE_KEEPALIVE_MS", 30_000, 4_000, 300_000),
      keepAliveMaxTimeout: 300_000,
      connections: numberFromEnv("API2TRADE_POOL_CONNECTIONS", 64, 4, 512),
      pipelining: 1,
      connect: { timeout: 8_000 },
    });
    pooledFetch = (input, init) => undici.fetch(input, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
    return true;
  } catch (error) {
    console.warn(
      `[api2trade] keep-alive connection pool unavailable, using the default fetch: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    return false;
  }
}

/** Test hook: back to the default fetch. */
export function resetApi2TradeConnectionPool(): void {
  pooledFetch = null;
  databaseWarmedAt = 0;
}

interface UndiciModule {
  Agent: new (options: Record<string, unknown>) => unknown;
  fetch: (input: URL | string, init?: Record<string, unknown>) => Promise<unknown>;
}
