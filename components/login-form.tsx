"use client";

/**
 * The sign-in form.
 *
 * Split out of the page as a client component for one reason: `useFormStatus`
 * needs to sit inside the <form>, and it is what stops the button being
 * clickable while the Resend round trip is in flight. Without it the first
 * interaction in the product looked broken for one to three seconds and people
 * clicked twice, which sends two magic links and immediately invalidates the
 * first one.
 */

import { useFormStatus } from "react-dom";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex w-full items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-on-accent shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Sending your link..." : "Email me a magic link"}
    </button>
  );
}

export default function LoginForm({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}): React.JSX.Element {
  return (
    <form action={action} className="space-y-5">
      <div className="space-y-2">
        <label
          htmlFor="email"
          className="block text-sm font-medium text-foreground"
        >
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          className="w-full rounded border border-border bg-surface px-4 py-3 text-sm text-foreground transition-colors placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
        />
      </div>

      <SubmitButton />

      <p className="text-center text-xs leading-relaxed text-muted">
        By continuing you agree to our{" "}
        <a href="/terms" className="underline hover:text-foreground">
          Terms
        </a>{" "}
        and{" "}
        <a href="/privacy" className="underline hover:text-foreground">
          Privacy Policy
        </a>
        .
      </p>
    </form>
  );
}
