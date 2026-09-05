"use client";

/**
 * Error boundary for the signed-in portal.
 *
 * Nested inside the dashboard layout on purpose, so a failing page keeps the
 * sidebar and the person can move somewhere else instead of losing the whole
 * shell. app/error.tsx is the fallback for everything outside the portal.
 */

import { useEffect } from "react";
import Link from "next/link";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Portal page failed", error);
  }, [error]);

  return (
    <div className="panel rounded p-8 text-center">
      <h2 className="text-base font-semibold text-foreground">
        This page failed to load
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
        Your campaigns keep running while this is broken. Automations do not
        depend on the portal being open.
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <button
          onClick={reset}
          className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          Try again
        </button>
        <Link
          href="/campaigns"
          className="rounded border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground"
        >
          Go to campaigns
        </Link>
      </div>
      {error.digest && (
        <p className="mt-6 font-mono text-xs text-zinc-500">
          Reference {error.digest}
        </p>
      )}
    </div>
  );
}
