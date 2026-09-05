import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "../proxy";

const ORIGIN = "https://reply.example.com";

function request(path: string, cookies: string[] = []) {
  const headers = new Headers();
  if (cookies.length) {
    headers.set("cookie", cookies.map((c) => `${c}=abc123`).join("; "));
  }
  return new NextRequest(new URL(path, ORIGIN), { headers });
}

function locationOf(response: Response): string | null {
  const location = response.headers.get("location");
  return location ? new URL(location).pathname + new URL(location).search : null;
}

describe("proxy: unauthenticated visitors", () => {
  it("sends a visitor with no cookie to login, carrying where they were going", () => {
    const response = proxy(request("/campaigns"));
    expect(response.status).toBe(307);
    expect(locationOf(response)).toBe("/login?callbackUrl=%2Fcampaigns");
  });

  it("covers every signed-in surface, not just the original four", () => {
    for (const path of [
      "/overview",
      "/campaigns",
      "/contacts",
      "/inbox",
      "/answers",
      "/diagnostics",
      "/onboarding",
    ]) {
      expect(locationOf(proxy(request(path)))).toContain("/login?callbackUrl=");
    }
  });

  it("leaves /templates alone, which serves signed out visitors too", () => {
    expect(proxy(request("/templates")).headers.get("location")).toBeNull();
  });
});

describe("proxy: the stale cookie loop", () => {
  // Signing out on one device deletes the session row but leaves every other
  // device holding a cookie. Before the fix that state redirected
  // /login -> /dashboard -> /login forever and the person could never reach
  // the sign-in form.
  const stale = ["authjs.session-token"];

  it("does not bounce back to the dashboard once the layout says the cookie is dead", () => {
    const response = proxy(request("/login?session=expired", stale));
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("clears the dead cookie so a reload cannot re-enter the loop", () => {
    const response = proxy(request("/login?session=expired", stale));
    const cleared = response.cookies.get("authjs.session-token");
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
    for (const name of [
      "__Secure-authjs.session-token",
      "next-auth.session-token",
      "__Secure-next-auth.session-token",
    ]) {
      expect(response.cookies.get(name)?.maxAge).toBe(0);
    }
  });

  it("still honours callbackUrl when the session is genuinely live", () => {
    const response = proxy(
      request("/login?callbackUrl=%2Foauth%2Fauthorize%3Fclient_id%3Dx", stale)
    );
    expect(locationOf(response)).toBe("/oauth/authorize?client_id=x");
  });

  it("breaks the loop for the OAuth screen, which passes both parameters", () => {
    const response = proxy(
      request("/login?callbackUrl=%2Foauth%2Fauthorize&session=expired", stale)
    );
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses a protocol relative callbackUrl rather than leaving the origin", () => {
    const response = proxy(request("/login?callbackUrl=%2F%2Fevil.test", stale));
    expect(locationOf(response)).toBe("/dashboard");
  });
});
