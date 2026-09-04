import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Scheduling lives in Supabase pg_cron, not in vercel.json. These tests guard
 * the two things that silently break that: someone re-adding a Vercel cron, and
 * the migration drifting away from the routes it calls.
 *
 * Nothing here touches a database. It reads the checked in migration text.
 */

const repoRoot = path.resolve(__dirname, "..");

const MIGRATION_DIR = "20260905000000_supabase_pg_cron_jobs";

const migrationSql = fs.readFileSync(
  path.join(repoRoot, "prisma", "migrations", MIGRATION_DIR, "migration.sql"),
  "utf8"
);

const vercelJson = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "vercel.json"), "utf8")
) as Record<string, unknown>;

/** The jobs that must exist, and the schedules they carried over from Vercel. */
const HTTP_JOBS: ReadonlyArray<{
  name: string;
  schedule: string;
  route: string;
}> = [
  {
    name: "myreply_refresh_tokens",
    schedule: "0 5 * * *",
    route: "/api/cron/refresh-tokens",
  },
  {
    name: "myreply_attach_next_reel",
    schedule: "0 6 * * *",
    route: "/api/cron/attach-next-reel",
  },
  {
    name: "myreply_snapshot_followers",
    schedule: "0 7 * * *",
    route: "/api/cron/snapshot-followers",
  },
  {
    name: "myreply_ingest_knowledge",
    schedule: "*/15 * * * *",
    route: "/api/cron/ingest-knowledge",
  },
];

describe("vercel.json", () => {
  it("declares no crons, because Supabase owns scheduling", () => {
    expect(vercelJson).not.toHaveProperty("crons");
  });

  it("keeps the pinned framework", () => {
    expect(vercelJson.framework).toBe("nextjs");
  });
});

describe("pg_cron migration", () => {
  it("schedules every job that used to run on Vercel", () => {
    for (const job of HTTP_JOBS) {
      const escapedSchedule = job.schedule.replace(/[*/]/g, (c) => `\\${c}`);
      expect(
        migrationSql,
        `${job.name} must keep the schedule ${job.schedule}`
      ).toMatch(
        new RegExp(`'${job.name}',\\s*'${escapedSchedule}',`)
      );
      expect(migrationSql).toContain(`'${job.name}', '${job.route}'`);
    }
  });

  it("schedules the response settler, without which a failing job looks fine", () => {
    expect(migrationSql).toContain("'myreply_settle_responses'");
    expect(migrationSql).toContain("myreply_cron.settle()");
  });

  it("unschedules by name before scheduling, so a second apply is a no-op", () => {
    const unschedule = migrationSql.indexOf("PERFORM cron.unschedule(");
    const schedule = migrationSql.indexOf("SELECT cron.schedule(");
    expect(unschedule).toBeGreaterThan(-1);
    expect(schedule).toBeGreaterThan(-1);
    expect(unschedule).toBeLessThan(schedule);

    // Every job name must be in the array the unschedule loop walks.
    const arrayStart = migrationSql.lastIndexOf("ARRAY[", unschedule);
    const names = migrationSql.slice(arrayStart, unschedule);
    for (const job of [...HTTP_JOBS, { name: "myreply_settle_responses" }]) {
      expect(names, `${job.name} must be unscheduled first`).toContain(
        `'${job.name}'`
      );
    }
  });

  it("calls a route that actually exists and exports GET", () => {
    for (const job of HTTP_JOBS) {
      const routeFile = path.join(repoRoot, "app", job.route, "route.ts");
      expect(fs.existsSync(routeFile), `${job.route} route file`).toBe(true);

      // The jobs use net.http_get. A route that only exports POST would 405.
      const source = fs.readFileSync(routeFile, "utf8");
      expect(source, `${job.route} must export GET`).toMatch(
        /export\s+async\s+function\s+GET\s*\(/
      );
    }
  });

  it("uses http_get, matching what the routes export", () => {
    expect(migrationSql).toMatch(/net\.http_get\s*\(/);
    expect(migrationSql).not.toMatch(/net\.http_post\s*\(/);
  });

  it("reads the origin and the bearer token from the vault, never from the job body", () => {
    expect(migrationSql).toContain("vault.decrypted_secrets");
    expect(migrationSql).toContain("'myreply_app_url'");
    expect(migrationSql).toContain("'myreply_cron_secret'");

    // Every Bearer in the file must be concatenated with a variable. A literal
    // token would land in git and in cron.job.command, which is world readable
    // to anyone with database access.
    const bearers = migrationSql.match(/Bearer[^\n]*/g) ?? [];
    for (const line of bearers) {
      expect(line).toMatch(/^Bearer '\s*\|\|/);
    }

    // No scheme in the file either. The origin is a vault lookup.
    expect(migrationSql).not.toMatch(/'https?:\/\//);
  });

  it("exposes a status view rather than leaving runs unobservable", () => {
    expect(migrationSql).toContain("myreply_cron.job_status");
    expect(migrationSql).toContain("security_invoker = true");
    expect(migrationSql).toContain("cron.job_run_details");
    expect(migrationSql).toContain("net._http_response");
  });

  it("enables row level security on the run log", () => {
    expect(migrationSql).toContain(
      "ALTER TABLE myreply_cron.http_request ENABLE ROW LEVEL SECURITY"
    );
  });
});

describe("house style", () => {
  it("has no em dashes in the cron files", () => {
    // Built from its code point so this file does not itself contain one.
    const emDash = String.fromCharCode(0x2014);

    const files = [
      path.join("prisma", "migrations", MIGRATION_DIR, "migration.sql"),
      path.join("docs", "cron.md"),
      path.join("scripts", "cron-status.mjs"),
      "vercel.json",
    ];

    for (const file of files) {
      const text = fs.readFileSync(path.join(repoRoot, file), "utf8");
      expect(text.includes(emDash), `${file} contains an em dash`).toBe(false);
    }
  });
});
