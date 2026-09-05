/**
 * What the server checks about itself when it starts.
 *
 * Next.js runs this once per server boot, and not at build time, which makes
 * it the only place the web app can look at its own configuration before it
 * starts taking requests.
 *
 * WHY THIS EXISTS. A follower snapshot failed in production with
 * "ENCRYPTION_KEY environment variable is required", recorded as one warning
 * on one request. That is the shape every missing variable takes here: not a
 * refusal to start, but a deep throw inside whichever request happens to need
 * it first, surfacing as an unrelated-looking failure hours later. The reason
 * lands in a database row nobody is watching.
 *
 * WHY IT LOGS AND DOES NOT EXIT. Because I made exactly that mistake in the
 * worker an hour before writing this: a boot check that demanded a variable
 * the process did not need took the worker down and stopped the queue. The web
 * app has a much wider job than the worker, and most of it still works without
 * any given secret. A missing WEBHOOK_VERIFY_TOKEN should not stop the
 * marketing pages, the dashboard and the API from serving.
 *
 * So this is loud, not fatal. It names what is missing and what breaks as a
 * result, in the platform log, at the moment the server starts, which is the
 * one moment somebody is looking.
 */

interface RequiredVar {
  name: string;
  /** What stops working without it, in the operator's terms. */
  breaks: string;
  /** Extra shape check beyond "is set". */
  valid?: (value: string) => boolean;
}

const HEX_32_BYTE = /^[a-f0-9]{64}$/i;

const EXPECTED: RequiredVar[] = [
  {
    name: "DATABASE_URL",
    breaks: "everything: no page or route can read or write",
  },
  {
    name: "NEXTAUTH_SECRET",
    breaks: "sign-in, and every existing session becomes unreadable",
  },
  {
    name: "NEXTAUTH_URL",
    breaks:
      "tracked links, which fall back to http://localhost:3000 and reach nobody",
  },
  {
    name: "ENCRYPTION_KEY",
    breaks:
      "every Instagram token read: no DM sends, no follower snapshots, no token refresh",
    valid: (value) => HEX_32_BYTE.test(value),
  },
  {
    name: "REDIS_URL",
    breaks: "queueing, so comments are received and never processed",
  },
  {
    name: "INSTAGRAM_APP_ID",
    breaks: "connecting a new Instagram account",
  },
  {
    name: "INSTAGRAM_APP_SECRET",
    breaks: "connecting a new Instagram account",
  },
  {
    name: "FACEBOOK_APP_SECRET",
    breaks: "webhook signature verification, so no comment is ever accepted",
  },
  {
    name: "WEBHOOK_VERIFY_TOKEN",
    breaks: "Meta's webhook verification handshake",
  },
];

export function register(): void {
  // Only the Node server runtime has the full environment, and only it serves
  // the routes these variables belong to.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const missing: string[] = [];
  const malformed: string[] = [];

  for (const expected of EXPECTED) {
    const value = process.env[expected.name];
    if (!value || value.trim() === "") {
      missing.push(`${expected.name} — without it, ${expected.breaks}`);
      continue;
    }
    if (expected.valid && !expected.valid(value)) {
      malformed.push(
        `${expected.name} is set but the wrong shape — ${expected.breaks}`
      );
    }
  }

  if (missing.length === 0 && malformed.length === 0) {
    console.log(
      `[startup] Environment complete: all ${EXPECTED.length} expected variables are present.`
    );
    return;
  }

  console.error(
    "[startup] ENVIRONMENT INCOMPLETE. The server is starting anyway, because most of it still works, but the following will fail at the moment something needs them:"
  );
  for (const line of [...missing, ...malformed]) {
    console.error(`  - ${line}`);
  }
}
