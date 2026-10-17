// ─────────────────────────────────────────────────────────────────────────────
// Paged reads for PostgREST (Supabase).
//
// PostgREST answers at most 1000 rows per request, whatever `.limit(20000)`
// says, and it rejects very long URLs (a few hundred ids in an `in (...)`
// filter are enough). Code that must see *every* row of a growing table — a
// rebate row per closed trade, a trade row per order — therefore reads in pages
// with `.range()` and splits long id lists into chunks. Pure helpers: no
// framework imports, safe in the Vercel app and in the AWS workers.
// ─────────────────────────────────────────────────────────────────────────────

/** Rows PostgREST returns per request. */
export const SUPABASE_PAGE_SIZE = 1000;

/** Ids per `in (...)` filter: ~37 characters each, keeps the URL well below 8 KB. */
export const SUPABASE_IN_CHUNK = 100;

/** Safety stop: a runaway loop must never read the whole database. */
const DEFAULT_MAX_ROWS = 100_000;

type PageResponse = PromiseLike<{ data: unknown; error: { message: string } | null }>;

export function chunkArray<T>(items: readonly T[], size: number = SUPABASE_IN_CHUNK): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
}

/**
 * Reads every row of a query. `buildPage(from, to)` must return the query for
 * the inclusive row range (`query.range(from, to)`) and the query must have a
 * stable `.order(...)`, otherwise rows can repeat or be skipped between pages.
 */
export async function selectAllPages<T>(
  label: string,
  buildPage: (from: number, to: number) => PageResponse,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? SUPABASE_PAGE_SIZE, SUPABASE_PAGE_SIZE));
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = (Array.isArray(data) ? data : []) as T[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

/**
 * Same as `selectAllPages`, for a filter on a long list of ids: the list is
 * split into chunks and every chunk is read page by page.
 */
export async function selectAllPagesForIds<T>(
  label: string,
  ids: readonly string[],
  buildPage: (idChunk: string[], from: number, to: number) => PageResponse,
  options: { pageSize?: number; maxRows?: number; chunkSize?: number } = {},
): Promise<T[]> {
  const rows: T[] = [];
  for (const idChunk of chunkArray(ids, options.chunkSize ?? SUPABASE_IN_CHUNK)) {
    const chunkRows = await selectAllPages<T>(
      label,
      (from, to) => buildPage(idChunk, from, to),
      { pageSize: options.pageSize, maxRows: options.maxRows },
    );
    rows.push(...chunkRows);
  }
  return rows;
}
