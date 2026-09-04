import { prisma } from "@/lib/db/client";
import { buildTrackedUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import { generateReportShareSlug } from "@/lib/reports/share";

/**
 * The tools an AI agent can call over MCP.
 *
 * Descriptions are written for a model, not a developer: they say when to
 * reach for a tool and what a good argument looks like, because a model
 * choosing between eight tools has only these sentences to go on.
 *
 * Every handler takes the caller's workspaceId from the API key rather than
 * from the arguments. A model must never be able to name another tenant.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_instagram_accounts",
    description:
      "List the Instagram accounts connected to this workspace. Call this first when creating a campaign, because a campaign belongs to one account and you need its id.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_recent_posts",
    description:
      "List recent posts and reels for a connected account, newest first, so you can pick which one a campaign should watch. Returns each post's id, caption and permalink.",
    inputSchema: {
      type: "object",
      properties: {
        instagramAccountId: {
          type: "string",
          description: "Account id from list_instagram_accounts.",
        },
        limit: { type: "number", description: "Default 12, maximum 50." },
      },
      required: ["instagramAccountId"],
    },
  },
  {
    name: "list_campaigns",
    description:
      "List this workspace's campaigns with their keywords, triggers and whether they are live.",
    inputSchema: {
      type: "object",
      properties: {
        instagramAccountId: {
          type: "string",
          description: "Optional. Omit to list across every account.",
        },
      },
    },
  },
  {
    name: "create_campaign",
    description:
      "Create a comment-to-DM campaign. When someone comments a keyword, they receive the DM. Choose a post with list_recent_posts first, or set matchAnyPost to cover every post including future ones. Write dmMessage in the account owner's own voice; it is sent verbatim, so no placeholders unless you use {username}, which is replaced with the commenter's handle.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Internal label, not shown to anyone." },
        instagramAccountId: { type: "string" },
        postId: {
          type: "string",
          description:
            "The post or reel to watch. Omit and set matchAnyPost to cover all posts.",
        },
        matchAnyPost: {
          type: "boolean",
          description: "Watch every post on the account, including future ones.",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description:
            "Words that trigger the DM, matched case-insensitively. Keep them short and unlikely to appear by accident.",
        },
        dmMessage: {
          type: "string",
          description:
            "The DM to send, in the owner's voice. Use {username} for the commenter's handle and {link} where the tracked link should sit.",
        },
        linkUrl: {
          type: "string",
          description:
            "Optional destination. It is wrapped in a tracked link so clicks are attributed.",
        },
        linkButtonLabel: {
          type: "string",
          description: "Button text for the link, for example: Get the guide.",
        },
        publicReplyEnabled: {
          type: "boolean",
          description:
            "Also reply publicly under the comment. Recommended, it prompts others to comment too.",
        },
        publicReplyMessages: {
          type: "array",
          items: { type: "string" },
          description:
            "Several wordings, picked at random per reply, so the thread does not read as a bot.",
        },
        isActive: { type: "boolean", description: "Defaults to true." },
      },
      required: ["name", "instagramAccountId", "keywords", "dmMessage"],
    },
  },
  {
    name: "update_campaign",
    description:
      "Change an existing campaign. Send only the fields you want changed; anything omitted is left alone. Use this to pause a campaign by setting isActive to false.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        dmMessage: { type: "string" },
        isActive: { type: "boolean" },
        publicReplyEnabled: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_campaign_performance",
    description:
      "How a campaign is doing: DMs sent, failures, skips and link clicks. Use this before suggesting a change, so advice is grounded in what actually happened.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "list_dm_logs",
    description:
      "Recent DM sends with their outcome. Use this to diagnose why someone did not receive a message. Statuses include SENT, FAILED, SKIPPED_RATE_LIMIT and SKIPPED_DEDUP.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Default 25, maximum 100." },
        status: {
          type: "string",
          description: "Optional filter, for example FAILED.",
        },
      },
    },
  },
];

type ToolResult = Record<string, unknown>;

/**
 * Run a tool for one workspace. Throws on bad input so the caller can turn it
 * into an MCP error; returns plain JSON-serialisable data otherwise.
 */
export async function runMcpTool(
  name: string,
  args: Record<string, unknown>,
  workspaceId: string
): Promise<ToolResult> {
  switch (name) {
    case "list_instagram_accounts": {
      const accounts = await prisma.instagramAccount.findMany({
        where: { workspaceId },
        orderBy: { connectedAt: "desc" },
        select: { id: true, username: true, name: true, instagramId: true },
      });
      return { accounts };
    }

    case "list_recent_posts": {
      const accountId = String(args.instagramAccountId ?? "");
      const account = await prisma.instagramAccount.findFirst({
        where: { id: accountId, workspaceId },
        select: { id: true },
      });
      if (!account) throw new Error("Unknown Instagram account for this workspace");

      // Posts already seen by campaigns in this workspace. Deliberately not a
      // live Graph call: an agent exploring options should not spend the
      // account's API quota, and stale-by-minutes is fine for picking a post.
      const limit = Math.min(Number(args.limit ?? 12) || 12, 50);
      const campaigns = await prisma.automation.findMany({
        where: { workspaceId, instagramAccountId: accountId, postId: { not: null } },
        distinct: ["postId"],
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { postId: true, postUrl: true, name: true },
      });
      return {
        posts: campaigns.map((c) => ({
          postId: c.postId,
          permalink: c.postUrl,
          usedByCampaign: c.name,
        })),
        note: "Posts already referenced by a campaign. To watch a new post, pass matchAnyPost or supply the post id from Instagram directly.",
      };
    }

    case "list_campaigns": {
      const where: Record<string, unknown> = { workspaceId };
      if (args.instagramAccountId) {
        where.instagramAccountId = String(args.instagramAccountId);
      }
      const campaigns = await prisma.automation.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
        select: {
          id: true,
          name: true,
          isActive: true,
          keywords: true,
          postId: true,
          matchAnyPost: true,
          dmMessage: true,
          publicReplyEnabled: true,
          dmTriggerEnabled: true,
          storyReplyEnabled: true,
          storyMentionEnabled: true,
        },
      });
      return { campaigns };
    }

    case "create_campaign": {
      const accountId = String(args.instagramAccountId ?? "");
      const account = await prisma.instagramAccount.findFirst({
        where: { id: accountId, workspaceId },
        select: { id: true },
      });
      if (!account) throw new Error("Unknown Instagram account for this workspace");

      const keywords = Array.isArray(args.keywords)
        ? args.keywords.map(String).filter(Boolean)
        : [];
      const dmMessage = String(args.dmMessage ?? "").trim();
      if (!dmMessage) throw new Error("dmMessage is required");
      if (keywords.length === 0) throw new Error("At least one keyword is required");

      const postId = args.postId ? String(args.postId) : null;
      const matchAnyPost = Boolean(args.matchAnyPost);
      if (!postId && !matchAnyPost) {
        throw new Error(
          "Give a postId, or set matchAnyPost to watch every post on the account"
        );
      }

      const replies = Array.isArray(args.publicReplyMessages)
        ? args.publicReplyMessages.map(String).filter(Boolean)
        : [];

      const campaign = await prisma.automation.create({
        data: {
          workspaceId,
          instagramAccountId: accountId,
          name: String(args.name ?? "Untitled campaign").slice(0, 100),
          postId,
          matchAnyPost,
          keywords,
          dmMessage: dmMessage.slice(0, 1000),
          linkButtonLabel: args.linkButtonLabel
            ? String(args.linkButtonLabel).slice(0, 64)
            : null,
          publicReplyEnabled: Boolean(args.publicReplyEnabled),
          publicReplyMessages: replies.slice(0, 5),
          isActive: args.isActive === undefined ? true : Boolean(args.isActive),
          reportShareSlug: generateReportShareSlug(),
        },
        select: { id: true, name: true, keywords: true, isActive: true },
      });

      // A destination becomes a tracked link so clicks are attributed rather
      // than disappearing into the destination's own analytics.
      let trackedUrl: string | null = null;
      if (args.linkUrl) {
        const slug = generateTrackedLinkSlug();
        await prisma.trackedLink.create({
          data: {
            workspaceId,
            automationId: campaign.id,
            slug,
            label: args.linkButtonLabel ? String(args.linkButtonLabel) : null,
            destinationUrl: String(args.linkUrl),
          },
        });
        trackedUrl = buildTrackedUrl(slug);
      }

      return { campaign, trackedUrl };
    }

    case "update_campaign": {
      const id = String(args.id ?? "");
      const existing = await prisma.automation.findFirst({
        where: { id, workspaceId },
        select: { id: true },
      });
      if (!existing) throw new Error("Unknown campaign for this workspace");

      const data: Record<string, unknown> = {};
      if (args.name !== undefined) data.name = String(args.name).slice(0, 100);
      if (args.dmMessage !== undefined) {
        data.dmMessage = String(args.dmMessage).slice(0, 1000);
      }
      if (args.isActive !== undefined) data.isActive = Boolean(args.isActive);
      if (args.publicReplyEnabled !== undefined) {
        data.publicReplyEnabled = Boolean(args.publicReplyEnabled);
      }
      if (Array.isArray(args.keywords)) {
        data.keywords = args.keywords.map(String).filter(Boolean);
      }
      if (Object.keys(data).length === 0) {
        throw new Error("Nothing to update. Send at least one field to change.");
      }

      const campaign = await prisma.automation.update({
        where: { id },
        data,
        select: { id: true, name: true, keywords: true, isActive: true },
      });
      return { campaign };
    }

    case "get_campaign_performance": {
      const id = String(args.id ?? "");
      const campaign = await prisma.automation.findFirst({
        where: { id, workspaceId },
        select: { id: true, name: true },
      });
      if (!campaign) throw new Error("Unknown campaign for this workspace");

      const grouped = await prisma.dmLog.groupBy({
        by: ["status"],
        where: { automationId: id, workspaceId },
        _count: { _all: true },
      });
      const clicks = await prisma.linkClick.count({
        where: { workspaceId, trackedLink: { automationId: id } },
      });

      const byStatus: Record<string, number> = {};
      for (const row of grouped) byStatus[row.status] = row._count._all;

      return {
        campaign,
        byStatus,
        sent: byStatus.SENT ?? 0,
        clicks,
        clickRate:
          byStatus.SENT && byStatus.SENT > 0
            ? Math.round((clicks / byStatus.SENT) * 1000) / 10
            : 0,
      };
    }

    case "list_dm_logs": {
      const limit = Math.min(Number(args.limit ?? 25) || 25, 100);
      const where: Record<string, unknown> = { workspaceId };
      if (args.status) where.status = String(args.status);

      const logs = await prisma.dmLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          status: true,
          errorMessage: true,
          matchedKeyword: true,
          createdAt: true,
          automation: { select: { name: true } },
        },
      });
      return { logs };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
