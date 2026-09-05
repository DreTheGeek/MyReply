import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db/client";
import { toCsv, type CsvColumn } from "@/lib/utils/csv";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

/**
 * Taking your data out.
 *
 * MyReply could import campaigns and had no way to export anything, which is
 * the wrong direction round: every competitor in this category charges for CSV
 * export, and "leave whenever you want" is a more persuasive thing to be able
 * to say than any feature. This is deliberately free and deliberately complete.
 *
 * ROLE. Any member may export. The data is the workspace's own and a member
 * can already read all of it through the UI; making export the one thing that
 * needs an admin would be theatre rather than a control.
 *
 * SIZE. Every dataset is capped and ordered newest first. A workspace with a
 * million DM logs must not turn one click into an out-of-memory event, and a
 * cap with a documented number is more honest than a promise of everything
 * that falls over. The cap is reported in the response headers so a caller can
 * tell a truncated file from a complete one.
 */
export const dynamic = "force-dynamic";

const MAX_ROWS = 50_000;

const querySchema = z.object({
  dataset: z.enum(["contacts", "logs", "campaigns", "links"]),
});

function csvResponse(filename: string, body: string, truncated: boolean) {
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // This is the workspace's own data. It must never sit in a shared cache.
      "Cache-Control": "no-store, private",
      "X-Export-Truncated": truncated ? "true" : "false",
      "X-Export-Max-Rows": String(MAX_ROWS),
    },
  });
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const parsed = querySchema.safeParse({
    dataset: request.nextUrl.searchParams.get("dataset"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Choose a dataset: contacts, logs, campaigns or links.",
      },
      { status: 400 }
    );
  }

  const { workspaceId } = context;
  const { dataset } = parsed.data;

  if (dataset === "contacts") {
    const rows = await prisma.contact.findMany({
      where: { workspaceId },
      orderBy: { lastSeenAt: "desc" },
      take: MAX_ROWS,
      select: {
        externalId: true,
        username: true,
        name: true,
        firstSeenAt: true,
        lastSeenAt: true,
        dmCount: true,
        lastDmAt: true,
        optedOutAt: true,
        instagramAccount: { select: { username: true } },
      },
    });

    const columns: CsvColumn<(typeof rows)[number]>[] = [
      { header: "Instagram ID", value: (r) => r.externalId },
      { header: "Username", value: (r) => r.username },
      { header: "Name", value: (r) => r.name },
      { header: "Account", value: (r) => r.instagramAccount?.username ?? null },
      { header: "First seen", value: (r) => r.firstSeenAt.toISOString() },
      { header: "Last seen", value: (r) => r.lastSeenAt.toISOString() },
      { header: "DMs received", value: (r) => r.dmCount },
      { header: "Last DM", value: (r) => r.lastDmAt?.toISOString() ?? null },
      {
        header: "Opted out",
        value: (r) => r.optedOutAt?.toISOString() ?? null,
      },
    ];

    await recordAuditEvent({
      workspaceId,
      action: "data.exported",
      actorUserId: context.userId,
      detail: { dataset, rows: rows.length },
    });

    return csvResponse(
      `myreply-contacts-${stamp()}.csv`,
      toCsv(rows, columns),
      rows.length === MAX_ROWS
    );
  }

  if (dataset === "logs") {
    const rows = await prisma.dmLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        createdAt: true,
        status: true,
        commenterId: true,
        commenterName: true,
        matchedKeyword: true,
        commentId: true,
        dmSentAt: true,
        publicReplySentAt: true,
        attempts: true,
        errorMessage: true,
        automation: { select: { name: true } },
      },
    });

    const columns: CsvColumn<(typeof rows)[number]>[] = [
      { header: "When", value: (r) => r.createdAt.toISOString() },
      { header: "Campaign", value: (r) => r.automation?.name ?? null },
      { header: "Status", value: (r) => r.status },
      { header: "Commenter", value: (r) => r.commenterName },
      { header: "Commenter ID", value: (r) => r.commenterId },
      { header: "Matched keyword", value: (r) => r.matchedKeyword },
      { header: "Comment ID", value: (r) => r.commentId },
      { header: "DM sent", value: (r) => r.dmSentAt?.toISOString() ?? null },
      {
        header: "Public reply sent",
        value: (r) => r.publicReplySentAt?.toISOString() ?? null,
      },
      { header: "Attempts", value: (r) => r.attempts },
      // The reason a send did not happen is the most useful column in the
      // file, and the one no competitor lets you take with you.
      { header: "Reason", value: (r) => r.errorMessage },
    ];

    await recordAuditEvent({
      workspaceId,
      action: "data.exported",
      actorUserId: context.userId,
      detail: { dataset, rows: rows.length },
    });

    return csvResponse(
      `myreply-dm-logs-${stamp()}.csv`,
      toCsv(rows, columns),
      rows.length === MAX_ROWS
    );
  }

  if (dataset === "links") {
    const rows = await prisma.trackedLink.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        slug: true,
        label: true,
        destinationUrl: true,
        createdAt: true,
        automation: { select: { name: true } },
        _count: { select: { clicks: true } },
      },
    });

    const columns: CsvColumn<(typeof rows)[number]>[] = [
      { header: "Slug", value: (r) => r.slug },
      { header: "Label", value: (r) => r.label },
      { header: "Destination", value: (r) => r.destinationUrl },
      { header: "Campaign", value: (r) => r.automation?.name ?? null },
      { header: "Clicks", value: (r) => r._count.clicks },
      { header: "Created", value: (r) => r.createdAt.toISOString() },
    ];

    await recordAuditEvent({
      workspaceId,
      action: "data.exported",
      actorUserId: context.userId,
      detail: { dataset, rows: rows.length },
    });

    return csvResponse(
      `myreply-links-${stamp()}.csv`,
      toCsv(rows, columns),
      rows.length === MAX_ROWS
    );
  }

  // Campaigns go out as JSON rather than CSV, because the import route takes
  // JSON. A CSV of campaigns would be a file you can read and not a file you
  // can put back, and portability that only works one way is not portability.
  const campaigns = await prisma.automation.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: {
      name: true,
      goal: true,
      postId: true,
      postUrl: true,
      keywords: true,
      matchAnyPost: true,
      matchAnyWord: true,
      wholeWordMatch: true,
      dmMessage: true,
      openingDmEnabled: true,
      openingDmMessage: true,
      publicReplyEnabled: true,
      publicReplyMessages: true,
      followUpEnabled: true,
      followUpMessage: true,
      followUpDelayMinutes: true,
      requireFollow: true,
      isActive: true,
      createdAt: true,
      trackedLinks: { select: { destinationUrl: true, label: true } },
    },
  });

  await recordAuditEvent({
    workspaceId,
    action: "data.exported",
    actorUserId: context.userId,
    detail: { dataset, rows: campaigns.length },
  });

  return new NextResponse(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        // Shaped so it can go straight back into POST /api/automations/import.
        campaigns: campaigns.map((campaign) => ({
          ...campaign,
          trackedUrl: campaign.trackedLinks[0]?.destinationUrl ?? null,
        })),
      },
      null,
      2
    ),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="myreply-campaigns-${stamp()}.json"`,
        "Cache-Control": "no-store, private",
        "X-Export-Truncated": campaigns.length === MAX_ROWS ? "true" : "false",
      },
    }
  );
}
