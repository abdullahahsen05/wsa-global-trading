export const runtime = 'nodejs';

import { jsonFail, jsonOk } from '@/lib/api/envelope';
import { requireTrader, AuthError } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { enqueueJob } from '@/lib/services/backgroundJobService';
import { z } from 'zod';

const bodySchema = z.object({
  accountId: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  try {
    const user = await requireTrader();
    const supabase = createAdminClient();

    console.log('[TRADER_SYNC_AUTH_USER]', { userId: user.id });

    let body: { accountId?: string } = {};
    try {
      const raw = await request.json();
      const parsed = bodySchema.safeParse(raw);
      if (!parsed.success) {
        return jsonFail('INVALID_BODY', parsed.error.issues.map(i => i.message).join('; '), 400);
      }
      body = parsed.data;
    } catch {
      body = {};
    }

    // Vercel must not create long-lived MetaApi websocket sessions. The AWS
    // stream worker owns real-time projection; a stale account gets a bounded
    // worker-side fallback job instead.
    let accountQuery = supabase
      .from('trading_accounts')
      .select('id, status, provider_account_id, last_synced_at')
      .eq('user_id', user.id)
      .in('status', ['CONNECTED', 'RESTRICTED'])
      .not('provider_account_id', 'is', null);

    if (body.accountId) {
      accountQuery = accountQuery.eq('id', body.accountId);
    }

    const { data: accounts, error: acErr } = await accountQuery;

    if (acErr) {
      console.error('[TRADER_SYNC_DB_ERROR]', { message: acErr.message });
      return jsonFail('DB_ERROR', acErr.message, 500);
    }

    console.log('[TRADER_SYNC_ACCOUNTS_FOUND]', {
      count: accounts?.length ?? 0,
      accounts: (accounts ?? []).map(a => ({
        id: a.id,
        status: a.status,
        last_synced_at: a.last_synced_at,
      })),
    });

    if (!accounts || accounts.length === 0) {
      return jsonFail(
        'NO_CONNECTED_ACCOUNT',
        body.accountId
          ? 'Account not found, not owned by you, or not yet synced by an admin (provider_account_id is null).'
          : 'No connected accounts found. An admin must connect your account first.',
        400,
      );
    }

    const results = [];
    const liveCutoff = Date.now() - 90_000;
    for (const account of accounts) {
      const lastSyncedAt = account.last_synced_at
        ? new Date(account.last_synced_at).getTime()
        : 0;
      if (Number.isFinite(lastSyncedAt) && lastSyncedAt >= liveCutoff) {
        results.push({
          accountId: account.id,
          mode: 'LIVE',
          lastSyncedAt: account.last_synced_at,
          message: 'Live synchronization is active. The ledger has been refreshed.',
        });
        continue;
      }

      const job = await enqueueJob({
        type: 'SYNC_ACCOUNT',
        payload: { accountId: account.id },
        uniqueKey: `SYNC_ACCOUNT:${account.id}`,
        createdBy: user.id,
        priority: 50,
      });
      results.push({
        accountId: account.id,
        mode: 'QUEUED',
        jobStatus: job.status,
        lastSyncedAt: account.last_synced_at,
        message: 'Broker synchronization was queued. Trades will appear automatically after the worker reconnects.',
      });
    }

    const queued = results.some((result) => result.mode === 'QUEUED');
    return jsonOk({
      results,
      automatic: true,
      message: queued
        ? 'Some accounts were stale and have been queued for background synchronization.'
        : 'Live trade synchronization is active.',
    }, { status: queued ? 202 : 200 });

  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    const message = err instanceof Error ? err.message : 'Unexpected error during trade sync';
    console.error('[TRADER_SYNC_ERROR]', { message });
    return jsonFail('SYNC_ERROR', message, 500);
  }
}
