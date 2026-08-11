import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

type LockHandle = {
  owner: string;
  release: () => Promise<void>;
};

const fallbackLocks = new Map<string, { owner: string; expiresAt: number }>();
let warnedMissingDbLock = false;

function acquireFallbackLock(key: string, owner: string, ttlSeconds: number): LockHandle | null {
  const now = Date.now();
  const current = fallbackLocks.get(key);
  if (current && current.expiresAt > now && current.owner !== owner) return null;
  fallbackLocks.set(key, { owner, expiresAt: now + ttlSeconds * 1000 });
  return {
    owner,
    release: async () => {
      const active = fallbackLocks.get(key);
      if (active?.owner === owner) fallbackLocks.delete(key);
    },
  };
}

export async function acquireOperationalLock(
  key: string,
  ttlSeconds = 90,
): Promise<LockHandle | null> {
  const owner = `${process.pid}:${randomUUID()}`;
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("try_acquire_operational_lock", {
    p_key: key,
    p_owner: owner,
    p_ttl_seconds: ttlSeconds,
  });

  if (error) {
    if (!warnedMissingDbLock) {
      warnedMissingDbLock = true;
      console.warn(
        "[operational-lock] database lock function unavailable; using process-local fallback until migration 053 is applied.",
      );
    }
    return acquireFallbackLock(key, owner, ttlSeconds);
  }

  if (data !== true) return null;

  return {
    owner,
    release: async () => {
      const { error: releaseError } = await supabase.rpc("release_operational_lock", {
        p_key: key,
        p_owner: owner,
      });
      if (releaseError) {
        console.warn("[operational-lock] release failed:", releaseError.message);
      }
    },
  };
}
