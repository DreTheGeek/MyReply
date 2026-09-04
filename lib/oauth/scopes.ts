import type { WorkspaceRole } from "@/app/generated/prisma/client";
import { canManageWorkspace } from "@/lib/roles";

/**
 * Two scopes, mapped onto the role ladder that already exists.
 *
 * A scope never grants anything. It only takes access away from what the
 * signed-in person already had: `mcp:write` lets a token use the write tools
 * *if* the member's own role allows writes, and a token without it is read only
 * no matter whose account it belongs to. That is why narrowRoleForScopes can
 * only ever move a role down.
 */

export const SCOPE_READ = "mcp:read";
export const SCOPE_WRITE = "mcp:write";

export const SUPPORTED_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_WRITE];

/** What a client gets when it asks for nothing in particular. */
export const DEFAULT_SCOPE = `${SCOPE_READ} ${SCOPE_WRITE}`;

/** Plain language, for the consent screen. No OAuth vocabulary. */
export const SCOPE_COPY: Record<string, { title: string; detail: string }> = {
  [SCOPE_READ]: {
    title: "Read your campaigns and results",
    detail:
      "See connected Instagram accounts, campaigns and their keywords, DM delivery logs and click-through numbers.",
  },
  [SCOPE_WRITE]: {
    title: "Create and change campaigns",
    detail:
      "Add new comment-to-DM campaigns, edit the message they send, change keywords, and pause or resume them.",
  },
};

export function parseScope(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/\s+/)) {
    if (part) seen.add(part);
  }
  return [...seen];
}

export function serializeScope(scopes: readonly string[]): string {
  return scopes.join(" ");
}

export function isSupportedScope(scope: string): boolean {
  return SUPPORTED_SCOPES.includes(scope);
}

/** The scopes in `requested` that are both supported and allowed to this client. */
export function intersectScopes(
  requested: readonly string[],
  allowed: readonly string[]
): string[] {
  return requested.filter(
    (scope) => isSupportedScope(scope) && allowed.includes(scope)
  );
}

/**
 * The role a token acts with: the member's real role, narrowed by scope.
 *
 * Without `mcp:write` every role collapses to MEMBER, which is the role the
 * existing gate in lib/mcp/tools.ts already refuses writes to. With it, the
 * role is passed through unchanged, so a MEMBER stays a MEMBER and a client
 * cannot ask its way past the role ladder.
 */
export function narrowRoleForScopes(
  role: WorkspaceRole,
  scopes: readonly string[]
): WorkspaceRole {
  if (scopes.includes(SCOPE_WRITE) && canManageWorkspace(role)) {
    return role;
  }
  return "MEMBER";
}
