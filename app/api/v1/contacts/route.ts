import { z } from "zod";
import { v1Data, v1Error, v1Route } from "@/lib/api/v1";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(100).nullable().default(null),
  accountId: z.string().min(1).max(100).nullable().default(null),
  /** Only people who shared an email or phone number. */
  captured: z.enum(["true", "false"]).nullable().default(null),
});

/**
 * The people this workspace's accounts have talked to, newest first, with any
 * email or phone number they chose to share and the exact wording they agreed
 * to when they did.
 */
export const GET = v1Route("contacts:read", async (request, caller) => {
  const search = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    limit: search.get("limit") ?? undefined,
    cursor: search.get("cursor"),
    accountId: search.get("accountId"),
    captured: search.get("captured"),
  });
  if (!parsed.success) return v1Error("limit must be 1 to 100, and captured true or false.");
  const query = parsed.data;

  const rows = await prisma.contact.findMany({
    where: {
      workspaceId: caller.workspaceId,
      ...(query.accountId ? { instagramAccountId: query.accountId } : {}),
      ...(query.captured === "true" ? { OR: [{ email: { not: null } }, { phone: { not: null } }] } : {}),
    },
    orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      instagramAccountId: true,
      externalId: true,
      username: true,
      name: true,
      email: true,
      phone: true,
      optedOutAt: true,
      firstSeenAt: true,
      lastSeenAt: true,
      lastInboundAt: true,
      dmCount: true,
      consents: {
        orderBy: { consentedAt: "desc" },
        take: 10,
        select: { kind: true, value: true, consentText: true, consentedAt: true, automationId: true },
      },
    },
  });

  const page = rows.slice(0, query.limit);
  return v1Data({
    contacts: page.map((row) => ({
      id: row.id,
      accountId: row.instagramAccountId,
      externalId: row.externalId,
      username: row.username,
      name: row.name,
      email: row.email,
      phone: row.phone,
      optedOut: row.optedOutAt !== null,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      lastMessagedUsAt: row.lastInboundAt?.toISOString() ?? null,
      messagesSent: row.dmCount,
      consents: row.consents.map((consent) => ({
        kind: consent.kind.toLowerCase(),
        value: consent.value,
        wording: consent.consentText,
        at: consent.consentedAt.toISOString(),
        campaignId: consent.automationId,
      })),
    })),
    nextCursor: rows.length > query.limit ? (page[page.length - 1]?.id ?? null) : null,
  });
});
