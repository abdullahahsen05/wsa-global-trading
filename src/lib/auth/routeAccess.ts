import { isAdmin, type UserRole } from '@/lib/auth/rbac'

export const AUTH_ROUTE_PREFIXES = ['/login', '/register', '/forgot-password', '/reset-password'] as const
export const PUBLIC_ROUTE_PREFIXES = ['/certificates', '/demo'] as const
export const PARTNER_ROUTE_PREFIXES = ['/partner'] as const
export const ADMIN_ROUTE_PREFIXES = ['/admin'] as const
export const TRADER_ROUTE_PREFIXES = [
  '/dashboard',
  '/platform-preview',
  '/accounts',
  '/trades',
  '/analytics',
  '/risk',
  '/reports',
  '/settings',
  '/ai',
  '/copy-trading',
  '/academy',
  '/billing',
  '/marketplace',
  '/my-bots',
  '/evaluations',
  '/terminal',
  '/calendar',
  '/contact',
] as const

export function pathMatches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export function roleHome(role: UserRole): '/admin' | '/partner' | '/dashboard' {
  if (isAdmin(role)) return '/admin'
  if (role === 'PARTNER') return '/partner'
  return '/dashboard'
}

export function workspaceRedirect(role: UserRole, pathname: string): string | null {
  const home = roleHome(role)
  const isAuthRoute = pathMatches(pathname, AUTH_ROUTE_PREFIXES)
  const isPartnerRoute = pathMatches(pathname, PARTNER_ROUTE_PREFIXES)
  const isAdminRoute = pathMatches(pathname, ADMIN_ROUTE_PREFIXES)
  const isTraderRoute = pathMatches(pathname, TRADER_ROUTE_PREFIXES)
  const isRegisterRoute = pathname === "/register"

  if (isAuthRoute && !isRegisterRoute) return home

  if (role === 'PARTNER') {
    return isPartnerRoute ? null : '/partner'
  }

  if (isPartnerRoute) return home
  if (isAdminRoute && !isAdmin(role)) return home
  if (isTraderRoute && isAdmin(role)) return '/admin'

  return null
}
