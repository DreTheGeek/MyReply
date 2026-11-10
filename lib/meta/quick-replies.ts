/**
 * Instagram's wire format for quick replies.
 *
 * The campaign-side schema and parsing live in lib/campaigns/quick-replies.ts
 * and are re-exported here for older imports. This file only turns a stored
 * list into the shape Meta's send API accepts, so every sender truncates and
 * validates identically.
 */

import {
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_TITLE,
  type QuickReply,
} from "@/lib/campaigns/quick-replies";

export * from "@/lib/campaigns/quick-replies";

/** One quick reply in the shape Meta's send API accepts. */
export interface MetaQuickReply {
  content_type: "text" | "user_email" | "user_phone_number";
  title?: string;
  payload?: string;
}

/**
 * Shape quick replies for Meta's send API.
 *
 * Titles are truncated at 20 characters here rather than at the call site, so
 * every sender truncates identically. The prefilled types carry no title or
 * payload: Instagram fills them in from the tapper's profile.
 *
 * Throws when the list is empty or over the 13-button cap, so a bad list fails
 * on our side with a message that says what is wrong instead of coming back
 * from Meta as a generic parameter error.
 */
export function toMetaQuickReplies(replies: QuickReply[]): MetaQuickReply[] {
  if (replies.length === 0) {
    throw new Error("A message needs at least one quick reply to attach");
  }
  if (replies.length > MAX_QUICK_REPLIES) {
    throw new Error(
      `Instagram allows at most ${MAX_QUICK_REPLIES} quick replies on a message, got ${replies.length}`
    );
  }

  return replies.map((reply) => {
    if (reply.type === "email") {
      return { content_type: "user_email" as const };
    }
    if (reply.type === "phone") {
      return { content_type: "user_phone_number" as const };
    }
    return {
      content_type: "text" as const,
      title: reply.title.slice(0, MAX_QUICK_REPLY_TITLE),
      payload: reply.payload ?? "",
    };
  });
}
