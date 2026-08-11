export function publicApi2TradeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "API2Trade request failed.");
  return raw
    .replace(/password[^,\s]*/gi, "password=[redacted]")
    .replace(/user=\d+/gi, "user=[redacted]")
    .replace(/login[^,\s]*/gi, "login=[redacted]")
    .replace(/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic [redacted]")
    .replace(/x-api-key:\s*[^,\s]+/gi, "x-api-key: [redacted]")
    .slice(0, 500);
}
