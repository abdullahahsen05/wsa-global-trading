"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, Key } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { BrandLogo } from "@/components/app/BrandLogo";
import { TextField } from "@/components/app/FormFields";
import { createClient } from "@/lib/supabase/client";
import { parseUserRole, type UserRole } from "@/lib/auth/rbac";
import { roleHome } from "@/lib/auth/routeAccess";

export default function LoginPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const router = useRouter();
  const queryClient = useQueryClient();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("");
    setError("");

    const formData = new FormData(event.currentTarget);
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setIsSubmitting(false);
      setError(authError.message);
      return;
    }

    // Fetch profile to determine role
    const {
      data: { user },
    } = await supabase.auth.getUser();

    let role: UserRole | null = null;

    if (user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

      role = parseUserRole(profile?.role);
    }

    if (!role) {
      await supabase.auth.signOut();
      setIsSubmitting(false);
      setError(
        "Your account profile is incomplete. Contact support before signing in.",
      );
      return;
    }

    setMessage("Signed in successfully. Redirecting...");
    queryClient.clear();
    router.replace(roleHome(role));
    router.refresh();
  };

  const handlePasskeySignIn = async () => {
    setIsSubmitting(true);
    setMessage("");
    setError("");

    try {
      const optionsResponse = await fetch(
        "/api/auth/passkeys/login/options",
        { method: "POST" },
      );
      const optionsJson = await optionsResponse.json();

      if (!optionsJson.ok) {
        throw new Error(
          optionsJson.error?.message ?? "Passkey sign-in is unavailable",
        );
      }

      const response = await startAuthentication({
        optionsJSON: optionsJson.data.options,
      });

      const verifyResponse = await fetch(
        "/api/auth/passkeys/login/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            challengeId: optionsJson.data.challengeId,
            response,
          }),
        },
      );

      const verifyJson = await verifyResponse.json();

      if (!verifyJson.ok) {
        throw new Error(
          verifyJson.error?.message ?? "Passkey sign-in failed",
        );
      }

      setMessage("Signed in with passkey. Redirecting...");
      queryClient.clear();
      router.replace(verifyJson.data.redirectTo ?? "/dashboard");
      router.refresh();
    } catch (passkeyError) {
      setError(
        passkeyError instanceof Error
          ? passkeyError.message
          : "Passkey sign-in failed",
      );
      setIsSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <div className="grid min-h-screen md:grid-cols-[50%_50%]">
        <aside className="relative hidden min-h-screen overflow-hidden border-r border-line bg-[#060808] md:flex md:flex-col">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.038)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:112px_112px] opacity-75" />

            <div className="absolute inset-x-0 top-0 h-[28%] bg-[linear-gradient(to_bottom,rgba(5,7,7,0.2),rgba(5,7,7,0.88))]" />
            <div className="absolute inset-x-0 bottom-0 h-[28%] bg-[linear-gradient(to_top,rgba(5,7,7,0.4),transparent)]" />

            <svg
              aria-hidden="true"
              viewBox="0 0 760 500"
              fill="none"
              className="absolute left-[5%] top-[14%] h-[50%] w-[90%] text-white/[0.07]"
            >
              <path
                d="M58 330h182l68 44h250l116 64"
                stroke="currentColor"
                strokeWidth="1"
              />
              <path
                d="M248 90h212l86 44h148"
                stroke="currentColor"
                strokeWidth="1"
              />
              <path
                d="M86 392l140-70h224l94-70h136"
                stroke="rgba(255,204,0,0.16)"
                strokeWidth="1"
              />

              <path
                d="M226 136 352 78l210 102-126 60-210-104Z"
                stroke="currentColor"
              />
              <path
                d="m226 136 210 104v92L226 228v-92Z"
                stroke="currentColor"
              />
              <path
                d="m436 240 126-60v92l-126 60v-92Z"
                stroke="currentColor"
              />

              <rect
                x="324"
                y="98"
                width="210"
                height="128"
                rx="6"
                stroke="currentColor"
              />
              <rect
                x="392"
                y="246"
                width="246"
                height="110"
                rx="6"
                stroke="currentColor"
              />

              <path
                d="m346 178 32-20 28 14 24-30 28 20 52-54"
                stroke="rgba(255,204,0,0.5)"
                strokeWidth="2"
              />
              <path
                d="M420 280h158M420 308h104M420 336h132"
                stroke="currentColor"
              />

              <circle
                cx="660"
                cy="136"
                r="4"
                fill="rgba(255,204,0,0.44)"
              />
            </svg>
          </div>

          <header className="relative z-10 px-8 pt-8 lg:px-12 lg:pt-10 xl:px-[60px] xl:pt-[44px]">
            <Link href="/" className="block w-fit">
              <BrandLogo className="h-14 w-auto max-w-[190px]" priority />
            </Link>
          </header>

          <div className="relative z-10 mt-auto px-8 pb-[64px] lg:px-12 xl:px-[60px] xl:pb-[66px]">
            <div className="max-w-[590px]">
              <h1 className="text-[38px] font-medium leading-[1.08] tracking-[-0.034em] text-foreground lg:text-[46px] xl:text-[51px]">
                Operate with{" "}
                <span className="text-accent">clarity.</span>
                <br />
                Scale with control.
              </h1>

              <div className="mt-[30px] h-px w-10 bg-accent" />

              <p className="mt-5 max-w-[500px] text-[15px] leading-[1.75] text-muted">
                Review accounts, monitor trades, manage CRM and risk,
                <br className="hidden xl:block" />
                and run admin operations&mdash;on one secure platform.
              </p>

              <Link
                href="/demo"
                className="mt-9 grid max-w-[540px] grid-cols-[48px_1fr_auto] items-center gap-4 border border-line bg-[#090b0b]/75 px-5 py-5 transition-colors hover:border-white/20 hover:bg-[#0c0e0e] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              >
                <span className="grid h-11 w-11 place-items-center rounded-[6px] border border-accent/45 text-accent">
                  <Eye className="h-[19px] w-[19px]" />
                </span>

                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold text-foreground">
                    Explore the platform first
                  </span>
                  <span className="mt-1.5 block max-w-[355px] text-[13px] leading-[1.65] text-muted">
                    Open the public demo workspace with sample data only. No
                    broker sync, real trading, or paid access is triggered.
                  </span>
                </span>

                <span className="self-end whitespace-nowrap pb-0.5 text-[13px] font-semibold text-accent">
                  View Demo <span aria-hidden="true">-&gt;</span>
                </span>
              </Link>
            </div>
          </div>

          <footer className="relative z-10 flex items-center justify-between px-8 pb-7 text-[13px] text-muted/80 lg:px-12 xl:px-[60px]">
            <span>&copy; 2024 WSA Global. All rights reserved.</span>

            <span className="flex items-center gap-5">
              <Link
                href="/security"
                className="transition-colors hover:text-foreground"
              >
                Security
              </Link>
              <span className="h-4 w-px bg-line" />
              <Link
                href="/privacy"
                className="transition-colors hover:text-foreground"
              >
                Privacy
              </Link>
            </span>
          </footer>
        </aside>

        <section className="flex min-h-screen items-start justify-center bg-[#060808] px-5 py-7 sm:px-8 md:items-center md:px-10 md:py-10 lg:px-14 xl:px-[72px]">
          <div className="w-full max-w-[560px] md:-translate-y-[22px]">
            <BrandLogo className="mb-10 h-14 w-auto max-w-[190px] md:hidden" priority />

            <p className="text-[12px] font-bold uppercase tracking-[0.3em] text-accent">
              Welcome back
            </p>

            <h2 className="mt-5 text-[36px] font-medium leading-[1.1] tracking-[-0.034em] text-foreground sm:text-[40px] lg:text-[42px]">
              Sign in to your account
            </h2>

            <div className="mt-7 h-px w-full bg-line" />

            {(message || error) && (
              <div className="mt-7 space-y-3">
                {message ? (
                  <div className="border border-accent/25 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
                    {message}
                  </div>
                ) : null}

                {error ? (
                  <div className="border border-danger/25 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
                    {error}
                  </div>
                ) : null}
              </div>
            )}

            <form
              className="mt-8 grid gap-[24px]"
              method="post"
              onSubmit={handleSubmit}
            >
              <TextField
                label="Email"
                name="email"
                type="email"
                className="!h-[58px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c] !px-5 !text-[15px] !text-foreground"
              />

              <div className="relative">
                <TextField
                  label="Password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  className="!h-[58px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c] !px-5 !pr-12 !text-[15px] !text-foreground"
                />

                <button
                  type="button"
                  aria-label={
                    showPassword ? "Hide password" : "Show password"
                  }
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute bottom-[18px] right-4 text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
                >
                  <Eye className="h-[19px] w-[19px]" />
                </button>
              </div>

              <div className="-mt-[9px] flex justify-end">
                <Link
                  href="/forgot-password"
                  className="text-[13px] font-semibold text-accent transition-colors hover:text-foreground"
                >
                  Forgot password?
                </Link>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="relative flex h-[54px] w-full items-center justify-center rounded-[6px] border border-accent bg-accent px-6 text-[14px] font-bold text-background transition-colors hover:bg-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span>{isSubmitting ? "Signing in..." : "Sign in"}</span>
                <span
                  className="absolute right-5 text-[21px] leading-none"
                  aria-hidden="true"
                >
                  &rarr;
                </span>
              </button>
            </form>

            <div className="my-7 flex items-center gap-5 text-[11px] font-semibold uppercase tracking-[0.17em] text-muted">
              <span className="h-px flex-1 bg-line" />
              OR
              <span className="h-px flex-1 bg-line" />
            </div>

            <button
              type="button"
              disabled={isSubmitting}
              onClick={handlePasskeySignIn}
              className="flex h-[56px] w-full items-center justify-center gap-3 rounded-[6px] border border-white/15 bg-[#0a0c0c] px-6 text-[14px] font-semibold text-foreground transition-colors hover:border-accent/40 hover:bg-[#0d1010] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Key className="h-[19px] w-[19px]" />
              Sign in with passkey
            </button>

            <p className="mt-8 text-[13px] text-muted">
              New trader?{" "}
              <Link
                href="/register"
                className="font-semibold text-accent transition-colors hover:text-foreground"
              >
                Create account <span aria-hidden="true">-&gt;</span>
              </Link>
            </p>

            <Link
              href="/demo"
              className="mt-8 flex items-center justify-between border border-line bg-[#090b0b] p-4 text-sm font-semibold text-foreground transition-colors hover:border-white/20 hover:bg-[#0d1010] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent md:hidden"
            >
              <span>Explore the platform first</span>
              <span className="text-accent" aria-hidden="true">
                -&gt;
              </span>
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
