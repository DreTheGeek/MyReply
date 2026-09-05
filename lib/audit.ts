import { prisma } from "@/lib/db/client";

/**
 * A record of who destroyed what.
 *
 * `OperationalEvent` is the audit table and it had no destructive writers at
 * all. Deleting a campaign, removing a member, revoking an invitation,
 * deleting a knowledge source or a tag or an AI credential all left nothing
 * behind. Only the API key revoke stamped a `revokedAt`, so the *when*
 * survived and the *who* did not.
 *
 * That matters most for campaign deletion, which cascades its DmLog rows: the
 * delete destroys the delivery evidence for every DM that campaign ever sent,
 * which is exactly the record you would need to show Meta that the account
 * behaved.
 *
 * Written with `resolvedAt` set, because an audit entry is a fact rather than
 * an incident. The diagnostics page reads unresolved events, and filling it
 * with routine deletions would bury the failures it exists to surface.
 */
export type AuditAction =
  | "campaign.deleted"
  | "instagram_account.disconnected"
  | "member.removed"
  | "invitation.revoked"
  | "knowledge_source.deleted"
  | "tag.deleted"
  | "ai_credential.deleted"
  | "api_key.revoked";

export interface AuditEntry {
  workspaceId: string;
  action: AuditAction;
  /** Null for an API-key caller, which has no user behind it. */
  actorUserId?: string | null;
  /** The thing that was destroyed. */
  targetId?: string | null;
  /** Anything else worth having later. Never a secret. */
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * Never throws.
 *
 * By the time this is called the destructive work has already committed. A
 * failure here must not turn a successful delete into an error response,
 * because the caller would retry something that already happened. It is logged
 * and swallowed on purpose.
 */
export async function recordAuditEvent(entry: AuditEntry): Promise<void> {
  try {
    await prisma.operationalEvent.create({
      data: {
        workspaceId: entry.workspaceId,
        source: "SYSTEM",
        level: "INFO",
        message: entry.action,
        payload: {
          actorUserId: entry.actorUserId || null,
          targetId: entry.targetId ?? null,
          ...(entry.detail ?? {}),
        },
        resolvedAt: new Date(),
      },
    });
  } catch (error) {
    console.error(`Failed to record audit event ${entry.action}`, error);
  }
}
