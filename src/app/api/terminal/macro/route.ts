import { requireAuth } from "@/lib/auth/session";
import { jsonOk, handleAuthError } from "@/lib/api/envelope";
import { listUpcomingEvents } from "@/lib/services/economicCalendarService";
import type { MacroEvent } from "@/lib/terminal/types";

export async function GET() {
  try {
    await requireAuth();

    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 3);

    const data = await listUpcomingEvents({
      currencies: ["USD", "EUR", "GBP", "JPY", "CAD", "CHF", "AUD", "NZD"],
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      impacts: ["MEDIUM", "HIGH"],
      limit: 20,
    });

    const events: MacroEvent[] = data.map((row) => ({
      id: row.id,
      title: row.title,
      currency: row.currency,
      impact: row.impact,
      eventTime: row.eventTime,
      actual: row.actual,
      forecast: row.forecast,
      previous: row.previous,
    }));

    return jsonOk(events);
  } catch (err) {
    return handleAuthError(err);
  }
}
