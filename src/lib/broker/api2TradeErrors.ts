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

export function publicBrokerConnectionError(error: unknown): string {
  const sanitized = publicApi2TradeError(error);
  const normalized = sanitized.toLowerCase();

  if (
    normalized.includes("trading account not found")
    || normalized.includes("client with id")
    || normalized.includes("invalid_token")
    || normalized.includes("forbidden")
    || normalized.includes("unauthorized")
    || normalized.includes("403")
  ) {
    return "Connection failed. Please recheck the broker login, password, server, and broker name, then try again.";
  }

  if (
    normalized.includes("parameters not valid or missing")
    || normalized.includes("invalid type parameter")
    || normalized.includes("broker selection")
    || normalized.includes("server is required")
  ) {
    return "Connection failed because some broker details are invalid or incomplete. Please review the account details and try again.";
  }

  if (normalized.includes("not configured")) {
    return "Connection service is not configured right now. Please try again later.";
  }

  return "Connection failed. Please verify the broker details and try again.";
}
