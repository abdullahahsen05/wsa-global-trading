/** Read-only pre/post-cutover comparison. Never performs a migration or sends an order. */
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { resolveMigrationTarget } from "./supabase-migration-target";

const PROJECTS = [
  { name: "seoul-source", ref: "brtdyxidblyimqteduph", host: "aws-1-ap-northeast-2.pooler.supabase.com", envFile: ".env.local" },
  { name: "london-stage", ref: "vyuyifegaacqigkzgiws", host: "aws-0-eu-west-2.pooler.supabase.com", envFile: ".env.london.local" },
] as const;
const KEY_TABLES = [
  "_migrations", "profiles", "trading_accounts", "copy_master_events", "copy_trade_links",
  "self_copy_trade_links", "background_jobs", "trade_commands", "account_snapshots", "audit_logs",
] as const;
const exact = process.argv.includes("--exact");
const requireIdentical = process.argv.includes("--require-identical");

function loadEnv(file: string) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => /^[A-Z_][A-Z_0-9]*=/.test(line))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, "")];
      }),
  );
}

async function inspect(project: (typeof PROJECTS)[number]) {
  const target = resolveMigrationTarget({
    ...loadEnv(project.envFile),
    SUPABASE_DB_HOST: project.host,
    SUPABASE_DB_USER: `postgres.${project.ref}`,
  });
  if (target.projectRef !== project.ref) throw new Error(`${project.name}: URL does not match the approved project`);
  const db = new Client({
    host: target.host, port: target.port, user: target.user, password: target.password,
    database: target.database, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
  });
  try {
    await db.connect();
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // Static SQL only: this check must remain read-only against both projects.
    const { rows: [schema] } = await db.query(`
      SELECT
        (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE') AS tables,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') AS functions,
        (SELECT count(*)::int FROM pg_policies WHERE schemaname='public') AS policies,
        (SELECT count(*)::int FROM pg_indexes WHERE schemaname='public') AS indexes,
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal) AS triggers,
        (SELECT count(*)::int FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public') AS realtime_tables,
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth' AND c.relname='users' AND NOT t.tgisinternal) AS auth_user_triggers
    `);
    const { rows: [managed] } = await db.query(`
      SELECT
        (SELECT count(*)::int FROM auth.users) AS auth_users,
        (SELECT count(*)::int FROM auth.identities) AS auth_identities,
        (SELECT count(*)::int FROM storage.buckets) AS storage_buckets,
        (SELECT count(*)::int FROM storage.objects) AS storage_objects
    `);
    const { rows: [pending] } = await db.query(`
      SELECT
        (SELECT count(*)::int FROM public.copy_trade_links WHERE status IN ('PENDING','CLOSING')) AS strategy_links,
        (SELECT count(*)::int FROM public.self_copy_trade_links WHERE status IN ('PENDING','CLOSING')) AS self_copy_links,
        (SELECT count(*)::int FROM public.background_jobs WHERE type='EXECUTE_COPY_EVENT' AND status IN ('PENDING','RUNNING')) AS copy_jobs,
        (SELECT count(*)::int FROM public.trade_commands WHERE status IN ('PENDING','RUNNING') AND expires_at > now()) AS trade_commands,
        (SELECT count(*)::int FROM public.copy_master_events WHERE created_at > now() - interval '1 hour') AS master_events_last_hour
    `);
    const tables = exact
      ? (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows.map((row) => row.tablename as string)
      : [...KEY_TABLES];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      // Names come only from our static list or PostgreSQL's own catalog.
      const quoted = `"${table.replaceAll('"', '""')}"`;
      const { rows } = await db.query(`SELECT count(*)::int AS count FROM public.${quoted}`);
      counts[table] = rows[0].count;
    }
    return { project: project.name, schema, managed, pending, counts };
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end().catch(() => undefined);
  }
}

async function main() {
  const [source, london] = await Promise.all(PROJECTS.map(inspect));
  const differences = {
    schema: Object.keys(source.schema).filter((key) => source.schema[key] !== london.schema[key]),
    managed: Object.keys(source.managed).filter((key) => source.managed[key] !== london.managed[key]),
    tableCounts: Object.keys(source.counts).filter((key) => source.counts[key] !== london.counts[key]),
  };
  console.log(JSON.stringify({ checkedAtUtc: new Date().toISOString(), exact, source, london, differences }, null, 2));
  if (requireIdentical && Object.values(differences).some((list) => list.length > 0)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Cutover check failed${error && typeof error === "object" && "code" in error ? ` (${String(error.code)})` : ""}.`);
  process.exitCode = 1;
});
