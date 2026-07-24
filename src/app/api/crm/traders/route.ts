import { jsonFail, jsonOk } from "@/lib/api/envelope";
import { requireAdmin, AuthError } from "@/lib/auth/session";
import { listTraderCrmDirectory, listTraderProfiles } from "@/lib/services/crmService";

const segments = new Set(["ALL", "EVALUATION", "FUNDED", "AT_RISK", "VIP"]);
const statuses = new Set(["ALL", "ACTIVE", "SUSPENDED", "PENDING"]);
const sorts = new Set(["NEWEST", "OLDEST"]);

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const params = new URL(request.url).searchParams;
    if (params.get("view") === "directory") {
      const segment = params.get("segment") ?? "ALL";
      const profileStatus = params.get("status") ?? "ALL";
      const sort = params.get("sort") ?? "NEWEST";
      if (!segments.has(segment) || !statuses.has(profileStatus) || !sorts.has(sort)) {
        return jsonFail("INVALID_QUERY", "One or more CRM directory filters are invalid.", 400);
      }

      return jsonOk(await listTraderCrmDirectory({
        page: Number(params.get("page") ?? 1),
        pageSize: Number(params.get("pageSize") ?? 25),
        search: params.get("search") ?? "",
        segment: segment as "ALL" | "EVALUATION" | "FUNDED" | "AT_RISK" | "VIP",
        profileStatus: profileStatus as "ALL" | "ACTIVE" | "SUSPENDED" | "PENDING",
        partnerId: params.get("partnerId") || undefined,
        sort: sort as "NEWEST" | "OLDEST",
      }));
    }
    return jsonOk(await listTraderProfiles());
  } catch (err) {
    if (err instanceof AuthError) return jsonFail(err.code, err.message, err.statusCode);
    throw err;
  }
}
