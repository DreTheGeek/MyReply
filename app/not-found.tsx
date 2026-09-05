/**
 * Branded 404.
 *
 * The default Next.js page is an unstyled black-on-white "404 | This page
 * could not be found", which on a paid product reads as a broken deploy
 * rather than a mistyped URL.
 */

import Link from "next/link";

export const metadata = {
  title: "Page not found - MyReply",
  // A 404 must never be indexed as content.
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6">
      <div className="panel w-full max-w-md rounded p-8 text-center">
        <h1 className="text-lg font-semibold text-foreground">
          That page does not exist
        </h1>
        <p className="mt-2 text-sm text-muted">
          The link may be out of date, or the campaign or report it pointed at
          was deleted.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link
            href="/dashboard"
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            Go to the portal
          </Link>
          <Link
            href="/"
            className="rounded border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground"
          >
            Home
          </Link>
        </div>
      </div>
    </div>
  );
}
