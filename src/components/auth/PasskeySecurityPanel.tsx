"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key } from "lucide-react";
import { GhostButton, Panel, PrimaryButton } from "@/components/app/WorkspaceUI";
import { TextField } from "@/components/app/FormFields";
import type { PasskeyDto } from "@/lib/services/passkeyService";

async function readJson(response: Response) {
  const json = await response.json();
  if (!json.ok) throw new Error(json.error?.message ?? "Passkey request failed");
  return json.data;
}

export function PasskeySecurityPanel() {
  const queryClient = useQueryClient();
  const [deviceName, setDeviceName] = useState("This device");
  const [message, setMessage] = useState<string | null>(null);
  const supported = typeof window !== "undefined" && "PublicKeyCredential" in window;
  const { data: passkeys = [] } = useQuery<PasskeyDto[]>({
    queryKey: ["my-passkeys"],
    queryFn: async () => readJson(await fetch("/api/auth/passkeys")),
  });

  const register = useMutation({
    mutationFn: async () => {
      if (!supported) throw new Error("This browser does not support passkeys.");
      const start = await readJson(await fetch("/api/auth/passkeys/register/options", { method: "POST" }));
      const response = await startRegistration({ optionsJSON: start.options });
      return readJson(await fetch("/api/auth/passkeys/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId: start.challengeId, response, deviceName }),
      }));
    },
    onSuccess: () => {
      setMessage("Passkey registered. You can now use it from the sign-in page.");
      queryClient.invalidateQueries({ queryKey: ["my-passkeys"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => readJson(await fetch("/api/auth/passkeys", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })),
    onSuccess: () => {
      setMessage("Passkey revoked.");
      queryClient.invalidateQueries({ queryKey: ["my-passkeys"] });
    },
    onError: (error: Error) => setMessage(error.message),
  });

  return (
    <Panel>
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[4px] bg-accent/15"><Key className="h-5 w-5 text-accent" /></div>
        <div>
          <h2 className="text-lg font-semibold text-foreground">Passkeys</h2>
          <p className="mt-1 text-sm text-muted">Use your device unlock, fingerprint, face, or security key to sign in. Password login remains available.</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1"><TextField label="Device name" maxLength={80} value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></div>
        <PrimaryButton type="button" disabled={!supported || register.isPending || !deviceName.trim()} onClick={() => register.mutate()}>
          {register.isPending ? "Waiting for device..." : "Register passkey"}
        </PrimaryButton>
      </div>
      {!supported ? <p className="mt-3 text-sm text-danger">Passkeys are not supported by this browser.</p> : null}
      {message ? <p className="mt-3 text-sm text-muted">{message}</p> : null}
      <div className="mt-5 space-y-2">
        {passkeys.length === 0 ? (
          <p className="rounded-[4px] border border-line bg-background px-4 py-4 text-sm text-muted">No passkey registered yet.</p>
        ) : passkeys.map((passkey) => (
          <div key={passkey.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[4px] border border-line bg-background px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">{passkey.deviceName}</p>
              <p className="mt-1 text-xs text-muted">Added {new Date(passkey.createdAt).toLocaleDateString()} · {passkey.lastUsedAt ? `Last used ${new Date(passkey.lastUsedAt).toLocaleString()}` : "Never used"}</p>
            </div>
            <GhostButton type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(passkey.id)}>Revoke</GhostButton>
          </div>
        ))}
      </div>
    </Panel>
  );
}
