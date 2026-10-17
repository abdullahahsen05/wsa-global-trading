import { handleAuthError, jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAuth } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  MAX_WORKSPACE_BYTES,
  defaultWorkspace,
  isRecord,
  mergeWorkspace,
  readWorkspaceFromLayout,
  withWorkspaceInLayout,
} from "@/lib/terminal/workspace";

/**
 * The trader's terminal workspace: open tab, TradingView symbol / timeframe /
 * personal watchlist / side panels and the MetaTrader web terminal settings
 * (source, selected account, accounts added by hand).
 *
 * Stored in terminal_user_preferences.layout.workspace (migration 016) - the
 * caller's own row only, always filtered by the session user. Whatever is stored
 * or sent is passed through `sanitizeWorkspace`, so a bad document can never
 * break the page. There is no password in this document.
 */

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /relation .* does not exist|could not find the table/i.test(error.message ?? "");
}

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } };

export async function GET() {
  try {
    const user = await requireAuth();
    const db = createAdminClient();
    const { data, error } = await db
      .from("terminal_user_preferences")
      .select("layout")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      if (isMissingTable(error)) {
        return jsonOk({ workspace: defaultWorkspace(), persisted: false, storage: "unavailable" }, NO_STORE);
      }
      throw new Error(error.message);
    }

    const layout = (data as { layout?: unknown } | null)?.layout;
    return jsonOk(
      {
        workspace: readWorkspaceFromLayout(layout),
        persisted: isRecord(layout) && isRecord(layout.workspace),
        storage: "ok",
      },
      NO_STORE,
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === "AuthError")) {
      console.error("[terminal] workspace read failed:", error instanceof Error ? error.message : "unknown error");
    }
    return handleAuthError(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireAuth();

    const text = await req.text();
    if (text.length > MAX_WORKSPACE_BYTES) {
      return jsonFail("PAYLOAD_TOO_LARGE", "The workspace settings are too large.", 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return jsonFail("VALIDATION_ERROR", "The request body must be JSON.", 400);
    }
    if (!isRecord(body) || !isRecord(body.workspace)) {
      return jsonFail("VALIDATION_ERROR", "Send the settings to save as { workspace: { ... } }.", 400);
    }

    const db = createAdminClient();
    const { data, error } = await db
      .from("terminal_user_preferences")
      .select("layout")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) {
      if (isMissingTable(error)) {
        return jsonFail(
          "TERMINAL_STORAGE_UNAVAILABLE",
          "Terminal settings cannot be saved on this deployment yet.",
          503,
        );
      }
      throw new Error(error.message);
    }

    const existingLayout = (data as { layout?: unknown } | null)?.layout;
    const next = mergeWorkspace(readWorkspaceFromLayout(existingLayout), body.workspace);

    const { error: saveError } = await db.from("terminal_user_preferences").upsert(
      {
        user_id: user.id,
        layout: withWorkspaceInLayout(existingLayout, next),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (saveError) {
      if (isMissingTable(saveError)) {
        return jsonFail(
          "TERMINAL_STORAGE_UNAVAILABLE",
          "Terminal settings cannot be saved on this deployment yet.",
          503,
        );
      }
      throw new Error(saveError.message);
    }

    return jsonOk({ workspace: next, persisted: true, storage: "ok" }, NO_STORE);
  } catch (error) {
    if (!(error instanceof Error && error.name === "AuthError")) {
      console.error("[terminal] workspace save failed:", error instanceof Error ? error.message : "unknown error");
    }
    return handleAuthError(error);
  }
}
