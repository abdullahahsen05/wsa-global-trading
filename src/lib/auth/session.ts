import { createHash } from 'node:crypto'
import { createClient } from '@/lib/supabase/server'
import { isAdmin, parseUserRole, type UserRole } from '@/lib/auth/rbac'

export interface SessionUser {
  id: string
  email: string
  name: string
  role: UserRole
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING'
}

export interface SignInOptions {
  /**
   * Take the sign-in this server verified a few seconds ago for the SAME session token instead of asking
   * Supabase again (a token check plus a profile read). Meant for the paths that are called many times a
   * second (WSA Trade); the price is that a suspension or a role change shows up there up to
   * `SIGN_IN_HOLD_MS` later. Everything else keeps the full check on every request.
   */
  cached?: boolean
}

type ServerClient = Awaited<ReturnType<typeof createClient>>

const PROFILE_COLUMNS = 'id, email, full_name, role, status'

/** How long a verified sign-in is taken as still true (never longer than the token itself lives). */
export const SIGN_IN_HOLD_MS = 10_000
const SIGN_IN_HOLD_MAX = 500
const heldSignIns = new Map<string, { user: SessionUser; until: number }>()
/** Requests that arrive while the same token is being verified wait for that one check instead of making their own. */
const signInsInFlight = new Map<string, Promise<SessionUser | null>>()

/** Test helper: forget the sign-ins this instance has verified. */
export function resetSignInCache(): void {
  heldSignIns.clear()
  signInsInFlight.clear()
}

function toSessionUser(profile: { id: string; email: string; full_name: string; role: unknown; status: string }): SessionUser | null {
  const role = parseUserRole(profile.role)
  if (!role) return null
  return {
    id: profile.id,
    email: profile.email,
    name: profile.full_name,
    role,
    status: profile.status as 'ACTIVE' | 'SUSPENDED' | 'PENDING',
  }
}

function readProfile(supabase: ServerClient, id: string) {
  return supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', id).single()
}

/**
 * The full check: Supabase verifies the token, then the profile (role, status) is read.
 *
 * When the token says whose it is (`hintedId`, read from the token WITHOUT trusting it) the profile is
 * read while Supabase verifies the token - one round trip instead of two. The read only counts if the
 * verified user is that very person, and the profile query runs with the person's own token, so a forged
 * token gets nothing from it anyway.
 */
async function verifiedSignIn(supabase: ServerClient, hintedId: string | null): Promise<SessionUser | null> {
  const guessed = hintedId ? Promise.resolve(readProfile(supabase, hintedId)).catch(() => null) : null

  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null

  let reply = guessed && hintedId === user.id ? await guessed : null
  if (!reply || reply.error || !reply.data) reply = await readProfile(supabase, user.id)
  if (reply.error || !reply.data) return null
  return toSessionUser(reply.data)
}

/** What a session token says about itself. Unverified - only used to start a read early and to shorten a hold. */
function tokenClaims(token: string): { sub?: string; exp?: number } {
  const payload = token.split('.')[1]
  if (!payload) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    const { sub, exp } = parsed as { sub?: unknown; exp?: unknown }
    return {
      sub: typeof sub === 'string' ? sub : undefined,
      exp: typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined,
    }
  } catch {
    return {}
  }
}

function holdSignIn(key: string, user: SessionUser, expiresAtSeconds: number | undefined): void {
  const now = Date.now()
  const until = Math.min(now + SIGN_IN_HOLD_MS, expiresAtSeconds !== undefined ? expiresAtSeconds * 1000 : Number.POSITIVE_INFINITY)
  if (until <= now) return
  if (heldSignIns.size >= SIGN_IN_HOLD_MAX) heldSignIns.clear()
  heldSignIns.set(key, { user, until })
}

/** The sign-in for hot paths: a verified one for this exact token is reused for a few seconds. Only a "yes" is ever kept. */
async function heldSignInFor(supabase: ServerClient): Promise<SessionUser | null> {
  // (reads the session cookie - no network call unless the token has to be renewed)
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token
  if (!token) return null

  const key = createHash('sha256').update(token).digest('base64url')
  const held = heldSignIns.get(key)
  if (held && held.until > Date.now()) return { ...held.user }

  const running = signInsInFlight.get(key)
  if (running) {
    const shared = await running
    return shared ? { ...shared } : null
  }
  const claims = tokenClaims(token)
  const check = verifiedSignIn(supabase, claims.sub ?? null).then((user) => {
    if (user) holdSignIn(key, user, claims.exp)
    return user
  })
  signInsInFlight.set(key, check)
  try {
    const user = await check
    return user ? { ...user } : null
  } finally {
    signInsInFlight.delete(key)
  }
}

/**
 * Get current authenticated user from Supabase session.
 * Returns null if not authenticated.
 */
export async function getCurrentUser(options: SignInOptions = {}): Promise<SessionUser | null> {
  try {
    const supabase = await createClient()
    return options.cached ? await heldSignInFor(supabase) : await verifiedSignIn(supabase, null)
  } catch {
    return null
  }
}

/**
 * Require authentication - throws if not authenticated.
 * Use in API route handlers.
 */
export async function requireAuth(options: SignInOptions = {}): Promise<SessionUser> {
  const user = await getCurrentUser(options)
  if (!user) {
    throw new AuthError('UNAUTHORIZED', 'Not authenticated', 401)
  }
  if (user.status === 'SUSPENDED') {
    throw new AuthError('SUSPENDED', 'Account suspended', 403)
  }
  return user
}

/**
 * Require ADMIN role.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireAuth()
  if (!isAdmin(user.role)) {
    throw new AuthError('FORBIDDEN', 'Admin access required', 403)
  }
  return user
}

/**
 * Require SUPER_ADMIN for operations that mutate encrypted platform secrets.
 */
export async function requireSuperAdmin(): Promise<SessionUser> {
  const user = await requireAuth()
  if (user.role !== 'SUPER_ADMIN') {
    throw new AuthError('FORBIDDEN', 'Super Admin access required', 403)
  }
  return user
}

/**
 * Require TRADER role (or admin, since admins can preview trader data).
 */
export async function requireTrader(options: SignInOptions = {}): Promise<SessionUser> {
  const user = await requireAuth(options)
  if (user.role !== 'TRADER' && !isAdmin(user.role)) {
    throw new AuthError('FORBIDDEN', 'Trader access required', 403)
  }
  return user
}

/**
 * Require PARTNER role.
 */
export async function requirePartner(): Promise<SessionUser> {
  const user = await requireAuth()
  if (user.role !== 'PARTNER') {
    throw new AuthError('FORBIDDEN', 'Partner access required', 403)
  }
  return user
}

/**
 * Get role of current user without throwing.
 */
export async function getUserRole(): Promise<UserRole | null> {
  const user = await getCurrentUser()
  return user?.role ?? null
}

/**
 * Assert that the current user can access a specific trading account.
 * Admins can access any account. Traders can only access their own.
 */
export async function assertCanAccessAccount(accountId: string): Promise<SessionUser> {
  const user = await requireAuth()

  if (isAdmin(user.role)) return user

  // Verify the account belongs to this user
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('trading_accounts')
    .select('id')
    .eq('id', accountId)
    .eq('user_id', user.id)
    .single()

  if (error || !data) {
    throw new AuthError('FORBIDDEN', 'You do not have access to this account', 403)
  }

  return user
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 401
  ) {
    super(message)
    this.name = 'AuthError'
  }
}
