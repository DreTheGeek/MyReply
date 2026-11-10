import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { encryptToken } from "@/lib/security/token-crypto";
import { WEBHOOK_EVENTS } from "./events";
import { webhookUrlProblem } from "./send";
import { generateWebhookSecret } from "./signing";

/**
 * Webhook endpoints for one owner: a workspace, or a partner (which hears all
 * of its workspaces). Every read and write is keyed on the owner, so an
 * endpoint id from someone else's account finds nothing.
 */

export type WebhookOwner = { workspaceId: string } | { partnerId: string };

export const MAX_ENDPOINTS_PER_OWNER = 10;

const urlSchema = z
  .string()
  .max(2000)
  .superRefine((value, ctx) => {
    const problem = webhookUrlProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const createEndpointSchema = z
  .object({
    url: urlSchema,
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
    description: z.string().trim().max(200).optional(),
  })
  .strict();

export const updateEndpointSchema = z
  .object({
    url: urlSchema.optional(),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length).optional(),
    description: z.string().trim().max(200).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to change" });

const endpointSelect = {
  id: true,
  url: true,
  description: true,
  events: true,
  secretHint: true,
  consecutiveFailures: true,
  disabledAt: true,
  createdAt: true,
} as const;

export interface EndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  secretHint: string;
  enabled: boolean;
  consecutiveFailures: number;
  createdAt: string;
}

function view(row: {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  secretHint: string;
  consecutiveFailures: number;
  disabledAt: Date | null;
  createdAt: Date;
}): EndpointView {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    secretHint: row.secretHint,
    enabled: row.disabledAt === null,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
  };
}

function ownerWhere(owner: WebhookOwner): { workspaceId: string } | { partnerId: string } {
  return "workspaceId" in owner ? { workspaceId: owner.workspaceId } : { partnerId: owner.partnerId };
}

export async function listEndpoints(owner: WebhookOwner): Promise<EndpointView[]> {
  const rows = await prisma.webhookEndpoint.findMany({
    where: ownerWhere(owner),
    orderBy: { createdAt: "asc" },
    select: endpointSelect,
  });
  return rows.map(view);
}

/** The new endpoint with its secret, which is shown this once and never again. */
export async function createEndpoint(
  owner: WebhookOwner,
  input: z.infer<typeof createEndpointSchema>
): Promise<{ ok: true; endpoint: EndpointView; secret: string } | { ok: false; error: string }> {
  const count = await prisma.webhookEndpoint.count({ where: ownerWhere(owner) });
  if (count >= MAX_ENDPOINTS_PER_OWNER) {
    return { ok: false, error: `At most ${MAX_ENDPOINTS_PER_OWNER} endpoints. Remove one first.` };
  }

  const secret = generateWebhookSecret();
  const row = await prisma.webhookEndpoint.create({
    data: {
      ...ownerWhere(owner),
      url: input.url,
      events: [...new Set(input.events)],
      description: input.description ?? null,
      secretEncrypted: encryptToken(secret),
      secretHint: `${secret.slice(0, 10)}...`,
    },
    select: endpointSelect,
  });
  return { ok: true, endpoint: view(row), secret };
}

export async function updateEndpoint(
  owner: WebhookOwner,
  id: string,
  input: z.infer<typeof updateEndpointSchema>
): Promise<EndpointView | null> {
  const result = await prisma.webhookEndpoint.updateMany({
    where: { id, ...ownerWhere(owner) },
    data: {
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.events !== undefined ? { events: [...new Set(input.events)] } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.enabled === true ? { disabledAt: null, consecutiveFailures: 0 } : {}),
      ...(input.enabled === false ? { disabledAt: new Date() } : {}),
    },
  });
  if (result.count === 0) return null;
  const row = await prisma.webhookEndpoint.findFirst({ where: { id, ...ownerWhere(owner) }, select: endpointSelect });
  return row ? view(row) : null;
}

export async function deleteEndpoint(owner: WebhookOwner, id: string): Promise<boolean> {
  const result = await prisma.webhookEndpoint.deleteMany({ where: { id, ...ownerWhere(owner) } });
  return result.count > 0;
}

export interface DeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  workspaceId: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

/** The endpoint's delivery log, newest first, or null when it is not the owner's. */
export async function listDeliveries(
  owner: WebhookOwner,
  endpointId: string,
  options: { limit: number; cursor: string | null }
): Promise<{ deliveries: DeliveryView[]; nextCursor: string | null } | null> {
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, ...ownerWhere(owner) },
    select: { id: true },
  });
  if (!endpoint) return null;

  const rows = await prisma.webhookDelivery.findMany({
    where: { endpointId: endpoint.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      eventId: true,
      eventType: true,
      workspaceId: true,
      status: true,
      attempts: true,
      lastStatusCode: true,
      lastError: true,
      lastAttemptAt: true,
      deliveredAt: true,
      createdAt: true,
    },
  });
  const page = rows.slice(0, options.limit);
  return {
    deliveries: page.map((row) => ({
      ...row,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: rows.length > options.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}
