"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, BriefcaseBusiness, TrendingUp } from "lucide-react";
import { BrandLogo } from "@/components/app/BrandLogo";
import { PrimaryButton } from "@/components/app/WorkspaceUI";
import { TextField } from "@/components/app/FormFields";
import { createClient } from "@/lib/supabase/client";
import { BRAND_NAME } from "@/lib/brand";

type Role = "TRADER" | "PARTNER";

const ROLE_OPTIONS: {
  role: Role;
  eyebrow: string;
  title: string;
  description: string;
}[] = [
  {
    role: "TRADER",
    eyebrow: "For traders",
    title: "I am a Trader",
    description:
      "Access the WSA Global trading platform, MT5 accounts, copy trading, AI assistant, bots, academy, and evaluations.",
  },
  {
    role: "PARTNER",
    eyebrow: "For affiliates",
    title: "I am a Partner / Affiliate",
    description:
      "Refer traders, track commissions, and manage payouts through the partner portal.",
  },
];

export default function RegisterPage() {
  const [step, setStep] = useState<1 | 2>(1);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [referralCode, setReferralCode] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (
          new URLSearchParams(window.location.search).get("ref") ??
          new URLSearchParams(window.location.search).get("partner") ??
          ""
        )
          .trim()
          .toUpperCase(),
  );
  const router = useRouter();

  const handleRoleSelect = (role: Role) => {
    setSelectedRole(role);
    setStep(2);
  };

  const handleBack = () => {
    setStep(1);
    setError("");
    setMessage("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedRole) return;

    setIsSubmitting(true);
    setMessage("");
    setError("");

    const formData = new FormData(event.currentTarget);
    const fullName = formData.get("fullName") as string;
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    const confirmPassword = formData.get("confirmPassword") as string;

    if (password !== confirmPassword) {
      setIsSubmitting(false);
      setError("Passwords do not match.");
      return;
    }

    const normalizedReferralCode = referralCode.trim().toUpperCase();

    if (selectedRole === "TRADER" && normalizedReferralCode) {
      const validationResponse = await fetch(
        `/api/auth/referral/validate?code=${encodeURIComponent(
          normalizedReferralCode,
        )}`,
      );
      const validationJson = await validationResponse.json();

      if (!validationJson.ok) {
        setIsSubmitting(false);
        setError(
          validationJson.error?.message ??
            "This referral code is invalid or inactive.",
        );
        return;
      }
    }

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // role is read by the handle_new_user() DB trigger.
        // ADMIN is never accepted — the trigger enforces TRADER as the fallback.
        data: {
          full_name: fullName,
          role: selectedRole,
          ...(selectedRole === "TRADER" && normalizedReferralCode
            ? { referral_code: normalizedReferralCode }
            : {}),
        },
      },
    });

    if (authError) {
      setIsSubmitting(false);
      setError(authError.message);
      return;
    }

    const redirect =
      selectedRole === "PARTNER" ? "/partner" : "/platform-preview";

    setMessage("Account created. Redirecting...");
    router.push(redirect);
  };

  const brandHeader = (
    <Link href="/" className="block w-fit">
      <BrandLogo className="h-14 w-auto max-w-[190px]" priority />
    </Link>
  );

  const brandPanel = (
    <aside className="relative hidden min-h-screen overflow-hidden border-r border-line bg-[#060808] md:flex md:flex-col">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.038)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:112px_112px] opacity-75" />

        <div className="absolute inset-x-0 top-0 h-[28%] bg-[linear-gradient(to_bottom,rgba(5,7,7,0.2),rgba(5,7,7,0.88))]" />
        <div className="absolute inset-x-0 bottom-0 h-[28%] bg-[linear-gradient(to_top,rgba(5,7,7,0.4),transparent)]" />

        <svg
          aria-hidden="true"
          viewBox="0 0 760 500"
          fill="none"
          className="absolute left-[5%] top-[13%] h-[51%] w-[90%] text-white/[0.07]"
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
        {brandHeader}
      </header>

      <div className="relative z-10 mt-auto px-8 pb-[68px] lg:px-12 xl:px-[60px]">
        <div className="max-w-[590px]">
          <p className="text-[12px] font-bold uppercase tracking-[0.3em] text-accent">
            Join WSA Global
          </p>

          <h1 className="mt-5 text-[38px] font-medium leading-[1.08] tracking-[-0.034em] text-foreground lg:text-[46px] xl:text-[51px]">
            Built for traders.
            <br />
            Designed for <span className="text-accent">growth.</span>
          </h1>

          <div className="mt-[30px] h-px w-10 bg-accent" />

          <p className="mt-5 max-w-[500px] text-[15px] leading-[1.75] text-muted">
            Create the account that matches how you work, then access the tools,
            workflows, and controls designed for your role.
          </p>

          <div className="mt-9 grid max-w-[540px] grid-cols-2 border border-line bg-[#090b0b]/75">
            <div className="border-r border-line px-5 py-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                Trader access
              </p>
              <p className="mt-2 text-[14px] leading-6 text-foreground">
                Platform, accounts, trading tools, bots, academy, and
                evaluations.
              </p>
            </div>

            <div className="px-5 py-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                Partner access
              </p>
              <p className="mt-2 text-[14px] leading-6 text-foreground">
                Referrals, commission tracking, payout management, and partner
                operations.
              </p>
            </div>
          </div>
        </div>
      </div>

      <footer className="relative z-10 flex items-center justify-between px-8 pb-7 text-[13px] text-muted/80 lg:px-12 xl:px-[60px]">
        <span>&copy; 2024 WSA Global. All rights reserved.</span>
        <span className="flex items-center gap-5">
          <Link href="/security" className="transition-colors hover:text-foreground">
            Security
          </Link>
          <span className="h-4 w-px bg-line" />
          <Link href="/privacy" className="transition-colors hover:text-foreground">
            Privacy
          </Link>
        </span>
      </footer>
    </aside>
  );

  // ── Step 1: Role selection ────────────────────────────────────────────────
  if (step === 1) {
    return (
      <main className="min-h-screen overflow-x-hidden bg-background text-foreground">
        <div className="grid min-h-screen md:grid-cols-[50%_50%]">
          {brandPanel}

          <section className="flex min-h-screen items-start justify-center bg-[#060808] px-5 py-7 sm:px-8 md:items-center md:px-10 md:py-10 lg:px-14 xl:px-[72px]">
            <div className="w-full max-w-[560px] md:-translate-y-[14px]">
              <div className="mb-10 md:hidden">
                {brandHeader}
              </div>

              <p className="text-[12px] font-bold uppercase tracking-[0.3em] text-accent">
                Create your account
              </p>

              <h2 className="mt-5 text-[36px] font-medium leading-[1.1] tracking-[-0.034em] text-foreground sm:text-[40px] lg:text-[42px]">
                How will you use {BRAND_NAME}?
              </h2>

              <p className="mt-4 max-w-[460px] text-[14px] leading-6 text-muted">
                Choose your account type to continue with the right onboarding
                flow.
              </p>

              <div className="mt-7 h-px w-full bg-line" />

              <div className="mt-8 divide-y divide-line border-y border-line">
                {ROLE_OPTIONS.map(({ role, eyebrow, title, description }) => {
                  const isTrader = role === "TRADER";
                  const Icon = isTrader ? TrendingUp : BriefcaseBusiness;

                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => handleRoleSelect(role)}
                      className="group grid w-full grid-cols-[48px_1fr_auto] items-start gap-4 px-0 py-6 text-left transition-colors hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent sm:grid-cols-[52px_1fr_auto]"
                    >
                      <span className="grid h-11 w-11 place-items-center rounded-[6px] border border-line bg-[#090b0b] text-muted transition-colors group-hover:border-accent/45 group-hover:text-accent">
                        <Icon className="h-[19px] w-[19px]" />
                      </span>

                      <span className="min-w-0">
                        <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
                          {eyebrow}
                        </span>
                        <span className="mt-2 block text-[18px] font-semibold tracking-[-0.015em] text-foreground">
                          {title}
                        </span>
                        <span className="mt-2 block max-w-[390px] text-[13px] leading-[1.7] text-muted">
                          {description}
                        </span>
                      </span>

                      <span className="pt-1 text-[20px] text-muted transition-all group-hover:translate-x-1 group-hover:text-accent">
                        &rarr;
                      </span>
                    </button>
                  );
                })}
              </div>

              <p className="mt-8 text-[13px] text-muted">
                Already have an account?{" "}
                <a
                  href="/login"
                  className="font-semibold text-accent transition-colors hover:text-foreground"
                >
                  Sign in
                </a>
              </p>
            </div>
          </section>
        </div>
      </main>
    );
  }

  // ── Step 2: Signup form ───────────────────────────────────────────────────
  const isPartner = selectedRole === "PARTNER";

  return (
    <main className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <div className="grid min-h-screen md:grid-cols-[50%_50%]">
        {brandPanel}

        <section className="flex min-h-screen items-start justify-center bg-[#060808] px-5 py-7 sm:px-8 md:items-center md:px-10 md:py-10 lg:px-14 xl:px-[72px]">
          <div className="w-full max-w-[560px] md:-translate-y-[8px]">
            <div className="mb-10 md:hidden">
              {brandHeader}
            </div>

            <button
              type="button"
              onClick={handleBack}
              className="mb-6 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.17em] text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>

            <p className="text-[12px] font-bold uppercase tracking-[0.3em] text-accent">
              {isPartner ? "Partner signup" : "Trader signup"}
            </p>

            <h1 className="mt-5 text-[34px] font-medium leading-[1.12] tracking-[-0.034em] text-foreground sm:text-[38px] lg:text-[40px]">
              {isPartner
                ? "Create your partner account"
                : "Create your trading workspace"}
            </h1>

            <p className="mt-4 max-w-[520px] text-[14px] leading-6 text-muted">
              {isPartner
                ? "Submit your application. An admin will review and activate your partner access before you can use the portal."
                : "Enter your details to create your trader account and access the platform."}
            </p>

            <div className="mt-7 h-px w-full bg-line" />

            <div className="mt-7 space-y-3">
              {referralCode && !isPartner ? (
                <div className="border border-accent-2/20 bg-accent-2/10 px-4 py-3 text-sm font-medium text-accent-2">
                  Referral code applied:{" "}
                  <span className="font-bold">{referralCode}</span>
                </div>
              ) : null}

              {message ? (
                <div className="border border-accent/20 bg-accent/10 px-4 py-3 text-sm font-medium text-accent">
                  {message}
                </div>
              ) : null}

              {error ? (
                <div className="border border-danger/20 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
                  {error}
                </div>
              ) : null}
            </div>

            <form
              className="mt-7 grid gap-5"
              method="post"
              onSubmit={handleSubmit}
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <TextField
                  label="Full name"
                  name="fullName"
                  placeholder="Full name"
                  className="!h-[56px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c] !px-4 !text-[14px] !text-foreground"
                />
                <TextField
                  label="Email"
                  name="email"
                  type="email"
                  placeholder="name@example.com"
                  className="!h-[56px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c] !px-4 !text-[14px] !text-foreground"
                />
                <TextField
                  label="Password"
                  name="password"
                  type="password"
                  placeholder="Password"
                  className="!h-[56px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c] !px-4 !text-[14px] !text-foreground"
                />
                <TextField
                  label="Confirm password"
                  name="confirmPassword"
                  type="password"
                  placeholder="Confirm password"
                  className="!h-[56px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c] !px-4 !text-[14px] !text-foreground"
                />
              </div>

              {!isPartner ? (
                <div>
                  <label className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">
                    Referral code (optional)
                  </label>
                  <input
                    name="referralCode"
                    value={referralCode}
                    onChange={(event) =>
                      setReferralCode(event.target.value.toUpperCase())
                    }
                    placeholder="Enter partner code"
                    maxLength={40}
                    autoComplete="off"
                    className="h-[56px] w-full rounded-[6px] border border-white/15 bg-[#0a0c0c] px-4 text-[14px] text-foreground placeholder:text-muted/50 focus:border-accent/70 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                  <p className="mt-2 text-[12px] leading-5 text-muted">
                    Codes are checked before account creation and cannot be
                    changed after attribution.
                  </p>
                </div>
              ) : null}

              <div className="flex items-center justify-end">
              <a
                href="/login"
                className="text-[13px] font-semibold text-accent transition-colors hover:text-foreground"
              >
                Already have account
              </a>
              </div>

              <PrimaryButton
                type="submit"
                disabled={isSubmitting}
                className="!h-[56px] !rounded-[6px] !text-[14px] !font-bold"
              >
                {isSubmitting
                  ? "Creating..."
                  : isPartner
                    ? "Submit partner application"
                    : "Create account"}
              </PrimaryButton>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
