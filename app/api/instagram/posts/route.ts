import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import type { ChannelMedia } from "@/lib/channels/content";
import { openChannel } from "@/lib/channels/registry";

/**
 * A post as the dashboard's pickers read it. The field names predate the
 * channel adapter and the screens still use them, so the neutral media shape
 * is written back into them here, once, rather than changed on every screen.
 */
interface PostWire {
  id: string;
  caption?: string;
  media_type: string;
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
}

const MEDIA_TYPE_WIRE: Record<ChannelMedia["mediaType"], string> = {
  IMAGE: "IMAGE",
  VIDEO: "VIDEO",
  CAROUSEL: "CAROUSEL_ALBUM",
  OTHER: "OTHER",
};

function toPostWire(media: ChannelMedia): PostWire {
  return {
    id: media.id,
    ...(media.caption !== null ? { caption: media.caption } : {}),
    media_type: MEDIA_TYPE_WIRE[media.mediaType],
    ...(media.isReel ? { media_product_type: "REELS" } : {}),
    ...(media.mediaUrl ? { media_url: media.mediaUrl } : {}),
    ...(media.thumbnailUrl ? { thumbnail_url: media.thumbnailUrl } : {}),
    timestamp: media.timestamp,
    ...(media.permalink ? { permalink: media.permalink } : {}),
    ...(media.likeCount !== null ? { like_count: media.likeCount } : {}),
    ...(media.commentsCount !== null ? { comments_count: media.commentsCount } : {}),
  };
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const account = await getWorkspaceInstagramAccount(
    workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );

  if (!account) {
    return NextResponse.json(
      {
        success: false,
        error:
          "Instagram account not connected. Please connect your account first.",
      },
      { status: 400 }
    );
  }

  try {
    const channel = await openChannel(account);
    const { content } = channel.adapter;

    // `all=true` paginates the full library (for the campaign post picker);
    // otherwise return a single recent page.
    const loadAll = request.nextUrl.searchParams.get("all") === "true";
    let media: ChannelMedia[];
    if (loadAll) {
      media = await content.allMedia(channel.context, { max: 300 });
    } else {
      const limitParam = request.nextUrl.searchParams.get("limit");
      const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 25;
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), 50)
        : 25;
      media = await content.recentMedia(channel.context, { limit });
    }

    return NextResponse.json({
      success: true,
      data: media.map(toPostWire),
    });
  } catch (err) {
    console.error("[Instagram Posts] Error:", err);
    return NextResponse.json(
      { success: false, error: "Failed to fetch Instagram posts" },
      { status: 500 }
    );
  }
}
