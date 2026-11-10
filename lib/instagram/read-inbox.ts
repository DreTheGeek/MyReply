import * as meta from "@/lib/meta/client";
import type { InstagramContext } from "./context";

export async function getConversations({
  context,
  igUserId,
}: {
  context: InstagramContext;
  igUserId: string;
}): Promise<meta.InstagramConversation[]> {
  return meta.getConversations(context.accessToken, igUserId);
}

export async function getConversationMessages({
  context,
  conversationId,
}: {
  context: InstagramContext;
  conversationId: string;
}): Promise<meta.InstagramMessage[]> {
  return meta.getConversationMessages(context.accessToken, conversationId);
}
