import { NextRequest, NextResponse } from "next/server";
import { captureKinds } from "@/lib/campaigns/capture";
import { createAutomationSchema, updateAutomationSchema } from "@/lib/campaigns/schemas";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { recordAuditEvent } from "@/lib/audit";
import { resolveIsActive } from "@/lib/campaigns/link-readiness";
import {
  calculateCtr,
  CLICK_ROW_SELECT,
  countUniqueClicksBy,
  normalizeTopKeywords,
} from "@/lib/tracking/analytics";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import {
  buildInitialCampaignLinks,
  syncCampaignLinks,
} from "@/lib/campaigns/links";
import { buildReportUrl, generateReportShareSlug } from "@/lib/reports/share";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// This list is read-your-writes (created/imported campaigns must show up
// immediately), so never cache it at the route or CDN layer.
export const dynamic = "force-dynamic";


export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  const instagramAccountId =
    request.nextUrl.searchParams.get("instagramAccountId");
  const accountFilter =
    instagramAccountId && instagramAccountId !== "all"
      ? { instagramAccountId }
      : {};

  const automations = await prisma.automation.findMany({
    where: { workspaceId, ...accountFilter },
    include: {
      instagramAccount: {
        select: { username: true, instagramId: true },
      },
      _count: {
        select: { dmLogs: true },
      },
      trackedLinks: {
        select: {
          id: true,
          slug: true,
          label: true,
          destinationUrl: true,
          _count: { select: { clicks: true } },
        },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const automationsWithReports = await Promise.all(
    automations.map(async (automation) => {
      if (automation.reportShareSlug) return automation;

      const updated = await prisma.automation.update({
        where: { id: automation.id },
        data: { reportShareSlug: generateReportShareSlug() },
        select: { reportShareSlug: true },
      });

      return {
        ...automation,
        reportShareSlug: updated.reportShareSlug,
      };
    })
  );

  const [statusCounts, clickRows, keywordCounts] = await Promise.all([
    prisma.dmLog.groupBy({
      by: ["automationId", "status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.linkClick.findMany({
      where: { workspaceId },
      select: CLICK_ROW_SELECT,
    }),
    prisma.dmLog.groupBy({
      by: ["automationId", "matchedKeyword"],
      where: { workspaceId, matchedKeyword: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const analytics = new Map<
    string,
    {
      sent: number;
      skipped: number;
      failed: number;
      clicks: number;
      topKeywords: { keyword: string; count: number }[];
    }
  >();

  for (const automation of automationsWithReports) {
    analytics.set(automation.id, {
      sent: 0,
      skipped: 0,
      failed: 0,
      clicks: 0,
      topKeywords: [],
    });
  }

  for (const row of statusCounts) {
    const item = analytics.get(row.automationId);
    if (!item) continue;
    const count = row._count._all;
    if (row.status === "SENT") item.sent += count;
    if (row.status === "FAILED") item.failed += count;
    if (row.status.startsWith("SKIPPED_")) item.skipped += count;
  }

  const clickCounts = countUniqueClicksBy(clickRows, (row) => row.automationId);
  for (const [automationId, clicks] of clickCounts) {
    const item = analytics.get(automationId);
    if (item) item.clicks = clicks;
  }

  for (const automation of automationsWithReports) {
    const item = analytics.get(automation.id);
    if (!item) continue;
    item.topKeywords = normalizeTopKeywords(
      keywordCounts
        .filter((row) => row.automationId === automation.id)
        .map((row) => ({
          matchedKeyword: row.matchedKeyword,
          _count: row._count._all,
        })),
      3
    );
  }

  return NextResponse.json(
    {
    success: true,
    data: automationsWithReports.map((automation) => {
      const item = analytics.get(automation.id) ?? {
        sent: 0,
        skipped: 0,
        failed: 0,
        clicks: 0,
        topKeywords: [],
      };

      return {
        ...automation,
        trackedLinks: automation.trackedLinks.map((link) => ({
          ...link,
          trackedUrl: buildTrackedUrl(link.slug),
        })),
        reportUrl: automation.reportShareSlug
          ? buildReportUrl(automation.reportShareSlug)
          : null,
        analytics: {
          ...item,
          ctr: calculateCtr(item.clicks, item.sent),
        },
      };
    }),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can create campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const body = await request.json();
  const parsed = createAutomationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const requestedInstagramAccountId =
    parsed.data.instagramAccountId && parsed.data.instagramAccountId !== "all"
      ? parsed.data.instagramAccountId
      : null;

  const [workspace, instagramAccount] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    }),
    requestedInstagramAccountId
      ? prisma.instagramAccount.findFirst({
          where: { id: requestedInstagramAccountId, workspaceId },
        })
      : prisma.instagramAccount.findFirst({
          where: { workspaceId },
          orderBy: { connectedAt: "desc" },
        }),
  ]);

  if (!workspace) {
    return NextResponse.json(
      { success: false, error: "Workspace not found" },
      { status: 404 }
    );
  }

  if (!instagramAccount) {
    // Two different failures used to share one message. Someone who named an
    // account that is not theirs, or that no longer exists, was told to
    // "Connect Instagram" while looking at three connected accounts, which
    // reads as a bug in the product rather than a mistake in the request.
    if (requestedInstagramAccountId) {
      return NextResponse.json(
        {
          success: false,
          error: "That Instagram account is not connected to this workspace",
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: false, error: "Connect Instagram before creating campaigns" },
      { status: 400 }
    );
  }

  const linkCreates = buildInitialCampaignLinks({
    workspaceId,
    primaryUrl: parsed.data.trackedDestinationUrl,
    secondaryUrl: parsed.data.secondaryDestinationUrl,
    secondaryLabel: parsed.data.secondaryButtonLabel,
  });

  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
    parsed.data;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = (
    parsed.data.publicReplyMessages.length > 0
      ? parsed.data.publicReplyMessages
      : parsed.data.publicReplyMessage
        ? [parsed.data.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  // A campaign whose message offers a link, with no link behind it, would
  // send the literal text "{link}" to a real person. Save it paused instead of
  // refusing the request, so the work is kept and nothing goes out.
  const linkReadiness = resolveIsActive(
    parsed.data.isActive,
    parsed.data,
    linkCreates.length > 0
  );

  const automation = await prisma.automation.create({
    data: {
      name: parsed.data.name,
      goal: parsed.data.goal,
      // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
      postId: isSpecificPost ? parsed.data.postId : null,
      postUrl: isSpecificPost ? parsed.data.postUrl : null,
      pendingNextReel,
      matchAnyPost,
      keywords: matchAnyWord ? [] : parsed.data.keywords,
      matchAnyWord,
      dmTriggerEnabled: parsed.data.dmTriggerEnabled,
      storyReplyEnabled: parsed.data.storyReplyEnabled,
      storyMentionEnabled: parsed.data.storyMentionEnabled,
      liveCommentEnabled: parsed.data.liveCommentEnabled,
      defaultReplyEnabled: parsed.data.defaultReplyEnabled,
      referralRef: parsed.data.referralRef?.trim() || null,
      dmMessage: parsed.data.dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled
        ? parsed.data.openingDmMessage || null
        : null,
      openingDmButtonLabel: openingDmEnabled
        ? parsed.data.openingDmButtonLabel || null
        : null,
      linkButtonLabel: parsed.data.linkButtonLabel || null,
      requireFollow: parsed.data.requireFollow,
      followPromptMessage: parsed.data.requireFollow
        ? parsed.data.followPromptMessage || null
        : null,
      followPromptButtonLabel: parsed.data.requireFollow
        ? parsed.data.followPromptButtonLabel || null
        : null,
      followUpEnabled: parsed.data.followUpEnabled,
      followUpMessage: parsed.data.followUpEnabled
        ? parsed.data.followUpMessage || null
        : null,
      followUpDelayMinutes: parsed.data.followUpEnabled
        ? parsed.data.followUpDelayMinutes
        : 0,
      publicReplyEnabled: parsed.data.publicReplyEnabled,
      publicReplyMessages: parsed.data.publicReplyEnabled
        ? publicReplyList
        : [],
      publicReplyMessage: parsed.data.publicReplyEnabled
        ? publicReplyList[0] ?? parsed.data.publicReplyMessage ?? null
        : null,
      captureEnabled: parsed.data.captureEnabled,
      captureKinds: parsed.data.captureEnabled ? captureKinds(parsed.data.captureKinds) : [],
      capturePrompt: parsed.data.captureEnabled
        ? parsed.data.capturePrompt?.trim() || null
        : null,
      captureConsentText: parsed.data.captureEnabled
        ? parsed.data.captureConsentText?.trim() || null
        : null,
      isActive: linkReadiness.isActive,
      wholeWordMatch: parsed.data.wholeWordMatch,
      workspaceId,
      instagramAccountId: instagramAccount.id,
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0
        ? { trackedLinks: { create: linkCreates } }
        : {}),
    },
    include: {
      trackedLinks: true,
    },
  });

  return NextResponse.json(
    { success: true, data: automation },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can update campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "Missing campaign ID" },
      { status: 400 }
    );
  }

  const body = await request.json();
  const parsed = updateAutomationSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  const {
    trackedDestinationUrl,
    secondaryDestinationUrl,
    secondaryButtonLabel,
    ...automationData
  } = parsed.data;

  // Moving a campaign to another account: it must be one of this workspace's.
  if (
    automationData.instagramAccountId !== undefined &&
    automationData.instagramAccountId !== existing.instagramAccountId
  ) {
    const account = await prisma.instagramAccount.findFirst({
      where: { id: automationData.instagramAccountId, workspaceId },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json(
        { success: false, error: "Instagram account not found" },
        { status: 404 }
      );
    }
  }

  // Keep dependent fields consistent: any-word clears keywords; a disabled
  // opening DM clears its message and button.
  if (automationData.matchAnyWord === true) automationData.keywords = [];
  if (automationData.openingDmEnabled === false) {
    automationData.openingDmMessage = null;
    automationData.openingDmButtonLabel = null;
  }
  if (automationData.requireFollow === false) {
    automationData.followPromptMessage = null;
    automationData.followPromptButtonLabel = null;
  }
  if (automationData.followUpEnabled === false) {
    automationData.followUpMessage = null;
    automationData.followUpDelayMinutes = 0;
  }
  // Turning the capture ask off clears it; turning it on needs something to
  // ask for, judged against what the saved campaign already holds.
  if (automationData.captureEnabled === false) {
    automationData.captureKinds = [];
    automationData.capturePrompt = null;
    automationData.captureConsentText = null;
  } else {
    if (automationData.captureKinds !== undefined) {
      automationData.captureKinds = captureKinds(automationData.captureKinds);
    }
    const enabled = automationData.captureEnabled ?? existing.captureEnabled;
    const kinds = automationData.captureKinds ?? existing.captureKinds ?? [];
    if (enabled && kinds.length === 0) {
      return NextResponse.json(
        { success: false, error: "Choose email, phone or both to ask for" },
        { status: 400 }
      );
    }
  }
  if (automationData.capturePrompt !== undefined) {
    automationData.capturePrompt = automationData.capturePrompt?.trim() || null;
  }
  if (automationData.captureConsentText !== undefined) {
    automationData.captureConsentText = automationData.captureConsentText?.trim() || null;
  }
  // A blank ref means "no ref entry", never a campaign keyed to an empty ref.
  if (automationData.referralRef !== undefined) {
    automationData.referralRef = automationData.referralRef?.trim() || null;
  }
  // Any-post / next-reel campaigns carry no specific post.
  if (automationData.matchAnyPost === true || automationData.pendingNextReel === true) {
    automationData.postId = null;
    automationData.postUrl = null;
  }
  // Keep the public-reply variations list and the legacy single field in sync.
  if (automationData.publicReplyMessages !== undefined) {
    const list = automationData.publicReplyMessages
      .map((m) => m.trim())
      .filter(Boolean);
    automationData.publicReplyMessages = list;
    automationData.publicReplyMessage = list[0] ?? null;
  }
  if (automationData.publicReplyEnabled === false) {
    automationData.publicReplyMessages = [];
    automationData.publicReplyMessage = null;
  }

  // One transaction, so a save never lands half applied. Updating the campaign
  // first locks its row, which makes a second save of the same campaign wait
  // for this one before it reads the links.
  const updated = await prisma.$transaction(async (tx) => {
    const campaign = await tx.automation.update({
      where: { id: automationId },
      data: automationData,
    });

    await syncCampaignLinks(tx, {
      workspaceId,
      automationId,
      primaryUrl: trackedDestinationUrl,
      secondaryUrl: secondaryDestinationUrl,
      secondaryLabel: secondaryButtonLabel,
    });

    return campaign;
  });

  return NextResponse.json({ success: true, data: updated });
}

export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can delete campaigns" },
      { status: 403 }
    );
  }

  const workspaceId = context.workspaceId;

  const automationId = request.nextUrl.searchParams.get("id");
  if (!automationId) {
    return NextResponse.json(
      { success: false, error: "Missing campaign ID" },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findFirst({
    where: { id: automationId, workspaceId },
  });

  if (!existing) {
    return NextResponse.json(
      { success: false, error: "Campaign not found" },
      { status: 404 }
    );
  }

  await prisma.automation.delete({ where: { id: automationId } });

  // Deleting a campaign cascades its DmLog rows, so this is the only surviving
  // record that those sends ever happened.
  await recordAuditEvent({
    workspaceId,
    action: "campaign.deleted",
    targetId: automationId,
    detail: { name: existing.name },
  });

  return NextResponse.json({ success: true, data: { deleted: true } });
}
