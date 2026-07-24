import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { deleteCopyStrategy, updateCopyStrategy } from "@/lib/services/copyTradingService";
import { copyStrategyUpdateSchema } from "@/lib/validation/schemas";
import { CopyError } from "@/lib/copy/types";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = copyStrategyUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonFail("VALIDATION_ERROR", parsed.error.issues.map((i) => i.message).join(", "), 400);
    }
    return jsonOk(await updateCopyStrategy(id, parsed.data, admin.id));
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof CopyError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    return jsonOk(await deleteCopyStrategy(id, admin.id));
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    if (err instanceof CopyError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
