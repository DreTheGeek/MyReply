import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { canManageWorkspace } from "@/lib/roles";

/**
 * One scope list for every machine surface: workspace API keys, partner keys,
 * the REST API and MCP. A scope never grants anything on its own. It narrows
 * what the credential's role already allows, so a key can only ever be
 * trimmed below its role, never lifted above it.
 *
 * A leaf module on purpose, like lib/roles: the routes, the MCP tools, the key
 * settings screen and the tests all read the same list.
 */

export const API_SCOPES = [
  "accounts:read",
  "accounts:write",
  "campaigns:read",
  "campaigns:write",
  "conversations:read",
  "messages:send",
  "contacts:read",
  "usage:read",
  "webhooks:read",
  "webhooks:write",
  // Partner keys only: making, reading and removing the partner's own
  // workspaces, and minting their connect links.
  "workspaces:read",
  "workspaces:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/** What each scope allows, in plain words, for the settings screen and the docs. */
export const API_SCOPE_COPY: Record<ApiScope, string> = {
  "accounts:read": "See connected accounts and whether each one is working.",
  "accounts:write": "Disconnect an account.",
  "campaigns:read": "See campaigns, their settings, results and delivery log.",
  "campaigns:write": "Create, change, pause and delete campaigns.",
  "conversations:read": "Read conversations and their messages.",
  "messages:send": "Send a message to someone who wrote in the last 24 hours.",
  "contacts:read": "See contacts, with the details they chose to share.",
  "usage:read": "See messages sent, replies written and what they cost.",
  "webhooks:read": "See webhook endpoints and their delivery log.",
  "webhooks:write": "Add, change and remove webhook endpoints.",
  "workspaces:read": "See the workspaces this app created.",
  "workspaces:write": "Create and remove workspaces, and make connect links.",
};

const PARTNER_ONLY: ReadonlySet<ApiScope> = new Set(["workspaces:read", "workspaces:write"]);

/** Every scope a workspace credential could ever hold. */
export const WORKSPACE_SCOPES: readonly ApiScope[] = API_SCOPES.filter(
  (scope) => !PARTNER_ONLY.has(scope)
);

/** The read half, which is all a MEMBER may use. */
export const READ_SCOPES: readonly ApiScope[] = WORKSPACE_SCOPES.filter((scope) =>
  scope.endsWith(":read")
);

/** Every scope, for a partner key acting on one of its own workspaces. */
export const PARTNER_SCOPES: readonly ApiScope[] = API_SCOPES;

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** The most a role may hold. A MEMBER reads; an admin or owner does everything in the workspace. */
export function scopeCeilingForRole(role: WorkspaceRole): readonly ApiScope[] {
  return canManageWorkspace(role) ? WORKSPACE_SCOPES : READ_SCOPES;
}

/**
 * The scopes a credential acts with: what was granted, cut to what the
 * ceiling allows. An empty grant means "everything the ceiling allows", which
 * is how every key made before scopes existed keeps working unchanged.
 */
export function effectiveScopes(
  granted: readonly string[],
  ceiling: readonly ApiScope[]
): ApiScope[] {
  if (granted.length === 0) return [...ceiling];
  return ceiling.filter((scope) => granted.includes(scope));
}

/** Unknown or duplicate entries dropped, in the list's own order. */
export function normalizeScopes(requested: readonly string[]): ApiScope[] {
  return API_SCOPES.filter((scope) => requested.includes(scope));
}

export function hasScope(scopes: readonly ApiScope[], scope: ApiScope): boolean {
  return scopes.includes(scope);
}
