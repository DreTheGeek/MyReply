/**
 * Meta's signed_request: only a request signed with the right app secret is
 * believed.
 */

import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { parseSignedRequest } from "../lib/meta/signed-request";

const SECRET = "app-secret-for-tests";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const encoded = b64url(JSON.stringify(payload));
  const signature = b64url(createHmac("sha256", secret).update(encoded).digest());
  return `${signature}.${encoded}`;
}

describe("parseSignedRequest", () => {
  it("reads the user id and issue time from a request Meta signed", () => {
    const parsed = parseSignedRequest(
      sign({ algorithm: "HMAC-SHA256", user_id: "1234567890", issued_at: 1_762_000_000 }),
      SECRET
    );
    expect(parsed).toEqual({ userId: "1234567890", issuedAt: new Date(1_762_000_000 * 1000) });
  });

  it("accepts a numeric user id", () => {
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: 42 }), SECRET)?.userId).toBe("42");
  });

  it("refuses a request signed with another app's secret", () => {
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "1" }, "other"), SECRET)).toBeNull();
  });

  it("refuses a payload changed after signing", () => {
    const [signature] = sign({ algorithm: "HMAC-SHA256", user_id: "1" }).split(".");
    const forged = b64url(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "2" }));
    expect(parseSignedRequest(`${signature}.${forged}`, SECRET)).toBeNull();
  });

  it("refuses the wrong algorithm, a missing user, junk and a missing secret", () => {
    expect(parseSignedRequest(sign({ algorithm: "none", user_id: "1" }), SECRET)).toBeNull();
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256" }), SECRET)).toBeNull();
    for (const junk of [undefined, "", "abc", "a.b.c", ".x", 7, "x".repeat(5000)]) {
      expect(parseSignedRequest(junk, SECRET)).toBeNull();
    }
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "1" }), undefined)).toBeNull();
  });
});
