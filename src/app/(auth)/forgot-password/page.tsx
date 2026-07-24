"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { ArrowLeft, Mail } from "lucide-react";
import { BrandLogo } from "@/components/app/BrandLogo";
import { TextField } from "@/components/app/FormFields";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("");
    setError("");

    const formData = new FormData(event.currentTarget);
    const email = formData.get("email") as string;

    const supabase = createClient();
    const { error: authError } =
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo:
          process.env.NEXT_PUBLIC_SITE_URL + "/reset-password",
      });

    setIsSubmitting(false);

    if (authError) {
      setError(authError.message);
      return;
    }

    setMessage("Reset link sent. Check your inbox to continue.");
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
            <Link href="/" className="block w-fit">
              <BrandLogo className="h-14 w-auto max-w-[190px]" priority />
            </Link>
          </header>

          <div className="relative z-10 mt-auto px-8 pb-[76px] lg:px-12 xl:px-[60px]">
            <div className="max-w-[590px]">
              <p className="text-[12px] font-bold uppercase tracking-[0.3em] text-accent">
                Secure account recovery
              </p>

              <h1 className="mt-5 text-[38px] font-medium leading-[1.08] tracking-[-0.034em] text-foreground lg:text-[46px] xl:text-[51px]">
                Recover access.
                <br />
                Return with <span className="text-accent">confidence.</span>
              </h1>

              <div className="mt-[30px] h-px w-10 bg-accent" />

              <p className="mt-5 max-w-[500px] text-[15px] leading-[1.75] text-muted">
                Request a secure password reset link and continue protecting
                your account without disrupting your workspace.
              </p>

              <div className="mt-9 max-w-[540px] border border-line bg-[#090b0b]/75 px-5 py-5">
                <div className="grid grid-cols-[44px_1fr] items-start gap-4">
                  <span className="grid h-11 w-11 place-items-center rounded-[6px] border border-accent/45 text-accent">
                    <Mail className="h-[19px] w-[19px]" />
                  </span>

                  <div>
                    <p className="text-[15px] font-semibold text-foreground">
                      Check your inbox
                    </p>
                    <p className="mt-1.5 text-[13px] leading-[1.65] text-muted">
                      The reset link will be sent to the email address connected
                      to your account.
                    </p>
                  </div>
                </div>
              </div>
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
          <div className="w-full max-w-[560px] md:-translate-y-[18px]">
            <div className="mb-10 md:hidden">
              <Link href="/" className="block w-fit">
                <BrandLogo className="h-14 w-auto max-w-[190px]" priority />
              </Link>
            </div>

            <Link
              href="/login"
              className="mb-6 inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.17em] text-muted transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to login
            </Link>

            <p className="text-[12px] font-bold uppercase tracking-[0.3em] text-accent">
              Recovery
            </p>

            <h1 className="mt-5 text-[36px] font-medium leading-[1.1] tracking-[-0.034em] text-foreground sm:text-[40px] lg:text-[42px]">
              Forgot your password?
            </h1>

            <p className="mt-4 max-w-[500px] text-[14px] leading-6 text-muted">
              Enter the email address associated with your account. We will
              send you a secure link to create a new password.
            </p>

            <div className="mt-7 h-px w-full bg-line" />

            <div className="mt-7 space-y-3">
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
              className="mt-8 grid gap-6"
              onSubmit={handleSubmit}
            >
              <TextField
                label="Email"
                name="email"
                type="email"
                placeholder="name@example.com"
                className="!h-[58px] !rounded-[6px] !border-white/15 !bg-[#0a0c0c] !px-5 !text-[15px] !text-foreground"
              />

              <button
                type="submit"
                disabled={isSubmitting}
                className="flex h-[56px] w-full items-center justify-center rounded-[6px] border border-accent bg-accent px-6 text-[14px] font-bold text-background transition-colors hover:bg-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Sending..." : "Send reset link"}
              </button>
            </form>

            <p className="mt-8 text-[13px] text-muted">
              Remembered your password?{" "}
              <Link
                href="/login"
                className="font-semibold text-accent transition-colors hover:text-foreground"
              >
                Sign in
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
