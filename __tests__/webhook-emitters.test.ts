/**
 * Where events come from: every send through a stored account raises dm.sent
 * or dm.failed, with a reason a partner can act on and nothing of the
 * platform's own error text.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEmit, mockRecordUsage } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockRecordUsage: vi.fn(),
}));

vi.mock("@/lib/webhooks/events", () => ({ emitEvent: mockEmit }));
vi.mock("@/lib/usage/meter", () => ({ recordUsage: mockRecordUsage }));

import type { ChannelAdapter } from "../lib/channels/adapter";
import { instrumentAdapter } from "../lib/channels/instrument";

const context = { platform: "FACEBOOK" as const, accountExternalId: "page_1", accessToken: "t" };
const scope = { workspaceId: "ws_1", accountId: "acct_1", source: "api" as const };

function adapter(send: ChannelAdapter["messaging"]["send"], confirmed: boolean): ChannelAdapter {
  return {
    platform: "FACEBOOK",
    errors: { isConfirmedRejection: () => confirmed },
    messaging: { send, publicReply: vi.fn(), followStatus: vi.fn(), username: vi.fn() },
  } as unknown as ChannelAdapter;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
  mockRecordUsage.mockResolvedValue(undefined);
});

describe("dm.sent", () => {
  it("names the account, recipient, message and who asked, keyed on the platform's message id", async () => {
    const wrapped = instrumentAdapter(adapter(vi.fn(async () => ({ messageId: "mid_9" })), false), scope);
    await wrapped.messaging.send(context, {
      to: { kind: "user", userId: "psid_1" },
      content: { kind: "buttons", text: "Book here", buttons: [] },
    });
    expect(mockEmit).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      type: "dm.sent",
      dedupeKey: "acct_1:mid_9",
      data: {
        account: { id: "acct_1", platform: "FACEBOOK" },
        recipient: { id: "psid_1" },
        message: { id: "mid_9", kind: "buttons", text: "Book here" },
        source: "api",
      },
    });
  });
});

describe("dm.failed", () => {
  it("says rejected when the platform refused, without its error text", async () => {
    const wrapped = instrumentAdapter(
      adapter(vi.fn(async () => {
        throw new Error("(#10) This message is sent outside of allowed window. page token EAAB...");
      }), true),
      scope
    );
    await expect(
      wrapped.messaging.send(context, { to: { kind: "comment", commentId: "c_1" }, content: { kind: "text", text: "hi" } })
    ).rejects.toThrow();
    const event = mockEmit.mock.calls[0][0];
    expect(event).toMatchObject({ type: "dm.failed", data: { reason: "rejected", recipient: { commentId: "c_1" } } });
    expect(JSON.stringify(event)).not.toContain("EAAB");
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("says unconfirmed when the platform's answer was ambiguous", async () => {
    const wrapped = instrumentAdapter(adapter(vi.fn(async () => {
      throw new Error("socket hang up");
    }), false), scope);
    await expect(
      wrapped.messaging.send(context, { to: { kind: "user", userId: "u" }, content: { kind: "text", text: "hi" } })
    ).rejects.toThrow("socket hang up");
    expect(mockEmit.mock.calls[0][0].data.reason).toBe("unconfirmed");
  });
});
