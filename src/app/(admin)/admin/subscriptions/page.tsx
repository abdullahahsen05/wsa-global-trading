"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Plus, Search, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { DirectorySearchOverlay } from "@/components/app/DirectorySearchOverlay";
import {
  GhostButton,
  FilterChipRow,
  InlineStatusStrip,
  Panel,
  PageActionGroup,
  PrimaryButton,
  StatusPill,
  WorkspacePage,
} from "@/components/app/WorkspaceUI";
import { SelectField, TextField } from "@/components/app/FormFields";
import { useQuery } from "@tanstack/react-query";
import type { AdminSummaryDto, TraderProfileDto } from "@/lib/domain/types";

type SubscriptionRecord = {
  id: string;
  traderName: string;
  plan: string;
  price: string;
  status: "Active" | "Paused" | "Trial";
  billing: string;
};

export default function AdminSubscriptionsPage() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [selectedId, setSelectedId] = useState("sub-001");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "Active" | "Paused" | "Trial">("ALL");

  const { data: adminSummary } = useQuery<AdminSummaryDto>({
    queryKey: ["admin-summary"],
    queryFn: async () => {
      const res = await fetch("/api/admin/summary");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load admin summary");
      return json.data;
    },
  });

  const { data: traders = [] } = useQuery<TraderProfileDto[]>({
    queryKey: ["crm-traders"],
    queryFn: async () => {
      const res = await fetch("/api/crm/traders");
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load traders");
      return json.data;
    },
  });

  const plans: SubscriptionRecord[] = useMemo(
    () =>
      traders.map((trader, index) => ({
        id: `sub-${index + 1}`,
        traderName: trader.name,
        plan: trader.segment === "FUNDED" ? "Funded Pro" : "Evaluation",
        price: trader.segment === "FUNDED" ? "$199/mo" : "$99/mo",
        status: "Active" as const,
        billing: "Manual invoice",
      })),
    [traders],
  );

  const filteredPlans = plans.filter((plan) => statusFilter === "ALL" || plan.status === statusFilter);
  const selectedPlan = filteredPlans.find((plan) => plan.id === selectedId) ?? filteredPlans[0] ?? plans[0];

  const handleCreatePlan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setSuccessMessage("");

    window.setTimeout(() => {
      setIsSaving(false);
      setOpen(false);
      setSuccessMessage("Subscription plan created in mock billing mode.");
    }, 900);
  };

  return (
    <WorkspacePage
      eyebrow="Admin"
      title="Subscriptions"
      description="Minimal billing directory for plans, entitlement state, and renewal readiness."
      action={
        <PageActionGroup>
          <GhostButton type="button" onClick={() => setSearchOpen(true)}>
            <Search className="mr-2 inline-block h-4 w-4" />
            Search
          </GhostButton>
          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger asChild>
              <PrimaryButton type="button">
                <Plus className="mr-2 inline-block h-4 w-4" />
                Create plan
              </PrimaryButton>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-40 bg-black/75" />
              <Dialog.Content className="max-h-[90vh] invisible-scrollbar overflow-y-auto fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-[6px] border border-line bg-panel p-6 shadow-[0_20px_60px_rgba(0,0,0,0.48)] focus:outline-none">
                <Dialog.Title className="text-xl font-semibold text-foreground">Create plan</Dialog.Title>
                <Dialog.Description className="mt-2 text-sm leading-6 text-muted">
                  Prepare a plan template with pricing and invoice settings for the billing queue.
                </Dialog.Description>
                <form className="mt-6 grid gap-4" onSubmit={handleCreatePlan}>
                  <TextField label="Plan name" defaultValue="Funded Pro" />
                  <div className="grid gap-4 md:grid-cols-2">
                    <SelectField label="Billing cycle" defaultValue="Monthly">
                      <option>Monthly</option>
                      <option>Quarterly</option>
                      <option>Yearly</option>
                    </SelectField>
                    <TextField label="Price" defaultValue="$199/mo" />
                    <SelectField label="Invoice type" defaultValue="Manual invoice">
                      <option>Manual invoice</option>
                      <option>Auto invoice</option>
                    </SelectField>
                    <SelectField label="Entitlement" defaultValue="Active">
                      <option>Active</option>
                      <option>Paused</option>
                      <option>Trial</option>
                    </SelectField>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                    <p className="text-sm text-muted">Plans are saved to the mock billing layer for now.</p>
                    <div className="flex gap-3">
                      <Dialog.Close asChild>
                        <GhostButton type="button">Cancel</GhostButton>
                      </Dialog.Close>
                      <PrimaryButton type="submit" disabled={isSaving}>
                        {isSaving ? "Saving..." : "Create plan"}
                      </PrimaryButton>
                    </div>
                  </div>
                </form>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close dialog"
                    className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-line bg-background text-muted"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </PageActionGroup>
      }
    >
      <InlineStatusStrip
        items={[
          {
            label: "MRR",
            value: `$${(adminSummary?.monthlyRecurringRevenue?.amount ?? 0).toLocaleString()}`,
            tone: "lime",
          },
          { label: "Active plans", value: plans.length },
          { label: "Payment provider", value: "Pending", helper: "Future integration", tone: "accent" },
        ]}
      />

      <div className="mt-5 rounded-[4px] border border-line bg-panel p-4">
        <FilterChipRow
          chips={[
            {
              label: `All plans (${plans.length})`,
              active: statusFilter === "ALL",
              onClick: () => {
                setStatusFilter("ALL");
                setSelectedId(plans[0]?.id ?? "");
              },
            },
            {
              label: `Active (${plans.filter((plan) => plan.status === "Active").length})`,
              active: statusFilter === "Active",
              onClick: () => {
                setStatusFilter("Active");
                setSelectedId(plans.find((plan) => plan.status === "Active")?.id ?? plans[0]?.id ?? "");
              },
            },
            {
              label: `Paused (${plans.filter((plan) => plan.status === "Paused").length})`,
              active: statusFilter === "Paused",
              onClick: () => {
                setStatusFilter("Paused");
                setSelectedId(plans.find((plan) => plan.status === "Paused")?.id ?? plans[0]?.id ?? "");
              },
            },
            {
              label: `Trial (${plans.filter((plan) => plan.status === "Trial").length})`,
              active: statusFilter === "Trial",
              onClick: () => {
                setStatusFilter("Trial");
                setSelectedId(plans.find((plan) => plan.status === "Trial")?.id ?? plans[0]?.id ?? "");
              },
            },
          ]}
        />
      </div>

      {successMessage ? (
        <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
          {successMessage}
        </div>
      ) : null}

      <div className="mt-5">
        {selectedPlan ? (
          <Panel className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Selected plan</p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">{selectedPlan.traderName}</h2>
                <p className="mt-1 text-sm text-muted">
                  {selectedPlan.plan} - {selectedPlan.price}
                </p>
              </div>
              <StatusPill tone="lime">{selectedPlan.status}</StatusPill>
            </div>

            <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Billing cycle</p>
                <p className="mt-1 text-sm font-semibold text-foreground">Monthly</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Price</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{selectedPlan.price}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Billing</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{selectedPlan.billing}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Entitlement</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{selectedPlan.status}</p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <GhostButton type="button">Open billing</GhostButton>
            </div>
          </Panel>
        ) : (
          <Panel className="min-w-0">
            <p className="text-sm text-muted">No subscription plans yet. Create one above.</p>
          </Panel>
        )}
      </div>

      <DirectorySearchOverlay<SubscriptionRecord>
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search subscriptions"
        description="Plan search and paging are moved into the overlay so the page remains minimal."
        items={plans}
        selectedId={selectedPlan?.id ?? ""}
        onSelect={(id) => {
          setSelectedId(id);
          setSearchOpen(false);
        }}
        searchLabel="Search plans"
        searchPlaceholder="Search trader or plan"
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "ALL", label: "All statuses" },
              { value: "Active", label: "Active" },
              { value: "Paused", label: "Paused" },
              { value: "Trial", label: "Trial" },
            ],
          },
        ]}
        emptyTitle="No plans match"
        emptyDescription="Try another search term or status filter."
        getId={(plan) => plan.id}
        matches={(plan, state) => {
          const search = state.query.trim().toLowerCase();
          const matchesQuery =
            search.length === 0 ||
            plan.traderName.toLowerCase().includes(search) ||
            plan.plan.toLowerCase().includes(search);
          const matchesStatus = state.filters.status === "ALL" || plan.status === state.filters.status;
          return matchesQuery && matchesStatus;
        }}
        renderRow={(plan) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">{plan.traderName}</p>
                <p className="mt-1 truncate text-xs text-muted">{plan.plan}</p>
              </div>
              <StatusPill tone="lime">{plan.status}</StatusPill>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {plan.price}
              </span>
              <span className="rounded-[4px] border border-line bg-panel px-3 py-1 text-xs font-semibold text-muted">
                {plan.billing}
              </span>
            </div>
          </>
        )}
        renderPreview={(plan) => (
          <Panel className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">Plan preview</p>
                <h3 className="mt-2 text-lg font-semibold text-foreground">{plan.traderName}</h3>
                <p className="mt-1 text-sm text-muted">
                  {plan.plan} - {plan.price}
                </p>
              </div>
              <StatusPill tone="lime">{plan.status}</StatusPill>
            </div>
            <div className="definition-grid mt-4 grid gap-0 sm:grid-cols-2">
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Price</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{plan.price}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Billing</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{plan.billing}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Status</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{plan.status}</p>
              </div>
              <div className="rounded-[4px] border border-line bg-background px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Provider</p>
                <p className="mt-1 text-sm font-semibold text-foreground">Pending integration</p>
              </div>
            </div>
          </Panel>
        )}
      />
    </WorkspacePage>
  );
}
