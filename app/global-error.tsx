"use client";

/**
 * Last resort boundary.
 *
 * app/error.tsx cannot catch an error thrown by the root layout itself,
 * because the boundary lives inside that layout. This one replaces the whole
 * document, so it has to bring its own html and body and cannot rely on the
 * app's stylesheet having loaded. Everything here is inline for that reason.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#09090b",
          color: "#fafafa",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ maxWidth: "28rem", padding: "2rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
            MyReply could not load
          </h1>
          <p
            style={{
              marginTop: "0.5rem",
              fontSize: "0.875rem",
              lineHeight: 1.6,
              color: "#a1a1aa",
            }}
          >
            Your campaigns are unaffected and keep running. This is the app
            itself failing to start.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              color: "#09090b",
              background: "#fafafa",
              border: 0,
              borderRadius: "0.25rem",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p
              style={{
                marginTop: "1.5rem",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                color: "#71717a",
              }}
            >
              Reference {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
