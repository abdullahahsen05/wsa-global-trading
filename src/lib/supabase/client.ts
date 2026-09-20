import { createBrowserClient } from '@supabase/ssr'
import type { CookieOptions } from '@supabase/ssr'

const REMEMBER_SESSION_KEY = 'wsa-remember-session'

function shouldRememberSession(): boolean {
  if (typeof window === 'undefined') return true
  return window.localStorage.getItem(REMEMBER_SESSION_KEY) !== 'false'
}

function parseCookieHeader(cookieHeader: string): Record<string, string> {
  return cookieHeader.split(';').reduce<Record<string, string>>((cookies, part) => {
    const [rawName, ...rawValue] = part.trim().split('=')
    if (!rawName) return cookies
    cookies[decodeURIComponent(rawName)] = decodeURIComponent(rawValue.join('=') ?? '')
    return cookies
  }, {})
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`]
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.domain) parts.push(`Domain=${options.domain}`)
  if (options.sameSite) parts.push(`SameSite=${String(options.sameSite)}`)
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

function browserCookies() {
  return {
    getAll() {
      if (typeof document === 'undefined') return []
      const parsed = parseCookieHeader(document.cookie)
      return Object.entries(parsed).map(([name, value]) => ({ name, value: value ?? '' }))
    },
    setAll(cookies: { name: string; value: string; options: CookieOptions }[]) {
      if (typeof document === 'undefined') return
      const remember = shouldRememberSession()
      for (const cookie of cookies) {
        const options = { ...cookie.options }
        if (!remember && cookie.value) {
          delete options.maxAge
          delete options.expires
        }
        document.cookie = serializeCookie(cookie.name, cookie.value, options)
      }
    },
  }
}

export function setRememberSessionPreference(remember: boolean) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(REMEMBER_SESSION_KEY, remember ? 'true' : 'false')
}

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: browserCookies(),
      isSingleton: false,
    },
  )
}
