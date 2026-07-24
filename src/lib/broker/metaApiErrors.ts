const PROVIDER_ACCOUNT_ID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function publicMetaApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("timed out waiting for account")
    && normalized.includes("connect to the broker")
  ) {
    return "The broker connection is temporarily unavailable. Automatic synchronization will keep retrying in the background.";
  }

  if (
    normalized.includes("not connected to broker yet")
    || normalized.includes("failed to subscribe")
  ) {
    return "The broker is not connected yet. Automatic synchronization will retry without creating a duplicate connection.";
  }

  if (
    normalized.includes("synchronization with this synchronization id is already running")
    || normalized.includes("already running")
  ) {
    return "Broker synchronization is already in progress. The existing synchronization will continue.";
  }

  if (normalized.includes("not synchronized")) {
    return "The broker history is still synchronizing. Trades will appear automatically when synchronization completes.";
  }

  if (
    normalized.includes("authorization")
    || normalized.includes("authentication")
    || normalized.includes("invalid credentials")
  ) {
    return "The broker rejected the saved account credentials. Reconnect the account and verify the login, password, and server.";
  }

  return message
    .replace(PROVIDER_ACCOUNT_ID, "provider account")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
