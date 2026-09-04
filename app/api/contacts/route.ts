import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export interface ContactTagSummary {
  id: string;
  name: string;
  color: string | null;
}

export interface ContactListItem {
  id: string;
  externalId: string;
  username: string | null;
  name: string | null;
  dmCount: number;
  lastDmAt: string | null;
  lastSeenAt: string;
  instagramAccount: { id: string; username: string };
  tags: ContactTagSummary[];
}

export interface ContactsResponse {
  contacts: ContactListItem[];
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(
      1,
      Number.parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) ||
        DEFAULT_LIMIT
    )
  );
  const cursor = searchParams.get("cursor");
  const tagId = searchParams.get("tagId");
  const search = searchParams.get("search")?.trim() ?? "";
  const requestedAccountId = searchParams.get("instagramAccountId");

  // "all" (and no value at all) means every account in the workspace. A named
  // account is resolved through the workspace-scoped lookup first, so an id
  // belonging to another tenant is a 404 rather than a filter we honour.
  let instagramAccountId: string | null = null;
  if (requestedAccountId && requestedAccountId !== "all") {
    const account = await getWorkspaceInstagramAccount(
      context.workspaceId,
      requestedAccountId
    );
    if (!account) {
      return NextResponse.json(
        { success: false, error: "Instagram account not found" },
        { status: 404 }
      );
    }
    instagramAccountId = account.id;
  }

  const where = {
    workspaceId: context.workspaceId,
    ...(instagramAccountId ? { instagramAccountId } : {}),
    // The tag is matched on its own workspace too, so a tag id from another
    // tenant cannot be probed for existence through this filter.
    ...(tagId
      ? { tags: { some: { tag: { id: tagId, workspaceId: context.workspaceId } } } }
      : {}),
    ...(search
      ? { username: { contains: search, mode: "insensitive" as const } }
      : {}),
  };

  // One row past the page tells us whether a next cursor exists without a
  // second count query.
  const rows = await prisma.contact.findMany({
    where,
    orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      externalId: true,
      username: true,
      name: true,
      dmCount: true,
      lastDmAt: true,
      lastSeenAt: true,
      instagramAccount: { select: { id: true, username: true } },
      tags: {
        select: { tag: { select: { id: true, name: true, color: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const contacts: ContactListItem[] = page.map((row) => ({
    id: row.id,
    externalId: row.externalId,
    username: row.username,
    name: row.name,
    dmCount: row.dmCount,
    lastDmAt: row.lastDmAt ? row.lastDmAt.toISOString() : null,
    lastSeenAt: row.lastSeenAt.toISOString(),
    instagramAccount: row.instagramAccount,
    tags: row.tags.map((link) => link.tag),
  }));

  const data: ContactsResponse = {
    contacts,
    pagination: {
      limit,
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
      hasMore,
    },
  };

  return NextResponse.json({ success: true, data });
}
