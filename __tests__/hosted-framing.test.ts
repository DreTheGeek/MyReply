/**
 * Hosted pages may be framed only by the partner whose link it is, and a
 * partner's own domain serves only those pages. Everything else stays
 * unframeable, as it was.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { createHostedToken } from "../lib/partners/links";
import { SECURITY_HEADERS, buildCsp, frameAncestorsFor } from "../lib/security/csp";
import { hostedPageCsp, isPartnerHost, proxy } from "../proxy";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "framing-test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://app.myreply.test");
});

function connectToken(fa: string[]): string {
  return createHostedToken({ k: "connect", w: "ws_1", p: "partner_lash", r: "https://lashtech.app/done", fa }, 30).token;
}

function frameAncestors(csp: string): string {
  return /frame-ancestors ([^;]+)/.exec(csp)?.[1] ?? "";
}

describe("a hosted page's framing", () => {
  it("lets only the partner's own origins frame its link", () => {
    const csp = hostedPageCsp(`/hosted/connect/${connectToken(["https://lashtech.app", "https://www.lashtech.app"])}`);
    expect(frameAncestors(csp)).toBe("https://lashtech.app https://www.lashtech.app");
  });

  it("lets nobody frame an edited, expired or unknown link", () => {
    const token = connectToken(["https://lashtech.app"]);
    expect(frameAncestors(hostedPageCsp(`/hosted/connect/${token}x`))).toBe("'none'");
    expect(frameAncestors(hostedPageCsp(`/hosted/inbox/${token}`))).toBe("'none'");
    expect(frameAncestors(hostedPageCsp("/hosted/somewhere-else"))).toBe("'none'");
    expect(frameAncestors(hostedPageCsp(`/hosted/connect/${connectToken([])}`))).toBe("'none'");
  });

  it("drops anything that is not a bare https origin", () => {
    expect(frameAncestorsFor(["https://lashtech.app", "http://evil.example", "*", "https://x.example/path", "'self'"])).toBe(
      "https://lashtech.app"
    );
    expect(frameAncestorsFor([])).toBe("'none'");
  });

  it("is set by the proxy on every hosted request", () => {
    const response = proxy(new NextRequest(`https://app.myreply.test/hosted/connect/${connectToken(["https://lashtech.app"])}`));
    expect(frameAncestors(response.headers.get("content-security-policy") ?? "")).toBe("https://lashtech.app");
  });
});

describe("the rest of the app", () => {
  it("stays unframeable, and the hosted pages are carved out of only that rule", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const everywhere = rules.find((rule) => rule.source === "/:path((?!hosted/).*)");
    const hosted = rules.find((rule) => rule.source === "/hosted/:path*");
    expect(everywhere?.headers).toEqual(SECURITY_HEADERS);
    expect(frameAncestors(buildCsp("'none'"))).toBe("'none'");
    expect(everywhere?.headers.find((header) => header.key === "X-Frame-Options")?.value).toBe("DENY");
    // The hosted rule still carries nosniff and the rest, just not the framing pair.
    const keys = hosted?.headers.map((header) => header.key) ?? [];
    expect(keys).toContain("X-Content-Type-Options");
    expect(keys).toContain("Permissions-Policy");
    expect(keys).not.toContain("X-Frame-Options");
    expect(keys).not.toContain("Content-Security-Policy");
  });

  it("matches every path but the hosted ones with the deny rule", () => {
    const pattern = /^\/((?!hosted\/).*)$/;
    for (const pathname of ["/", "/dashboard", "/api/v1/workspaces", "/reports/abc", "/hostedfoo"]) {
      expect(pattern.test(pathname), pathname).toBe(true);
    }
    expect(pattern.test("/hosted/connect/abc")).toBe(false);
  });
});

describe("a partner's own domain", () => {
  it("is told apart from ours, Vercel previews and local development", () => {
    const base = "https://app.myreply.test";
    expect(isPartnerHost("connect.lashtech.app", base)).toBe(true);
    expect(isPartnerHost("app.myreply.test", base)).toBe(false);
    expect(isPartnerHost("myreply-git-branch.vercel.app", base)).toBe(false);
    expect(isPartnerHost("localhost:3000", base)).toBe(false);
    // Without our own URL nothing is treated as a partner's, rather than everything.
    expect(isPartnerHost("connect.lashtech.app", undefined)).toBe(false);
  });

  it("serves the hosted pages and nothing of ours", () => {
    const onPartner = (pathname: string): NextRequest =>
      new NextRequest(`https://connect.lashtech.app${pathname}`, { headers: { host: "connect.lashtech.app" } });

    for (const pathname of ["/dashboard", "/login", "/", "/api/v1/workspaces", "/settings"]) {
      expect(proxy(onPartner(pathname)).status, pathname).toBe(404);
    }
    expect(proxy(onPartner(`/hosted/connect/${connectToken(["https://lashtech.app"])}`)).status).toBe(200);
    expect(proxy(onPartner("/api/hosted/connect/instagram?t=x")).status).toBe(200);
  });

  it("leaves our own domain working as before", () => {
    const response = proxy(
      new NextRequest("https://app.myreply.test/dashboard", { headers: { host: "app.myreply.test" } })
    );
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });
});
