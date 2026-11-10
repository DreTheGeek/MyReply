/**
 * The channel boundary, enforced.
 *
 * Flows, the inbox, the webhook, the API, the crons and metering talk only to
 * the channel adapter. Only a platform's own adapter (and the client it
 * wraps) may import that platform's code or call its API. This walks the
 * source tree and fails on any file that reaches past the adapter, so the rule
 * cannot quietly erode one shortcut at a time.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCANNED = ["app", "components", "lib", "worker"];

/** Directories allowed to touch Instagram directly. */
const INSTAGRAM_OWNERS = [
  "lib/channels/instagram/",
  // The Facebook Page adapter wraps the same Graph client for Pages.
  "lib/channels/facebook/",
  // The Graph client, webhook parser, OAuth and menu code the adapter wraps.
  "lib/meta/",
];

const SKIP = ["app/generated/"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (SKIP.some((prefix) => rel.startsWith(prefix))) continue;
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(rel);
    }
  }
  return out;
}

const files = SCANNED.flatMap((dir) => sourceFiles(path.join(ROOT, dir)));
const outside = files.filter(
  (file) => !INSTAGRAM_OWNERS.some((owner) => file.startsWith(owner))
);

const PLATFORM_IMPORT = /from\s+["'](?:@\/lib\/meta\/|(?:\.\.\/)+lib\/meta\/|\.\/meta\/)/;
const PLATFORM_HOST = /https:\/\/(?:graph|api|www)\.(?:instagram|facebook)\.com/;

describe("channel boundary", () => {
  it("scans the files it means to", () => {
    // Guards against the walk silently finding nothing.
    expect(outside).toContain("lib/queue/dm-worker.ts");
    expect(outside).toContain("app/api/webhook/route.ts");
    expect(outside).toContain("lib/polling/comment-reconciler.ts");
  });

  it("no file outside the Instagram adapter imports Instagram code", () => {
    const offenders = outside.filter((file) =>
      PLATFORM_IMPORT.test(readFileSync(path.join(ROOT, file), "utf8"))
    );
    expect(offenders).toEqual([]);
  });

  it("no file outside the Instagram adapter calls a Meta API host", () => {
    const offenders = outside.filter((file) =>
      PLATFORM_HOST.test(readFileSync(path.join(ROOT, file), "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
