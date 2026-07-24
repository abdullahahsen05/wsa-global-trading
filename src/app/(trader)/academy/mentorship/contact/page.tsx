"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MessageSquare, Users } from "lucide-react";
import { Panel, PrimaryButton, StatusPill, WorkspacePage } from "@/components/app/WorkspaceUI";
import { TextAreaField, TextField } from "@/components/app/FormFields";

type SessionUser = { id: string; name: string; email: string };

export default function MentorshipContactPage() {
  const [form, setForm] = useState({ name: "", email: "", subject: "1-to-1 Trading Mentorship", message: "" });
  const [success, setSuccess] = useState(false);
  const { data: user } = useQuery<SessionUser>({
    queryKey: ["session"],
    queryFn: async () => {
      const response = await fetch("/api/auth/session");
      const json = await response.json();
      if (!json.ok) throw new Error("Failed to load profile");
      return json.data;
    },
  });

  const submit = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/contact-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          name: form.name || user?.name || "",
          email: form.email || user?.email || "",
          type: "MENTORSHIP",
        }),
      });
      const json = await response.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Failed to send request");
      return json.data;
    },
    onSuccess: () => setSuccess(true),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSuccess(false);
    submit.mutate();
  }

  return (
    <WorkspacePage
      eyebrow="Academy · Private mentorship"
      title="Talk to the mentorship team"
      description="Tell us what you want to improve and the WSA Global team will follow up about the 1-to-1 programme."
      action={<Link href="/academy" className="btn-dark">Back to Academy</Link>}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)]">
        <Panel>
          <div className="grid h-12 w-12 place-items-center rounded-[4px] bg-accent/15"><Users className="h-6 w-6 text-accent" /></div>
          <StatusPill tone="accent">EUR 2,500 · one-time</StatusPill>
          <h2 className="mt-4 text-xl font-semibold text-foreground">1-to-1 Trading Mentorship</h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            Private guidance with a professional trader, focused on trading process, risk management, and market review around your goals.
          </p>
          <div className="mt-5 space-y-3 text-sm text-foreground/80">
            <p>• A member of the team reviews every request.</p>
            <p>• Contacting us does not create a charge or grant access.</p>
            <p>• The existing Academy payment option remains available separately.</p>
          </div>
        </Panel>

        <Panel>
          <div className="flex items-center gap-3">
            <MessageSquare className="h-5 w-5 text-accent" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">Request a consultation</h2>
              <p className="text-sm text-muted">We will reply using the email address below.</p>
            </div>
          </div>
          {success ? (
            <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-4 text-sm text-accent">
              Your mentorship request has been sent. The WSA Global team can now review it from the admin console.
            </div>
          ) : null}
          {submit.error ? (
            <div className="mt-5 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-4 text-sm text-danger">{submit.error.message}</div>
          ) : null}
          <form onSubmit={handleSubmit} className="mt-5 grid gap-4 sm:grid-cols-2">
            <TextField label="Name" required value={form.name || user?.name || ""} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            <TextField label="Email" type="email" required value={form.email || user?.email || ""} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
            <div className="sm:col-span-2">
              <TextField label="Subject" required value={form.subject} onChange={(event) => setForm((current) => ({ ...current, subject: event.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <TextAreaField label="What would you like help with?" required minLength={20} rows={7} value={form.message} onChange={(event) => setForm((current) => ({ ...current, message: event.target.value }))} />
            </div>
            <div className="sm:col-span-2 flex justify-end">
              <PrimaryButton type="submit" disabled={submit.isPending}>{submit.isPending ? "Sending..." : "Send mentorship request"}</PrimaryButton>
            </div>
          </form>
        </Panel>
      </div>
    </WorkspacePage>
  );
}
