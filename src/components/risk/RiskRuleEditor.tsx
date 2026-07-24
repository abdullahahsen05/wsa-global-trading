import type { RiskRuleDto } from "@/lib/domain/types";

export function RiskRuleEditor({ rules }: { rules: RiskRuleDto[] }) {
  return (
    <div className="space-y-3">
      {rules.map((rule) => (
        <div key={rule.id} className="rounded-[4px] border border-line bg-background p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="font-medium text-foreground">{rule.name}</p>
              <p className="mt-1 text-xs text-muted">
                {rule.metric} threshold: {rule.threshold}
              </p>
            </div>
            <span className="rounded-[4px] border border-line px-2 py-1 text-xs text-muted">
              {rule.severity}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
