"use client";

/**
 * Route error boundary.
 *
 * Without this file every thrown error in a server component or a server
 * action renders Next.js's unbranded "Application error: a server-side
 * exception has occurred", which tells the person nothing and offers them
 * nothing to do. This gives them a way back and gives us the digest to match
 * against the server log.
 *
 * The message itself is never shown. It can carry a connection string, a
 * table name or a provider's raw response, none of which belongs in front of
 * a customer. `digest` is the id the server assigned to the same error, so
 * support can find it without the customer reading anything sensitive.
 */

import { useEffect } from "react";
import Link from "next/link";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server errors are already logged server side. This covers the ones
    // thrown while rendering on the client, which otherwise vanish.
    console.error("Unhandled application error", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="panel w-full max-w-md rounded p-8 text-center">
        <h1 className="text-lg font-semibold text-foreground">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-muted">
          This page failed to load. Nothing you were working on was lost, and
          your campaigns kept running.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            onClick={reset}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            Try again
          </button>
          <Link
            href="/dashboard"
            className="rounded border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground"
          >
            Back to the portal
          </Link>
        </div>
        {error.digest && (
          <p className="mt-6 font-mono text-xs text-zinc-500">
            Reference {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
