import { z } from "zod";
import { Prisma } from "@/app/generated/prisma/client";
import type { ChannelPlatform } from "@/app/generated/prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import {
  MAX_LINK_MINUTES,
  createHostedToken,
  hostedBaseUrl,
  isAllowedReturnUrl,
} from "./links";

/**
 * A partner's workspaces: one per user of the partner's own app.
 *
 * Every read and write here is keyed on the partner id as well as the
 * workspace id, in the same predicate. A partner asking for a workspace it did
 * not create gets exactly what it gets for one that does not exist.
 */

const timezoneSchema = z
  .string()
  .max(64)
  .refine(
    (zone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Unknown timezone" }
  );

export const createWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** The partner's own id for its user. Creating twice with it returns the first. */
    externalId: z.string().trim().min(1).max(200).optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

export const updateWorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    externalId: z.string().trim().min(1).max(200).nullable().optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });

/** Connect platforms a hosted link may offer, lowercase as in the URL. */
export const HOSTED_CONNECT_PLATFORMS = ["instagram", "facebook"] as const;
export type HostedConnectPlatform = (typeof HOSTED_CONNECT_PLATFORMS)[number];

export const connectLinkSchema = z
  .object({
    returnUrl: z.string().url().max(2000),
    platforms: z.array(z.enum(HOSTED_CONNECT_PLATFORMS)).min(1).max(2).optional(),
    expiresInMinutes: z.number().int().min(1).max(MAX_LINK_MINUTES.connect).optional(),
  })
  .strict();

export const inboxLinkSchema = z
  .object({
    expiresInMinutes: z.number().int().min(1).max(MAX_LINK_MINUTES.inbox).optional(),
  })
  .strict();

export type AccountStatus = "connected" | "needs_reconnect" | "events_off";

/**
 * How a connected account is doing, in three states a partner can act on.
 * An erased token (the person removed the app) or an expired one needs the
 * person to connect again; a live token whose event subscription failed still
 * sends but will not hear new comments or messages.
 */
export function accountStatus(
  account: { accessToken: string; tokenExpiresAt: Date | null; webhookSubscribed: boolean },
  now: Date = new Date()
): AccountStatus {
  if (account.accessToken === "") return "needs_reconnect";
  if (account.tokenExpiresAt && account.tokenExpiresAt <= now) return "needs_reconnect";
  if (!account.webhookSubscribed) return "events_off";
  return "connected";
}

export interface PartnerWorkspaceSummary {
  id: string;
  name: string;
  externalId: string | null;
  timezone: string;
  createdAt: string;
}

const summarySelect = {
  id: true,
  name: true,
  externalId: true,
  timezone: true,
  createdAt: true,
} as const;

function toSummary(row: {
  id: string;
  name: string;
  externalId: string | null;
  timezone: string;
  createdAt: Date;
}): PartnerWorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    externalId: row.externalId,
    timezone: row.timezone,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createPartnerWorkspace(
  partnerId: string,
  input: z.infer<typeof createWorkspaceSchema>
): Promise<{ workspace: PartnerWorkspaceSummary; created: boolean }> {
  if (input.externalId) {
    const existing = await prisma.workspace.findFirst({
      where: { partnerId, externalId: input.externalId },
      select: summarySelect,
    });
    if (existing) return { workspace: toSummary(existing), created: false };
  }

  const partner = await prisma.partner.findUnique({
    where: { id: partnerId },
    select: { workspacePlan: true },
  });

  try {
    const row = await prisma.workspace.create({
      data: {
        name: input.name,
        partnerId,
        externalId: input.externalId ?? null,
        plan: partner?.workspacePlan ?? "FREE",
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
      select: summarySelect,
    });
    return { workspace: toSummary(row), created: true };
  } catch (error) {
    // Two creates with the same externalId raced; the loser returns the winner.
    if (
      input.externalId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.workspace.findFirst({
        where: { partnerId, externalId: input.externalId },
        select: summarySelect,
      });
      if (existing) return { workspace: toSummary(existing), created: false };
    }
    throw error;
  }
}

export async function listPartnerWorkspaces(
  partnerId: string,
  options: { limit: number; cursor: string | null; externalId: string | null }
): Promise<{ workspaces: PartnerWorkspaceSummary[]; nextCursor: string | null }> {
  const rows = await prisma.workspace.findMany({
    where: {
      partnerId,
      ...(options.externalId ? { externalId: options.externalId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: summarySelect,
  });
  const page = rows.slice(0, options.limit);
  return {
    workspaces: page.map(toSummary),
    nextCursor: rows.length > options.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export interface WorkspaceStatus extends PartnerWorkspaceSummary {
  accounts: {
    id: string;
    platform: ChannelPlatform;
    username: string;
    name: string | null;
    status: AccountStatus;
    connectedAt: string;
  }[];
  campaigns: { total: number; active: number };
}

/** A workspace's status, or null when it is not this partner's. */
export async function partnerWorkspaceStatus(
  partnerId: string | null,
  workspaceId: string
): Promise<WorkspaceStatus | null> {
  const row = await prisma.workspace.findFirst({
    where: { id: workspaceId, ...(partnerId ? { partnerId } : {}) },
    select: {
      ...summarySelect,
      instagramAccounts: {
        orderBy: { connectedAt: "asc" },
        select: {
          id: true,
          platform: true,
          username: true,
          name: true,
          accessToken: true,
          tokenExpiresAt: true,
          webhookSubscribed: true,
          connectedAt: true,
        },
      },
    },
  });
  if (!row) return null;

  const [total, active] = await Promise.all([
    prisma.automation.count({ where: { workspaceId: row.id } }),
    prisma.automation.count({ where: { workspaceId: row.id, isActive: true } }),
  ]);

  const now = new Date();
  return {
    ...toSummary(row),
    // The token itself is read only to judge its state and never leaves here.
    accounts: row.instagramAccounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      username: account.username,
      name: account.name,
      status: accountStatus(account, now),
      connectedAt: account.connectedAt.toISOString(),
    })),
    campaigns: { total, active },
  };
}

export async function updatePartnerWorkspace(
  partnerId: string,
  workspaceId: string,
  input: z.infer<typeof updateWorkspaceSchema>
): Promise<PartnerWorkspaceSummary | "not_found" | "external_id_taken"> {
  try {
    const result = await prisma.workspace.updateMany({
      where: { id: workspaceId, partnerId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      },
    });
    if (result.count === 0) return "not_found";
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return "external_id_taken";
    }
    throw error;
  }
  const row = await prisma.workspace.findFirst({
    where: { id: workspaceId, partnerId },
    select: summarySelect,
  });
  return row ? toSummary(row) : "not_found";
}

/**
 * Delete a partner's workspace and everything under it. The audit row is
 * written first and survives the delete with its workspace link cleared,
 * carrying the ids in its detail so the record still says what went.
 */
export async function deletePartnerWorkspace(
  partnerId: string,
  workspaceId: string,
  keyId: string
): Promise<boolean> {
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, partnerId },
    select: { id: true, externalId: true },
  });
  if (!workspace) return false;

  await recordAuditEvent({
    workspaceId: workspace.id,
    action: "workspace.deleted",
    actorUserId: null,
    targetId: workspace.id,
    detail: {
      partnerId,
      partnerKeyId: keyId,
      workspaceId: workspace.id,
      externalId: workspace.externalId,
    },
  });

  const result = await prisma.workspace.deleteMany({ where: { id: workspace.id, partnerId } });
  return result.count > 0;
}

export type ConnectLinkResult =
  | { ok: true; url: string; expiresAt: string }
  | { ok: false; status: number; error: string };

/** A signed hosted "connect your accounts" link for one of the partner's workspaces. */
export async function createConnectLink(
  partnerId: string,
  workspaceId: string,
  input: z.infer<typeof connectLinkSchema>
): Promise<ConnectLinkResult> {
  const [workspace, partner] = await Promise.all([
    prisma.workspace.findFirst({ where: { id: workspaceId, partnerId }, select: { id: true } }),
    prisma.partner.findUnique({
      where: { id: partnerId },
      select: { returnOrigins: true, frameOrigins: true, customDomain: true },
    }),
  ]);
  if (!workspace || !partner) {
    return { ok: false, status: 404, error: "That workspace was not found for this key." };
  }

  // The person lands back on this URL with the outcome on it, so only a
  // partner origin set up in advance is accepted. Otherwise a stolen key could
  // mint links that hand people to a lookalike site.
  if (!isAllowedReturnUrl(input.returnUrl, partner.returnOrigins)) {
    return {
      ok: false,
      status: 400,
      error:
        "returnUrl must be https and on one of your allowed return origins. Ask us to add the origin first.",
    };
  }

  const { token, expiresAt } = createHostedToken(
    {
      k: "connect",
      w: workspace.id,
      p: partnerId,
      r: input.returnUrl,
      pl: input.platforms ?? [...HOSTED_CONNECT_PLATFORMS],
      fa: partner.frameOrigins,
    },
    input.expiresInMinutes ?? MAX_LINK_MINUTES.connect
  );

  return {
    ok: true,
    url: `${hostedBaseUrl(partner.customDomain, getBaseUrl())}/hosted/connect/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * A signed link to the hosted inbox for one of the partner's workspaces: the
 * conversations on every connected account, and a reply box. Anyone holding
 * the link can read and reply until it expires, so it is minted for the
 * person who owns the workspace and lasts at most twelve hours.
 */
export async function createInboxLink(
  partnerId: string,
  workspaceId: string,
  input: z.infer<typeof inboxLinkSchema>
): Promise<ConnectLinkResult> {
  const [workspace, partner] = await Promise.all([
    prisma.workspace.findFirst({ where: { id: workspaceId, partnerId }, select: { id: true } }),
    prisma.partner.findUnique({
      where: { id: partnerId },
      select: { frameOrigins: true, customDomain: true },
    }),
  ]);
  if (!workspace || !partner) {
    return { ok: false, status: 404, error: "That workspace was not found for this key." };
  }

  const { token, expiresAt } = createHostedToken(
    { k: "inbox", w: workspace.id, p: partnerId, fa: partner.frameOrigins },
    input.expiresInMinutes ?? 60
  );
  return {
    ok: true,
    url: `${hostedBaseUrl(partner.customDomain, getBaseUrl())}/hosted/inbox/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}
