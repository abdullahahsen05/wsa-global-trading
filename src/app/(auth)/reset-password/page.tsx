"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Key, ShieldCheck } from "lucide-react";
import { BrandLogo } from "@/components/app/BrandLogo";
import { PrimaryButton } from "@/components/app/WorkspaceUI";
import { TextField } from "@/components/app/FormFields";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("");
    setError("");

    const formData = new FormData(event.currentTarget);
    const newPassword = formData.get("newPassword") as string;
    const confirmPassword = formData.get("confirmPassword") as string;

    if (newPassword !== confirmPassword) {
      setIsSubmitting(false);
      setError("Passwords do not match.");
      return;
    }

    const supabase = createClient();
    const { error: authError } = await supabase.auth.updateUser({ password: newPassword });

    setIsSubmitting(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    setMessage("Password updated. Redirecting to login...");
    router.push("/login");
  };

  return (
    <main className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <div className="grid min-h-screen md:grid-cols-2">
        <aside className="relative hidden min-h-screen overflow-hidden border-r border-line bg-[#060808] px-10 py-8 md:flex md:flex-col lg:px-14">
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.038)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:112px_112px] opacity-75" />
          <Link href="/" className="relative z-10 block w-fit">
            <BrandLogo className="h-14 w-auto max-w-[190px]" priority />
          </Link>
          <div className="relative z-10 my-auto max-w-lg">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Account security</p>
            <h2 className="mt-5 text-[34px] font-semibold leading-tight">Secure access. Clear recovery.</h2>
            <p className="mt-4 max-w-md text-sm leading-6 text-muted">
              Set a new workspace password from your verified recovery link. Reset links remain single-use and expire automatically.
            </p>
            <div className="mt-8 grid grid-cols-[44px_1fr] items-start gap-4 border-t border-line pt-5">
              <span className="grid h-11 w-11 place-items-center rounded-[6px] border border-accent/40 text-accent">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold">Protected account recovery</p>
                <p className="mt-1 text-xs leading-5 text-muted">Your new password is submitted directly through the existing secure authentication flow.</p>
              </div>
            </div>
          </div>
          <p className="relative z-10 text-xs text-muted">WSA Global secure workspace</p>
        </aside>

        <section className="flex min-h-screen items-start justify-center bg-[#060808] px-5 py-7 sm:px-8 md:items-center md:px-10 md:py-10 lg:px-14 xl:px-[72px]">
          <div className="w-full max-w-xl">
            <BrandLogo className="mb-10 h-14 w-auto max-w-[190px] md:hidden" priority />
            <Link href="/login" className="mb-6 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted transition-colors hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              Back to login
            </Link>
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 place-items-center rounded-[6px] border border-accent/35 bg-accent/5 text-accent">
                <Key className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">Reset password</p>
                <h1 className="mt-1 text-3xl font-semibold text-foreground">Create a new password</h1>
              </div>
            </div>
            <p className="mt-4 max-w-lg text-sm leading-6 text-muted">
              Use the reset link from your email to set a new password for your trading workspace.
            </p>

            {message ? (
              <div className="mt-5 rounded-[4px] border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
                {message}
              </div>
            ) : null}

            {error ? (
              <div className="mt-5 rounded-[4px] border border-danger/20 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
                {error}
              </div>
            ) : null}

            <form className="mt-7 grid gap-5" onSubmit={handleSubmit}>
              <TextField label="New password" name="newPassword" type="password" placeholder="New password" className="!h-[56px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c]" />
              <TextField label="Confirm password" name="confirmPassword" type="password" placeholder="Confirm password" className="!h-[56px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c]" />
              <PrimaryButton type="submit" disabled={isSubmitting} className="!h-[54px] !rounded-[6px] !text-sm !font-bold">
                {isSubmitting ? "Updating..." : "Update password"}
              </PrimaryButton>
            </form>

            <p className="mt-6 flex items-center gap-2 border-t border-line pt-5 text-xs text-muted">
              <ShieldCheck className="h-4 w-4 text-accent-2" />
              Reset links are single-use and expire automatically.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
