export type MigrationTarget = {
  host: string;
  port: number;
  user: string;
  database: "postgres";
  password: string;
  projectRef: string;
};

export function resolveMigrationTarget(values: Record<string, string | undefined>): MigrationTarget {
  const rawUrl = values.NEXT_PUBLIC_SUPABASE_URL;
  const password = values.SUPABASE_DB_PASSWORD;
  if (!rawUrl || !password) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_DB_PASSWORD are required for migrations.");
  }

  let projectRef: string;
  try {
    const url = new URL(rawUrl);
    const match = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
    if (url.protocol !== "https:" || !match) throw new Error("invalid project URL");
    projectRef = match[1];
  } catch {
    throw new Error("Migrations require an HTTPS Supabase project URL.");
  }

  const host = values.SUPABASE_DB_HOST ?? `db.${projectRef}.supabase.co`;
  const pooler = /^aws-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  if (host !== `db.${projectRef}.supabase.co` && !pooler) {
    throw new Error("SUPABASE_DB_HOST must be this project's direct host or a Supabase pooler.");
  }
  const user = values.SUPABASE_DB_USER ?? (pooler ? "" : "postgres");
  if (pooler && user !== `postgres.${projectRef}`) {
    throw new Error("Pooler username must match the configured Supabase project.");
  }
  if (!pooler && user !== "postgres") {
    throw new Error("Direct database username must be postgres.");
  }
  const port = Number(values.SUPABASE_DB_PORT ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SUPABASE_DB_PORT must be a valid TCP port.");
  }
  return { host, port, user, database: "postgres", password, projectRef };
}
