import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    contact: { upsert: vi.fn(), update: vi.fn() },
    tag: { upsert: vi.fn() },
    contactTag: { upsert: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  ensureTag,
  normalizeTagName,
  recordContactDm,
  tagContact,
  untagContact,
  upsertContact,
} from "../lib/contacts";

const BASE = {
  workspaceId: "ws_1",
  instagramAccountId: "acct_1",
  externalId: "1681657229596137",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.contact.upsert.mockResolvedValue({ id: "contact_1" });
  mockPrisma.contact.update.mockResolvedValue({});
  mockPrisma.contactTag.upsert.mockResolvedValue({});
  mockPrisma.contactTag.delete.mockResolvedValue({});
});

describe("upsertContact", () => {
  it("keys on the account and external id, not the workspace", async () => {
    await upsertContact(BASE);
    const args = mockPrisma.contact.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      instagramAccountId_externalId: {
        instagramAccountId: "acct_1",
        externalId: "1681657229596137",
      },
    });
  });

  it("stores the username when one is known", async () => {
    await upsertContact({ ...BASE, username: "maya.co" });
    const args = mockPrisma.contact.upsert.mock.calls[0][0];
    expect(args.create.username).toBe("maya.co");
    expect(args.update.username).toBe("maya.co");
  });

  it("does not blank an existing username when the event carries none", async () => {
    // Comment events carry a handle; message events often do not. The second
    // must not erase what the first learned.
    await upsertContact(BASE);
    const args = mockPrisma.contact.upsert.mock.calls[0][0];
    expect(args.update).not.toHaveProperty("username");
    expect(args.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it("returns null rather than throwing when the write fails", async () => {
    // This runs on the send path. Losing a contact record must never cost the
    // recipient their DM.
    mockPrisma.contact.upsert.mockRejectedValue(new Error("db down"));
    await expect(upsertContact(BASE)).resolves.toBeNull();
  });

  it("refuses an empty external id instead of creating a junk row", async () => {
    await expect(upsertContact({ ...BASE, externalId: "" })).resolves.toBeNull();
    expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
  });
});

describe("recordContactDm", () => {
  it("increments the counter and stamps the time", async () => {
    await recordContactDm("contact_1");
    expect(mockPrisma.contact.update).toHaveBeenCalledWith({
      where: { id: "contact_1" },
      data: { dmCount: { increment: 1 }, lastDmAt: expect.any(Date) },
    });
  });

  it("swallows a failure, because it is bookkeeping", async () => {
    mockPrisma.contact.update.mockRejectedValue(new Error("db down"));
    await expect(recordContactDm("contact_1")).resolves.toBeUndefined();
  });
});

describe("tags", () => {
  it("normalises whitespace so 'vip ' and 'vip' are one tag", () => {
    expect(normalizeTagName("  vip  ")).toBe("vip");
    expect(normalizeTagName("high   value")).toBe("high value");
  });

  it("upserts by workspace and normalised name", async () => {
    mockPrisma.tag.upsert.mockResolvedValue({
      id: "tag_1",
      name: "vip",
      color: null,
    });
    await ensureTag({ workspaceId: "ws_1", name: "  vip " });
    const args = mockPrisma.tag.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      workspaceId_name: { workspaceId: "ws_1", name: "vip" },
    });
    expect(args.create.name).toBe("vip");
  });

  it("leaves the colour alone when none is supplied", async () => {
    mockPrisma.tag.upsert.mockResolvedValue({ id: "t", name: "vip", color: "#0b7c90" });
    await ensureTag({ workspaceId: "ws_1", name: "vip" });
    expect(mockPrisma.tag.upsert.mock.calls[0][0].update).toEqual({});
  });

  it("tagging twice is idempotent and preserves the original timestamp", async () => {
    await tagContact("contact_1", "tag_1");
    const args = mockPrisma.contactTag.upsert.mock.calls[0][0];
    expect(args.update).toEqual({});
  });

  it("removing a tag that is not applied is not an error", async () => {
    mockPrisma.contactTag.delete.mockRejectedValue(new Error("not found"));
    await expect(untagContact("contact_1", "tag_1")).resolves.toBeUndefined();
  });
});
