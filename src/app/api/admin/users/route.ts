import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { listUsers } from "@/lib/services/adminService";

const roles = new Set(["ALL", "TRADER", "PARTNER", "ADMIN", "SUPER_ADMIN"]);
const statuses = new Set(["ALL", "ACTIVE", "SUSPENDED", "PENDING"]);
const sorts = new Set(["NEWEST", "OLDEST", "NAME"]);

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const params = new URL(request.url).searchParams;
    const role = params.get("role") ?? "ALL";
    const status = params.get("status") ?? "ALL";
    const sort = params.get("sort") ?? "NEWEST";

    if (!roles.has(role) || !statuses.has(status) || !sorts.has(sort)) {
      return jsonFail("INVALID_QUERY", "One or more directory filters are invalid.", 400);
    }

    return jsonOk(await listUsers({
      page: Number(params.get("page") ?? 1),
      pageSize: Number(params.get("pageSize") ?? 25),
      search: params.get("search") ?? "",
      role: role as "ALL" | "TRADER" | "PARTNER" | "ADMIN" | "SUPER_ADMIN",
      status: status as "ALL" | "ACTIVE" | "SUSPENDED" | "PENDING",
      sort: sort as "NEWEST" | "OLDEST" | "NAME",
    }));
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
