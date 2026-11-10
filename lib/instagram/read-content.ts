import * as meta from "@/lib/meta/client";
import type { InstagramContext } from "./context";

export async function getRecentMediaComments({
  context,
  mediaId,
  sinceMs,
  max = 800,
}: {
  context: InstagramContext;
  mediaId: string;
  sinceMs: number;
  max?: number;
}): Promise<meta.InstagramComment[]> {
  return meta.getRecentMediaComments(context.accessToken, mediaId, sinceMs, max);
}

export async function getUserMedia({
  context,
  limit = 25,
}: {
  context: InstagramContext;
  limit?: number;
}): Promise<meta.InstagramMedia[]> {
  return meta.getUserMedia(context.accessToken, limit);
}

export async function getAllUserMedia({
  context,
  max = 500,
}: {
  context: InstagramContext;
  max?: number;
}): Promise<meta.InstagramMedia[]> {
  return meta.getAllUserMedia(context.accessToken, max);
}

export async function getUserInfo({
  context,
}: {
  context: InstagramContext;
}): Promise<meta.InstagramUser> {
  return meta.getUserInfo(context.accessToken);
}
