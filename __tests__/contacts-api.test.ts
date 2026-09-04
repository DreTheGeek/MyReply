import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockContext } = vi.hoisted(() => ({
  mockPrisma: {
    contact: { findMany: vi.fn(), findFirst: vi.fn() },
    contactTag: { findMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    tag: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    instagramAccount: { findFirst: vi.fn() },
  },
  // A box, so a test can swap the caller without re-mocking the module.
  mockContext: {
    current: {
      userId: "user_1",
      workspaceId: "workspace_1",
      role: "OWNER" as "OWNER" | "ADMIN" | "MEMBER",
    } as {
      userId: string;
      workspaceId: string;
      role: "OWNER" | "ADMIN" | "MEMBER";
    } | null,
  },
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: vi.fn(async () => mockContext.current),
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { NextRequest } from "next/server";

import { GET as listContacts } from "../app/api/contacts/route";
import {
  DELETE as removeContactTag,
  POST as addContactTag,
} from "../app/api/contacts/[id]/tags/route";
import {
  DELETE as deleteTag,
  GET as listTags,
  POST as createTag,
} from "../app/api/tags/route";

function contactRow(id: string) {
  return {
    id,
    externalId: "1681657229596137",
    username: "maya.co",
    name: null,
    dmCount: 3,
    lastDmAt: new Date("2026-01-02T00:00:00.000Z"),
    lastSeenAt: new Date("2026-01-03T00:00:00.000Z"),
    instagramAccount: { id: "account_1", username: "kaldr" },
    tags: [{ tag: { id: "tag_1", name: "vip", color: null } }],
  };
}

function getContacts(query = "") {
  return listContacts(
    new NextRequest(`https://myreply.test/api/contacts${query}`)
  );
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function tagRequest(method: "POST" | "DELETE", body: unknown) {
  const request = jsonRequest(
    "https://myreply.test/api/contacts/contact_1/tags",
    method,
    body
  );
  const params = Promise.resolve({ id: "contact_1" });
  return method === "POST"
    ? addContactTag(request, { params })
    : removeContactTag(request, { params });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockContext.current = {
    userId: "user_1",
    workspaceId: "workspace_1",
    role: "OWNER",
  };
  mockPrisma.contact.findMany.mockResolvedValue([contactRow("contact_1")]);
  mockPrisma.contact.findFirst.mockResolvedValue({ id: "contact_1" });
  mockPrisma.contactTag.findMany.mockResolvedValue([]);
  mockPrisma.contactTag.upsert.mockResolvedValue({});
  mockPrisma.contactTag.delete.mockResolvedValue({});
  mockPrisma.tag.findMany.mockResolvedValue([]);
  mockPrisma.tag.findFirst.mockResolvedValue({ id: "tag_1" });
  mockPrisma.tag.upsert.mockResolvedValue({
    id: "tag_1",
    name: "vip",
    color: null,
  });
  mockPrisma.tag.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "account_1" });
});

describe("GET /api/contacts", () => {
  it("rejects a caller with no workspace context", async () => {
    mockContext.current = null;

    const response = await getContacts();

    expect(response.status).toBe(401);
    expect(mockPrisma.contact.findMany).not.toHaveBeenCalled();
  });

  it("scopes the read to the caller's workspace", async () => {
    const response = await getContacts();
    const payload = await response.json();

    expect(mockPrisma.contact.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: "workspace_1",
    });
    expect(payload.data.contacts).toHaveLength(1);
    expect(payload.data.contacts[0]).toMatchObject({
      id: "contact_1",
      username: "maya.co",
      dmCount: 3,
      lastSeenAt: "2026-01-03T00:00:00.000Z",
      tags: [{ id: "tag_1", name: "vip", color: null }],
    });
  });

  it("never returns a contact belonging to another workspace", async () => {
    // The isolation is the where clause, so the assertion is on the query: a
    // foreign workspace id can only reach the caller by being absent from it.
    mockContext.current = {
      userId: "user_2",
      workspaceId: "workspace_2",
      role: "OWNER",
    };
    mockPrisma.contact.findMany.mockResolvedValue([]);

    const response = await getContacts();
    const payload = await response.json();

    expect(mockPrisma.contact.findMany.mock.calls[0][0].where.workspaceId).toBe(
      "workspace_2"
    );
    expect(payload.data.contacts).toEqual([]);
  });

  it("treats the 'all' sentinel as every connected account", async () => {
    const response = await getContacts("?instagramAccountId=all");

    expect(response.status).toBe(200);
    // "all" must not resolve to the most recently connected account, which is
    // what getWorkspaceInstagramAccount would hand back for the send path.
    expect(mockPrisma.instagramAccount.findFirst).not.toHaveBeenCalled();
    expect(
      mockPrisma.contact.findMany.mock.calls[0][0].where
    ).not.toHaveProperty("instagramAccountId");
  });

  it("resolves a named account inside the workspace before filtering on it", async () => {
    await getContacts("?instagramAccountId=account_1");

    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "account_1", workspaceId: "workspace_1" },
    });
    expect(mockPrisma.contact.findMany.mock.calls[0][0].where).toMatchObject({
      instagramAccountId: "account_1",
    });
  });

  it("refuses an account id owned by another workspace", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue(null);

    const response = await getContacts("?instagramAccountId=account_other");

    expect(response.status).toBe(404);
    expect(mockPrisma.contact.findMany).not.toHaveBeenCalled();
  });

  it("scopes the tag filter to the workspace as well as the id", async () => {
    await getContacts("?tagId=tag_other");

    expect(mockPrisma.contact.findMany.mock.calls[0][0].where.tags).toEqual({
      some: { tag: { id: "tag_other", workspaceId: "workspace_1" } },
    });
  });

  it("searches usernames case-insensitively", async () => {
    await getContacts("?search=MAYA");

    expect(mockPrisma.contact.findMany.mock.calls[0][0].where.username).toEqual({
      contains: "MAYA",
      mode: "insensitive",
    });
  });

  it("returns a cursor only when a further page exists", async () => {
    mockPrisma.contact.findMany.mockResolvedValue([
      contactRow("contact_1"),
      contactRow("contact_2"),
      contactRow("contact_3"),
    ]);

    const response = await getContacts("?limit=2");
    const payload = await response.json();

    expect(mockPrisma.contact.findMany.mock.calls[0][0].take).toBe(3);
    expect(payload.data.contacts).toHaveLength(2);
    expect(payload.data.pagination).toMatchObject({
      hasMore: true,
      nextCursor: "contact_2",
    });
  });

  it("skips the cursor row so a page is not repeated", async () => {
    await getContacts("?cursor=contact_1");

    const args = mockPrisma.contact.findMany.mock.calls[0][0];
    expect(args.cursor).toEqual({ id: "contact_1" });
    expect(args.skip).toBe(1);
  });
});

describe("POST and DELETE /api/contacts/[id]/tags", () => {
  it("applies a tag when the contact and the tag are both in the workspace", async () => {
    const response = await tagRequest("POST", { tagId: "tag_1" });

    expect(response.status).toBe(200);
    expect(mockPrisma.contactTag.upsert).toHaveBeenCalledWith({
      where: { contactId_tagId: { contactId: "contact_1", tagId: "tag_1" } },
      create: { contactId: "contact_1", tagId: "tag_1" },
      update: {},
    });
  });

  it("refuses a tag that belongs to another workspace", async () => {
    // The tag id exists, just not here. Writing it would let one tenant label
    // its own contact with another tenant's tag.
    mockPrisma.tag.findFirst.mockResolvedValue(null);

    const response = await tagRequest("POST", { tagId: "tag_other" });

    expect(response.status).toBe(404);
    expect(mockPrisma.tag.findFirst).toHaveBeenCalledWith({
      where: { id: "tag_other", workspaceId: "workspace_1" },
      select: { id: true },
    });
    expect(mockPrisma.contactTag.upsert).not.toHaveBeenCalled();
  });

  it("refuses a contact that belongs to another workspace", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue(null);

    const response = await tagRequest("POST", { tagId: "tag_1" });

    expect(response.status).toBe(404);
    expect(mockPrisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: "contact_1", workspaceId: "workspace_1" },
      select: { id: true },
    });
    expect(mockPrisma.tag.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.upsert).not.toHaveBeenCalled();
  });

  it("rejects a body with no tag id", async () => {
    const response = await tagRequest("POST", {});

    expect(response.status).toBe(400);
    expect(mockPrisma.contactTag.upsert).not.toHaveBeenCalled();
  });

  it("removes a tag from a contact in the workspace", async () => {
    const response = await tagRequest("DELETE", { tagId: "tag_1" });

    expect(response.status).toBe(200);
    expect(mockPrisma.contactTag.delete).toHaveBeenCalledWith({
      where: { contactId_tagId: { contactId: "contact_1", tagId: "tag_1" } },
    });
  });

  it("blocks a member from tagging or untagging", async () => {
    mockContext.current = {
      userId: "user_1",
      workspaceId: "workspace_1",
      role: "MEMBER",
    };

    const added = await tagRequest("POST", { tagId: "tag_1" });
    const removed = await tagRequest("DELETE", { tagId: "tag_1" });

    expect(added.status).toBe(403);
    expect(removed.status).toBe(403);
    expect(mockPrisma.contact.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.delete).not.toHaveBeenCalled();
  });
});

describe("/api/tags", () => {
  it("lists only the workspace's tags, with a contact count", async () => {
    mockPrisma.tag.findMany.mockResolvedValue([
      { id: "tag_1", name: "vip", color: null, _count: { contacts: 4 } },
    ]);

    const response = await listTags();
    const payload = await response.json();

    expect(mockPrisma.tag.findMany.mock.calls[0][0].where).toEqual({
      workspaceId: "workspace_1",
    });
    expect(payload.data.tags).toEqual([
      { id: "tag_1", name: "vip", color: null, contactCount: 4 },
    ]);
  });

  it("creates a tag in the caller's workspace", async () => {
    const response = await createTag(
      jsonRequest("https://myreply.test/api/tags", "POST", { name: "  vip " })
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.tag.upsert.mock.calls[0][0].where).toEqual({
      workspaceId_name: { workspaceId: "workspace_1", name: "vip" },
    });
  });

  it("rejects a colour that is not a hex value", async () => {
    const response = await createTag(
      jsonRequest("https://myreply.test/api/tags", "POST", {
        name: "vip",
        color: "javascript:alert(1)",
      })
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.tag.upsert).not.toHaveBeenCalled();
  });

  it("deletes only inside the workspace", async () => {
    const response = await deleteTag(
      jsonRequest("https://myreply.test/api/tags", "DELETE", { id: "tag_1" })
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.tag.deleteMany).toHaveBeenCalledWith({
      where: { id: "tag_1", workspaceId: "workspace_1" },
    });
  });

  it("reports a tag from another workspace as missing rather than deleting it", async () => {
    mockPrisma.tag.deleteMany.mockResolvedValue({ count: 0 });

    const response = await deleteTag(
      jsonRequest("https://myreply.test/api/tags", "DELETE", { id: "tag_other" })
    );

    expect(response.status).toBe(404);
  });

  it("blocks a member from creating or deleting tags", async () => {
    mockContext.current = {
      userId: "user_1",
      workspaceId: "workspace_1",
      role: "MEMBER",
    };

    const created = await createTag(
      jsonRequest("https://myreply.test/api/tags", "POST", { name: "vip" })
    );
    const deleted = await deleteTag(
      jsonRequest("https://myreply.test/api/tags", "DELETE", { id: "tag_1" })
    );

    expect(created.status).toBe(403);
    expect(deleted.status).toBe(403);
    expect(mockPrisma.tag.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.tag.deleteMany).not.toHaveBeenCalled();
  });
});
