import { z } from "zod";
import { API_SCOPE_COPY, type ApiScope } from "@/lib/api/scopes";
import {
  createAutomationSchema,
  importCampaignsSchema,
  updateAutomationSchema,
} from "@/lib/campaigns/schemas";
import { apiSendSchema } from "@/lib/messaging/api-send";
import {
  connectLinkSchema,
  createWorkspaceSchema,
  inboxLinkSchema,
  updateWorkspaceSchema,
} from "@/lib/partners/workspaces";
import { createEndpointSchema, updateEndpointSchema } from "@/lib/webhooks/endpoints";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_COPY } from "@/lib/webhooks/events";

/**
 * The OpenAPI 3.1 document for /api/v1.
 *
 * Request bodies are generated from the same Zod schemas the routes validate
 * with, so the document cannot describe a field the API would refuse. A test
 * walks app/api/v1 and fails when a route and this document disagree about
 * which paths and methods exist.
 */

type JsonSchema = Record<string, unknown>;

function schemaOf(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  delete json.$schema;
  return json;
}

interface QueryParam {
  name: string;
  description: string;
  required?: boolean;
}

interface Operation {
  path: string;
  method: "get" | "post" | "patch" | "delete";
  summary: string;
  description?: string;
  /** Who may call it: a workspace or partner key inside a workspace, or a partner key on its own. */
  auth: "workspace" | "partner" | "public";
  scope: ApiScope | null;
  body?: z.ZodType;
  query?: QueryParam[];
  idempotency?: "optional" | "required";
  success?: number;
}

const page: QueryParam[] = [
  { name: "limit", description: "1 to 100, default 25." },
  { name: "cursor", description: "The nextCursor from the previous page." },
];
const range: QueryParam[] = [
  { name: "from", description: "First UTC day, YYYY-MM-DD. Defaults to the first of this month." },
  { name: "to", description: "Last UTC day, inclusive, YYYY-MM-DD. Defaults to today." },
];
const accountParam: QueryParam = { name: "accountId", description: "The connected account to read.", required: true };

const idBody = z.object({ id: z.string().min(1) }).strict();

const OPERATIONS: Operation[] = [
  // The workspace this credential acts in.
  { path: "/workspace", method: "get", auth: "workspace", scope: null, summary: "This workspace, its accounts and how each is doing" },

  // Partner apps.
  { path: "/workspaces", method: "get", auth: "partner", scope: "workspaces:read", summary: "List your workspaces", query: [...page, { name: "externalId", description: "Find the workspace made for one of your users." }] },
  { path: "/workspaces", method: "post", auth: "partner", scope: "workspaces:write", summary: "Create a workspace for one of your users", description: "Sending an externalId you already used returns that workspace with 200 instead of creating another.", body: createWorkspaceSchema, idempotency: "optional", success: 201 },
  { path: "/workspaces/{id}", method: "get", auth: "partner", scope: "workspaces:read", summary: "A workspace's status: connected accounts and campaigns" },
  { path: "/workspaces/{id}", method: "patch", auth: "partner", scope: "workspaces:write", summary: "Rename a workspace, or change its externalId or timezone", body: updateWorkspaceSchema, idempotency: "optional" },
  { path: "/workspaces/{id}", method: "delete", auth: "partner", scope: "workspaces:write", summary: "Delete a workspace and everything under it", description: "Recorded in the audit log.", idempotency: "optional" },
  { path: "/workspaces/{id}/connect-links", method: "post", auth: "partner", scope: "workspaces:write", summary: "A signed link to the hosted Connect your accounts page", description: "When the person finishes they land on returnUrl with connect_status (connected, denied, failed, forbidden, already_connected, plan_limit, none_granted, unavailable), platform and workspace_id added. returnUrl must be on an origin set up for you in advance. sendTo emails the link from your own sender address, once that is set up.", body: connectLinkSchema, idempotency: "optional", success: 201 },
  { path: "/workspaces/{id}/inbox-links", method: "post", auth: "partner", scope: "workspaces:write", summary: "A signed link to the hosted inbox", description: "Conversations on every connected account, with a reply box. Anyone holding the link can read and reply until it expires (default 60 minutes, at most 720), so mint it for the workspace's owner, when they open it. sendTo emails it from your own sender address.", body: inboxLinkSchema, idempotency: "optional", success: 201 },
  { path: "/workspaces/usage", method: "get", auth: "partner", scope: "workspaces:read", summary: "Usage for every one of your workspaces", query: range },
  { path: "/partner/webhooks", method: "get", auth: "partner", scope: "webhooks:read", summary: "Your endpoints, which hear all of your workspaces" },
  { path: "/partner/webhooks", method: "post", auth: "partner", scope: "webhooks:write", summary: "Add an endpoint for all of your workspaces", description: "The answer carries the signing secret, shown this once.", body: createEndpointSchema, idempotency: "optional", success: 201 },
  { path: "/partner/webhooks/{id}", method: "patch", auth: "partner", scope: "webhooks:write", summary: "Change or switch off an endpoint", body: updateEndpointSchema, idempotency: "optional" },
  { path: "/partner/webhooks/{id}", method: "delete", auth: "partner", scope: "webhooks:write", summary: "Remove an endpoint", idempotency: "optional" },
  { path: "/partner/webhooks/{id}/deliveries", method: "get", auth: "partner", scope: "webhooks:read", summary: "An endpoint's delivery log", query: page },

  // Inside one workspace.
  { path: "/accounts", method: "get", auth: "workspace", scope: "accounts:read", summary: "Connected accounts" },
  { path: "/accounts/{id}", method: "delete", auth: "workspace", scope: "accounts:write", summary: "Disconnect an account, with its campaigns and history", idempotency: "optional" },
  { path: "/campaigns", method: "get", auth: "workspace", scope: "campaigns:read", summary: "List campaigns", query: [{ name: "instagramAccountId", description: "Only one account's campaigns." }] },
  { path: "/campaigns", method: "post", auth: "workspace", scope: "campaigns:write", summary: "Create a campaign", description: "Placeholders in dmMessage: {username} and {link}.", body: createAutomationSchema, idempotency: "optional" },
  { path: "/campaigns", method: "patch", auth: "workspace", scope: "campaigns:write", summary: "Change a campaign, by id in the body", description: "Send only the fields to change.", body: updateAutomationSchema.extend({ id: z.string().min(1) }), idempotency: "optional" },
  { path: "/campaigns", method: "delete", auth: "workspace", scope: "campaigns:write", summary: "Delete a campaign, by id in the body", body: idBody, idempotency: "optional" },
  { path: "/campaigns/{id}", method: "get", auth: "workspace", scope: "campaigns:read", summary: "One campaign's complete settings" },
  { path: "/import", method: "post", auth: "workspace", scope: "campaigns:write", summary: "Create up to 200 campaigns at once", description: "Skips a postId that already has a campaign, so a repeat call does not duplicate.", body: importCampaignsSchema, idempotency: "optional" },
  { path: "/logs", method: "get", auth: "workspace", scope: "campaigns:read", summary: "Delivery log, newest first", query: [{ name: "page", description: "Page number, from 1." }, { name: "limit", description: "1 to 50." }, { name: "status", description: "PENDING, SENT, FAILED, SKIPPED_DEDUP, SKIPPED_RATE_LIMIT, SKIPPED_PLAN_LIMIT, SKIPPED_NO_MATCH, SKIPPED_OPTED_OUT or SKIPPED_WINDOW_CLOSED." }, { name: "instagramAccountId", description: "Only one account." }] },
  { path: "/stats", method: "get", auth: "workspace", scope: "campaigns:read", summary: "Campaign performance", query: [{ name: "instagramAccountId", description: "Only one account." }] },
  { path: "/conversations", method: "get", auth: "workspace", scope: "conversations:read", summary: "One account's conversations, newest first", query: [accountParam] },
  { path: "/conversations/{id}/messages", method: "get", auth: "workspace", scope: "conversations:read", summary: "Recent messages in a conversation, oldest first", query: [accountParam] },
  { path: "/messages", method: "post", auth: "workspace", scope: "messages:send", summary: "Send a message to someone who wrote in the last 24 hours", description: "Refused (409) when the window is closed or the person said stop. 201 when sent; 202 with status unconfirmed when the platform's answer was ambiguous and the message may have arrived, in which case do not send it again.", body: apiSendSchema, idempotency: "required", success: 201 },
  { path: "/contacts", method: "get", auth: "workspace", scope: "contacts:read", summary: "Contacts, with shared details and the consent wording", query: [...page, { name: "accountId", description: "Only one account's contacts." }, { name: "captured", description: "true for only people who shared an email or phone." }] },
  { path: "/usage", method: "get", auth: "workspace", scope: "usage:read", summary: "Messages sent, public replies and model replies with their cost", description: "Money is in millionths of a US dollar.", query: range },
  { path: "/webhooks", method: "get", auth: "workspace", scope: "webhooks:read", summary: "This workspace's webhook endpoints" },
  { path: "/webhooks", method: "post", auth: "workspace", scope: "webhooks:write", summary: "Add a webhook endpoint", description: "The answer carries the signing secret, shown this once.", body: createEndpointSchema, idempotency: "optional", success: 201 },
  { path: "/webhooks/{id}", method: "patch", auth: "workspace", scope: "webhooks:write", summary: "Change or switch off an endpoint", body: updateEndpointSchema, idempotency: "optional" },
  { path: "/webhooks/{id}", method: "delete", auth: "workspace", scope: "webhooks:write", summary: "Remove an endpoint", idempotency: "optional" },
  { path: "/webhooks/{id}/deliveries", method: "get", auth: "workspace", scope: "webhooks:read", summary: "An endpoint's delivery log", query: page },

  { path: "/openapi.json", method: "get", auth: "public", scope: null, summary: "This document" },
];

export function documentedOperations(): { path: string; method: string }[] {
  return OPERATIONS.map(({ path, method }) => ({ path, method }));
}

const envelope = (data: JsonSchema = { type: "object" }): JsonSchema => ({
  type: "object",
  properties: { success: { const: true }, data },
  required: ["success", "data"],
});

const errorEnvelope: JsonSchema = {
  type: "object",
  properties: { success: { const: false }, error: { type: "string" } },
  required: ["success", "error"],
};

function operationObject(operation: Operation): JsonSchema {
  const parameters: JsonSchema[] = [];
  for (const name of operation.path.match(/\{(\w+)\}/g) ?? []) {
    parameters.push({ name: name.slice(1, -1), in: "path", required: true, schema: { type: "string" } });
  }
  for (const param of operation.query ?? []) {
    parameters.push({ name: param.name, in: "query", required: param.required ?? false, description: param.description, schema: { type: "string" } });
  }
  if (operation.auth === "workspace") {
    parameters.push({
      name: "X-Workspace-Id",
      in: "header",
      required: false,
      description: "With a partner key: which of your workspaces to act in. Not used with a workspace key.",
      schema: { type: "string" },
    });
  }
  if (operation.idempotency) {
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: operation.idempotency === "required",
      description: "Up to 255 printable characters. A retry with the same key and request gets the first answer back.",
      schema: { type: "string", maxLength: 255 },
    });
  }

  const security =
    operation.auth === "public"
      ? []
      : operation.auth === "partner"
        ? [{ partnerKey: [] }]
        : [{ workspaceKey: [] }, { partnerKey: [] }];

  const scopeLine = operation.scope ? `Needs ${operation.scope}: ${API_SCOPE_COPY[operation.scope]}` : null;

  return {
    summary: operation.summary,
    description: [operation.description, scopeLine].filter(Boolean).join("\n\n") || undefined,
    ...(operation.scope ? { "x-scope": operation.scope } : {}),
    security,
    parameters,
    ...(operation.body
      ? { requestBody: { required: true, content: { "application/json": { schema: schemaOf(operation.body) } } } }
      : {}),
    responses: {
      [String(operation.success ?? 200)]: {
        description: "Done.",
        content: { "application/json": { schema: envelope() } },
      },
      ...(operation.auth === "public"
        ? {}
        : {
            "400": { description: "The request was not valid.", content: { "application/json": { schema: errorEnvelope } } },
            "401": { description: "No valid key.", content: { "application/json": { schema: errorEnvelope } } },
            "403": { description: "The key lacks this scope.", content: { "application/json": { schema: errorEnvelope } } },
            "404": { description: "Not found for this key.", content: { "application/json": { schema: errorEnvelope } } },
            "429": { description: "Over the rate limit. Retry-After says when to try again.", content: { "application/json": { schema: errorEnvelope } } },
          }),
    },
  };
}

export function buildOpenApiDocument(baseUrl: string): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const operation of OPERATIONS) {
    paths[operation.path] ??= {};
    paths[operation.path][operation.method] = operationObject(operation);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Messaging engine API",
      version: "1.0.0",
      description: [
        "Every response is { success, data } or { success: false, error }.",
        "Every key is limited to 120 requests a minute. A partner key is counted per workspace it acts in.",
        "Every write takes an Idempotency-Key.",
        `Webhook events: ${WEBHOOK_EVENTS.map((event) => `${event} (${WEBHOOK_EVENT_COPY[event]})`).join("; ")}`,
        "Webhooks are signed in the Standard Webhooks format: webhook-id, webhook-timestamp and webhook-signature (v1, HMAC-SHA256 of id.timestamp.body).",
      ].join("\n\n"),
    },
    servers: [{ url: `${baseUrl.replace(/\/$/, "")}/api/v1` }],
    components: {
      securitySchemes: {
        workspaceKey: { type: "http", scheme: "bearer", description: "A workspace key, mr_live_..., made in Settings." },
        partnerKey: {
          type: "http",
          scheme: "bearer",
          description: "A partner key, mr_partner_... Inside a workspace, name it in X-Workspace-Id.",
        },
      },
    },
    paths,
  };
}
