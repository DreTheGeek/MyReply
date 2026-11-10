/**
 * The capture step's rules: what an ask says, and what a tap may store.
 */

import { describe, expect, it } from "vitest";
import {
  buildCaptureAsk,
  DEFAULT_CAPTURE_CONSENT,
  DEFAULT_CAPTURE_PROMPT,
  parseCapturedDetail,
} from "../lib/campaigns/capture";

const both = { email: true, phone: true };

describe("buildCaptureAsk", () => {
  it("puts the consent wording under the ask, and keeps it on its own for the record", () => {
    const ask = buildCaptureAsk(
      {
        captureEnabled: true,
        captureKinds: ["phone", "email", "email"],
        capturePrompt: " Want reminders? ",
        captureConsentText: "We text about bookings only.",
      },
      both
    );
    expect(ask).toEqual({
      kinds: ["email", "phone"],
      text: "Want reminders?\n\nWe text about bookings only.",
      consentText: "We text about bookings only.",
    });
  });

  it("never sends bare buttons: blank wording falls back to the defaults", () => {
    const ask = buildCaptureAsk(
      { captureEnabled: true, captureKinds: ["phone"], capturePrompt: "", captureConsentText: "  " },
      both
    );
    expect(ask?.consentText).toBe(DEFAULT_CAPTURE_CONSENT);
    expect(ask?.text).toBe(`${DEFAULT_CAPTURE_PROMPT.phone}\n\n${DEFAULT_CAPTURE_CONSENT}`);
  });

  it("asks nothing when off, empty, or for a detail the platform cannot fill in", () => {
    expect(buildCaptureAsk({ captureEnabled: false, captureKinds: ["email"] }, both)).toBeNull();
    expect(buildCaptureAsk({ captureEnabled: true, captureKinds: [] }, both)).toBeNull();
    expect(
      buildCaptureAsk({ captureEnabled: true, captureKinds: ["phone"] }, { email: true, phone: false })
    ).toBeNull();
    expect(buildCaptureAsk({ captureEnabled: true, captureKinds: ["fax"] }, both)).toBeNull();
  });
});

describe("parseCapturedDetail", () => {
  it("reads an email, lowercased", () => {
    expect(parseCapturedDetail(" Ana@Example.COM ")).toEqual({ kind: "email", value: "ana@example.com" });
  });

  it("reads a phone number as a plus and digits", () => {
    expect(parseCapturedDetail("+1 (555) 123-4567")).toEqual({ kind: "phone", value: "+15551234567" });
    expect(parseCapturedDetail("07911 123456")).toEqual({ kind: "phone", value: "07911123456" });
  });

  it("stores nothing that is neither", () => {
    for (const value of ["reveal:auto_1", "hello", "12345", "+1234567890123456789", "", "a@b", null, 42]) {
      expect(parseCapturedDetail(value)).toBeNull();
    }
  });
});
