import type { RiskEventDto, RiskRuleDto } from "@/lib/domain/types";

export function RiskStatusPanel({
  events,
  rules,
}: {
  events: RiskEventDto[];
  rules: RiskRuleDto[];
}) {
  return (
    <div className="rounded-[4px] border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Risk monitor</h3>
        <span className="text-xs text-muted">{rules.filter((rule) => rule.enabled).length} rules</span>
      </div>
      <div className="mt-4 space-y-3">
        {events.length === 0 ? (
          <p className="text-sm text-muted">No active risk events.</p>
        ) : (
          events.map((event) => (
            <div key={event.id} className="rounded-[4px] border border-line bg-background p-3">
              <p className="text-sm font-medium text-accent-2">{event.ruleName}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{event.message}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
