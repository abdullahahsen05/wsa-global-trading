const PRODUCTION_ORIGIN = "https://wsa-global-trading-platform.vercel.app";

function usablePublicOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function getAuthRedirectOrigin(): string {
  if (typeof window !== "undefined") {
    const origin = usablePublicOrigin(window.location.origin);
    if (origin) return origin;
  }

  return (
    usablePublicOrigin(process.env.NEXT_PUBLIC_SITE_URL) ??
    usablePublicOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    PRODUCTION_ORIGIN
  );
}
