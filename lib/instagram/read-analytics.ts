import * as meta from "@/lib/meta/client";
import type { InstagramContext } from "./context";

export async function getUserFollowStatus({
  context,
  recipientId,
}: {
  context: InstagramContext;
  recipientId: string;
}): Promise<boolean | null> {
  return meta.getUserFollowStatus(context.accessToken, recipientId);
}

/** The handle behind an IGSID, or null when Instagram will not say. */
export async function getRecipientUsername({
  context,
  recipientId,
}: {
  context: InstagramContext;
  recipientId: string;
}): Promise<string | null> {
  return meta.getUserUsername(context.accessToken, recipientId);
}

export async function getMediaInsights({
  context,
  mediaId,
  metrics,
}: {
  context: InstagramContext;
  mediaId: string;
  metrics: string[];
}): Promise<meta.InstagramMediaInsights> {
  return meta.getMediaInsights(context.accessToken, mediaId, metrics);
}

export async function getFollowerCountSeries({
  context,
  igUserId,
}: {
  context: InstagramContext;
  igUserId: string;
}): Promise<meta.FollowerCountPoint[] | null> {
  return meta.getFollowerCountSeries(context.accessToken, igUserId);
}
