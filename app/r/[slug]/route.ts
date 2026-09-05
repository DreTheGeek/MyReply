import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { checkRateLimit } from "@/lib/oauth/rate-limit";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

/**
 * How many clicks from one address on one link get counted per window.
 *
 * Every GET here used to write a LinkClick row unconditionally, with no dedup,
 * no limiter and no bot filter. These links are sent in DMs to strangers, so
 * everyone the product talks to holds one: any of them could curl it in a loop
 * and both inflate the tenant's storage and permanently corrupt their click
 * analytics, which is a number the customer is paying us to be right.
 *
 * The window is generous because real people do double-tap, and a link
 * previewed by a messaging client then opened by the person is two legitimate
 * requests.
 */
const CLICKS_PER_WINDOW = 5;
const CLICK_WINDOW_MS = 60 * 1000;

/**
 * The destination is chosen by whoever made the campaign, and the schema that
 * accepts it takes any URL scheme. A Location header will not execute a
 * javascript: or data: URL, so this is not code execution, but nothing good
 * comes of bouncing a visitor into one either.
 */
function isSafeDestination(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink || !isSafeDestination(trackedLink.destinationUrl)) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  const ipHash = hashClickIp(getRequestIp(request));

  // The limiter gates the RECORD, never the redirect. Someone clicking a real
  // link must always arrive, even if we decline to count them again: refusing
  // to redirect would break the product to protect a statistic.
  const counted = checkRateLimit(
    `click:${slug}:${ipHash}`,
    CLICKS_PER_WINDOW,
    CLICK_WINDOW_MS
  );

  if (counted.allowed) {
    await prisma.linkClick
      .create({
        data: {
          workspaceId: trackedLink.workspaceId,
          automationId: trackedLink.automationId,
          instagramAccountId: trackedLink.automation.instagramAccountId,
          trackedLinkId: trackedLink.id,
          ipHash,
          userAgent: request.headers.get("user-agent"),
          referrer: request.headers.get("referer"),
        },
      })
      // Recording a click must never cost the person their redirect.
      .catch((error) => {
        console.error("[Tracked link] Could not record click", error);
      });
  }

  return NextResponse.redirect(trackedLink.destinationUrl, { status: 302 });
}
