/**
 * Email on a partner's behalf goes out from the partner's own sender, in its
 * name, and never from ours.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    partner: { findUnique: vi.fn() },
    workspace: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { escapeHtml, hostedLinkMail, partnerSender, sendPartnerMail } from "../lib/email/partner-mail";
import { createConnectLink } from "../lib/partners/workspaces";

const PARTNER = {
  id: "partner_lash",
  brandName: "Lash Tech",
  emailFromName: "Lash Tech",
  emailFromAddress: "hello@lashtech.app",
  returnOrigins: ["https://lashtech.app"],
  frameOrigins: [],
  customDomain: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_SECRET", "mail-test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://app.myreply.test");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_SERVER", "");
  mockPrisma.partner.findUnique.mockResolvedValue(PARTNER);
  mockPrisma.workspace.findFirst.mockResolvedValue({ id: "ws_lash" });
});

describe("the sender", () => {
  it("is the partner's own name and address", async () => {
    expect(await partnerSender("partner_lash")).toBe('"Lash Tech" <hello@lashtech.app>');
  });

  it("does not exist until the partner has one, and a name cannot break the header", async () => {
    mockPrisma.partner.findUnique.mockResolvedValueOnce({ ...PARTNER, emailFromAddress: null });
    expect(await partnerSender("partner_lash")).toBeNull();
    mockPrisma.partner.findUnique.mockResolvedValueOnce({ ...PARTNER, emailFromName: 'Lash"\r\nBcc: x@evil.example <' });
    // Quoted, so the colon is part of a name and cannot start an address list.
    expect(await partnerSender("partner_lash")).toBe('"LashBcc: x@evil.example" <hello@lashtech.app>');
    mockPrisma.partner.findUnique.mockResolvedValueOnce({ ...PARTNER, emailFromName: "Lash\\" });
    expect(await partnerSender("partner_lash")).toBe('"Lash" <hello@lashtech.app>');
  });
});

describe("sending", () => {
  it("goes through the mail provider from the partner's sender", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const mail = hostedLinkMail({
      kind: "connect",
      brandName: "Lash Tech",
      url: "https://connect.lashtech.app/hosted/connect/abc",
      expiresAt: "2026-11-11T13:00:00.000Z",
      to: "bella@example.com",
    });
    expect(await sendPartnerMail("partner_lash", mail, fetchImpl as unknown as typeof fetch)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ from: '"Lash Tech" <hello@lashtech.app>', to: ["bella@example.com"], subject: "Connect your accounts to Lash Tech" });
    expect(body.text).toContain("https://connect.lashtech.app/hosted/connect/abc");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("myreply");
  });

  it("refuses to send without a partner sender rather than using ours", async () => {
    mockPrisma.partner.findUnique.mockResolvedValue({ ...PARTNER, emailFromAddress: null });
    const fetchImpl = vi.fn();
    const result = await sendPartnerMail(
      "partner_lash",
      { to: "a@example.com", subject: "s", text: "t", html: "h" },
      fetchImpl as unknown as typeof fetch
    );
    expect(result).toEqual({ ok: false, reason: "no_sender" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says so when the provider refuses", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 422 }));
    const result = await sendPartnerMail(
      "partner_other",
      { to: "a@example.com", subject: "s", text: "t", html: "h" },
      fetchImpl as unknown as typeof fetch
    );
    expect(result).toEqual({ ok: false, reason: "send_failed" });
    spy.mockRestore();
  });

  it("escapes the brand in the HTML", () => {
    expect(escapeHtml('<b>"x"</b>')).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
    const mail = hostedLinkMail({ kind: "inbox", brandName: "<script>", url: "https://x.example/a?b=1&c=2", expiresAt: "2026-11-11T13:00:00.000Z", to: "a@example.com" });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&amp;c=2");
  });
});

describe("asking a link endpoint to email the link", () => {
  it("is refused before a link is made when the partner has no sender", async () => {
    mockPrisma.partner.findUnique.mockResolvedValue({ ...PARTNER, emailFromAddress: null });
    const result = await createConnectLink("partner_lash", "ws_lash", {
      returnUrl: "https://lashtech.app/done",
      sendTo: "bella@example.com",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("makes the link without emailing when nobody is named", async () => {
    const result = await createConnectLink("partner_lash", "ws_lash", { returnUrl: "https://lashtech.app/done" });
    expect(result).toMatchObject({ ok: true, emailed: false });
  });
});
