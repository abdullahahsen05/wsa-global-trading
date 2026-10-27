import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { Client } from 'pg'
import { resolveMigrationTarget } from './supabase-migration-target'

function loadLocalEnv(): Record<string, string> {
  const values: Record<string, string> = {}
  try {
    const raw = readFileSync(join(process.cwd(), '.env.local'), 'utf-8')
    for (const line of raw.split(/\r?\n/)) {
      const value = line.trim()
      if (!value || value.startsWith('#')) continue
      const separator = value.indexOf('=')
      if (separator > 0) values[value.slice(0, separator).trim()] = value.slice(separator + 1).trim()
    }
  } catch {
    // Environment variables remain the fallback.
  }
  return values
}

const localEnv = loadLocalEnv()
const target = resolveMigrationTarget({ ...localEnv, ...process.env })

const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
const requestedMigrations = new Set(process.argv.slice(2))
const ALL_MIGRATIONS = readdirSync(migrationsDir)
  .filter((file) => /^\d{3}_.+\.sql$/.test(file))
  .filter((file) => requestedMigrations.size === 0 || requestedMigrations.has(file))
  .sort((left, right) => left.localeCompare(right))

if (requestedMigrations.size > 0 && ALL_MIGRATIONS.length !== requestedMigrations.size) {
  throw new Error('One or more requested migration files do not exist.')
}

async function runMigrations() {
  const client = new Client({
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    ssl: { rejectUnauthorized: false },
  })

  try {
    await client.connect()
    console.log(`Connected to Supabase project ${target.projectRef}\n`)

    // Create a simple migrations tracking table if it does not exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `)

    for (const file of ALL_MIGRATIONS) {
      // Check if already applied
      const { rows } = await client.query(
        'SELECT 1 FROM public._migrations WHERE name = $1',
        [file]
      )
      if (rows.length > 0) {
        console.log(`  [skip]  ${file}  (already applied)`)
        continue
      }

      const filePath = join(process.cwd(), 'supabase', 'migrations', file)
      if (!existsSync(filePath)) {
        console.warn(`  [warn]  ${file} not found — skipping`)
        continue
      }

      const sql = readFileSync(filePath, 'utf-8')
      console.log(`  [run]   ${file}`)
      await client.query(sql)

      // Mark as applied
      await client.query(
        'INSERT INTO public._migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      )
      console.log(`  [done]  ${file}`)
    }

    console.log('\nAll migrations up to date.')
  } catch (error) {
    console.error('\nMigration failed:', error)
    process.exit(1)
  } finally {
    await client.end()
  }
}

runMigrations()
