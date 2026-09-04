import type { Contact } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Resolve a platform user id to a Contact, creating it on first sight.
 *
 * Called on the send path, so it must never throw a send away: a contact is
 * bookkeeping, and failing to record one is not a reason to withhold a DM the
 * recipient asked for. Callers get null on failure and carry on.
 *
 * Scoped to the connected account rather than the workspace, matching the
 * unique constraint. The same person messaging two of an agency's clients is
 * two contacts, because the platform ids are per-account.
 */
export async function upsertContact(params: {
  workspaceId: string;
  instagramAccountId: string;
  externalId: string;
  username?: string | null;
}): Promise<Contact | null> {
  const { workspaceId, instagramAccountId, externalId, username } = params;
  if (!externalId) return null;

  const now = new Date();

  try {
    return await prisma.contact.upsert({
      where: {
        instagramAccountId_externalId: { instagramAccountId, externalId },
      },
      create: {
        workspaceId,
        instagramAccountId,
        externalId,
        username: username ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        lastSeenAt: now,
        // Only overwrite a known username, never blank one that is already
        // stored: some events carry the handle and others do not.
        ...(username ? { username } : {}),
      },
    });
  } catch {
    return null;
  }
}

/**
 * Record that a DM went out to this contact. Separate from upsertContact so
 * the counter only moves on an actual send, not on every event seen.
 */
export async function recordContactDm(contactId: string): Promise<void> {
  try {
    await prisma.contact.update({
      where: { id: contactId },
      data: { dmCount: { increment: 1 }, lastDmAt: new Date() },
    });
  } catch {
    // Bookkeeping only. A failed counter must not fail the job.
  }
}

export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Create a tag, or return the existing one with that name. Names are unique
 * per workspace and compared after whitespace normalisation, so "vip" and
 * "vip " do not become two tags.
 */
export async function ensureTag(params: {
  workspaceId: string;
  name: string;
  color?: string | null;
}): Promise<{ id: string; name: string; color: string | null }> {
  const name = normalizeTagName(params.name);

  return prisma.tag.upsert({
    where: { workspaceId_name: { workspaceId: params.workspaceId, name } },
    create: { workspaceId: params.workspaceId, name, color: params.color ?? null },
    update: params.color !== undefined ? { color: params.color } : {},
    select: { id: true, name: true, color: true },
  });
}

/**
 * Apply a tag to a contact. Idempotent: tagging twice is not an error, and
 * the original createdAt is preserved so "tagged in the last 7 days" stays
 * truthful.
 */
export async function tagContact(
  contactId: string,
  tagId: string
): Promise<void> {
  await prisma.contactTag.upsert({
    where: { contactId_tagId: { contactId, tagId } },
    create: { contactId, tagId },
    update: {},
  });
}

export async function untagContact(
  contactId: string,
  tagId: string
): Promise<void> {
  await prisma.contactTag
    .delete({ where: { contactId_tagId: { contactId, tagId } } })
    .catch(() => {
      // Removing a tag that is not applied is a no-op, not a failure.
    });
}
