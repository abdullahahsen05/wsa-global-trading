import { createClient } from '@supabase/supabase-js'
import { databaseFetch } from '@/lib/broker/api2TradeTransport'

function buildAdminClient(url: string, serviceKey: string) {
  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    // The platform fetch, except in a worker that switched the keep-alive pool on: there the
    // database calls reuse open connections instead of a new handshake after four idle seconds.
    global: { fetch: databaseFetch },
  })
}

let cached: { url: string; serviceKey: string; client: ReturnType<typeof buildAdminClient> } | null = null

// WARNING: This client bypasses RLS. Only use in trusted server-side code.
//
// One client is kept per process (and per URL / key pair): the copy worker asks for it
// dozens of times per trade, and building a new client (auth, REST and realtime objects)
// every time is work on the hot path for nothing. It carries no per-request state - it
// never signs a user in (the only auth call made with it is `auth.admin.generateLink`) -
// so sharing it is safe. Never sign a user in with it: that would turn every later query
// of the process into a request made as that user.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error('Missing Supabase admin environment variables')
  }

  if (cached && cached.url === url && cached.serviceKey === serviceKey) return cached.client
  const client = buildAdminClient(url, serviceKey)
  cached = { url, serviceKey, client }
  return client
}
