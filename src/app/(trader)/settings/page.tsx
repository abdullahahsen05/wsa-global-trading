"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Panel, PrimaryButton, WorkspacePage } from "@/components/app/WorkspaceUI";
import { SelectField, TextField } from "@/components/app/FormFields";
import { PasskeySecurityPanel } from "@/components/auth/PasskeySecurityPanel";

type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [successMessage, setSuccessMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const { data: sessionUser } = useQuery<SessionUser>({
    queryKey: ["session"],
    queryFn: async () => {
      const res = await fetch("/api/auth/session");
      const json = await res.json();
      if (!json.ok) throw new Error("Failed to load session");
      return json.data;
    },
  });

  const mutation = useMutation({
    mutationFn: async (data: { fullName: string; timezone: string }) => {
      const res = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to save");
      return json.data;
    },
    onSuccess: () => {
      setSuccessMessage("Profile settings saved successfully.");
      setErrorMessage("");
      queryClient.invalidateQueries({ queryKey: ["session"] });
    },
    onError: (err: Error) => {
      setErrorMessage(err.message);
      setSuccessMessage("");
    },
  });

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    mutation.mutate({
      fullName: form.get("fullName") as string,
      timezone: form.get("timezone") as string,
    });
  };

  return (
    <WorkspacePage
      eyebrow="Settings"
      title="Profile settings"
      description="Manage your profile and regional preferences."
      action={
        <PrimaryButton type="submit" form="settings-form" disabled={mutation.isPending}>
          {mutation.isPending ? "Saving..." : "Save changes"}
        </PrimaryButton>
      }
    >
      {successMessage ? (
        <div className="mb-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
          {successMessage}
        </div>
      ) : null}
      {errorMessage ? (
        <div className="mb-5 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
          {errorMessage}
        </div>
      ) : null}
      <form id="settings-form" onSubmit={handleSave} className="grid gap-4 xl:grid-cols-2">
        <Panel>
          <h2 className="text-lg font-semibold text-foreground">Profile</h2>
          <div className="mt-5 grid gap-4">
            <TextField
              label="Display name"
              name="fullName"
              defaultValue={sessionUser?.name ?? ""}
              key={`name-${sessionUser?.id}`}
            />
            <TextField
              label="Email address"
              name="email"
              defaultValue={sessionUser?.email ?? ""}
              disabled
            />
            <SelectField label="Timezone" name="timezone" defaultValue="Asia/Karachi">
              <option value="Asia/Karachi">Asia/Karachi</option>
              <option value="Europe/London">Europe/London</option>
              <option value="America/New_York">America/New_York</option>
            </SelectField>
          </div>
          <div className="mt-4 rounded-[4px] border border-line bg-background px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Role</p>
            <p className="mt-1 text-sm font-semibold text-foreground">{sessionUser?.role ?? "—"}</p>
          </div>
        </Panel>
        <Panel>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-foreground">Broker access</h2>
          </div>
          <div className="mt-4 rounded-[4px] border border-line bg-background px-4 py-4 text-sm leading-6 text-muted">
            Broker credentials and connection checks are managed per trading account so their
            status is never confused with profile settings.
          </div>
          <div className="mt-5">
            <Link
              href="/accounts"
              className="inline-flex min-h-10 items-center justify-center rounded-[4px] bg-accent px-4 py-2 text-sm font-semibold text-background transition hover:brightness-110"
            >
              Manage trading accounts
            </Link>
          </div>
        </Panel>
      </form>
      <div className="mt-5">
        <PasskeySecurityPanel />
      </div>
    </WorkspacePage>
  );
}
