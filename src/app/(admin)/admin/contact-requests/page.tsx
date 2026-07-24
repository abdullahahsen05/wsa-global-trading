"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DataTable, EmptyState, InlineStatusStrip, Panel, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import type { ContactRequestDto, ContactRequestStatus } from "@/lib/services/contactRequestService";

export default function AdminContactRequestsPage() {
  const queryClient = useQueryClient();
  const { data: requests = [], isLoading } = useQuery<ContactRequestDto[]>({
    queryKey: ["admin-contact-requests"],
    queryFn: async () => {
      const response = await fetch("/api/admin/contact-requests");
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to load requests");
      return json.data;
    },
  });
  const update = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ContactRequestStatus }) => {
      const response = await fetch(`/api/admin/contact-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to update request");
      return json.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-contact-requests"] }),
  });

  return (
    <WorkspacePage eyebrow="Admin" title="Contact requests" description="Review mentorship enquiries submitted by authenticated traders.">
      <InlineStatusStrip items={[
        { label: "Total requests", value: requests.length },
        { label: "New", value: requests.filter((request) => request.status === "NEW").length, tone: "accent" },
        { label: "Resolved", value: requests.filter((request) => request.status === "RESOLVED").length, tone: "lime" },
      ]} />
      <Panel className="mt-5">
        {isLoading ? <div className="h-36 animate-pulse rounded-[4px] bg-background" /> : requests.length === 0 ? (
          <EmptyState title="No contact requests" description="New mentorship and general enquiries will appear here." />
        ) : (
          <DataTable
            headers={["Trader", "Request", "Message", "Submitted", "Status"]}
            rows={requests.map((request) => [
              <div key="trader"><p className="font-semibold text-foreground">{request.name}</p><p className="text-xs text-muted">{request.email}</p></div>,
              <div key="subject"><StatusPill tone="accent">{request.type}</StatusPill><p className="mt-2 font-semibold text-foreground">{request.subject}</p></div>,
              <p key="message" className="max-w-sm whitespace-pre-wrap text-sm text-muted">{request.message}</p>,
              <span key="date">{new Date(request.createdAt).toLocaleString()}</span>,
              <select
                key="status"
                value={request.status}
                disabled={update.isPending}
                onChange={(event) => update.mutate({ id: request.id, status: event.target.value as ContactRequestStatus })}
                className="h-10 rounded-[4px] border border-line bg-background px-3 text-sm font-semibold text-foreground"
              >
                <option value="NEW">New</option><option value="IN_PROGRESS">In progress</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option>
              </select>,
            ])}
          />
        )}
      </Panel>
    </WorkspacePage>
  );
}
