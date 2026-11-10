import * as meta from "@/lib/meta/client";
import type { QuickReply } from "@/lib/meta/quick-replies";
import type { InstagramContext } from "./context";

type SendResult = { recipient_id?: string; message_id: string };

/**
 * Comment sends take the post id as well, because a relay provider once
 * addressed a comment by post and comment together. Meta needs only the
 * comment id, so it is accepted and ignored until the call sites move onto
 * the channel adapter.
 */
type CommentTarget = { commentId: string; postId?: string };

export async function sendPrivateReply({
  context,
  instagramAccountId,
  commentId,
  message,
}: CommentTarget & {
  context: InstagramContext;
  instagramAccountId: string;
  message: string;
}): Promise<SendResult> {
  return meta.sendPrivateReply(
    context.accessToken,
    instagramAccountId,
    commentId,
    message
  );
}

export async function sendPrivateReplyWithButton({
  context,
  instagramAccountId,
  commentId,
  text,
  buttonTitle,
  payload,
}: CommentTarget & {
  context: InstagramContext;
  instagramAccountId: string;
  text: string;
  buttonTitle: string;
  payload: string;
}): Promise<SendResult> {
  return meta.sendPrivateReplyWithButton(
    context.accessToken,
    instagramAccountId,
    commentId,
    text,
    buttonTitle,
    payload
  );
}

export async function sendDirectMessageWithButton({
  context,
  instagramAccountId,
  userId,
  text,
  buttonTitle,
  payload,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  text: string;
  buttonTitle: string;
  payload: string;
}): Promise<SendResult> {
  return meta.sendDirectMessageWithButton(
    context.accessToken,
    instagramAccountId,
    userId,
    text,
    buttonTitle,
    payload
  );
}

export async function sendPrivateReplyWithLinkButton({
  context,
  instagramAccountId,
  commentId,
  text,
  buttons,
}: CommentTarget & {
  context: InstagramContext;
  instagramAccountId: string;
  text: string;
  buttons: meta.LinkButton[];
}): Promise<SendResult> {
  return meta.sendPrivateReplyWithLinkButton(
    context.accessToken,
    instagramAccountId,
    commentId,
    text,
    buttons
  );
}

export async function sendDirectMessage({
  context,
  instagramAccountId,
  userId,
  message,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  message: string;
}): Promise<SendResult> {
  return meta.sendDirectMessage(
    context.accessToken,
    instagramAccountId,
    userId,
    message
  );
}

export async function sendDirectMessageWithLinkButton({
  context,
  instagramAccountId,
  userId,
  text,
  buttons,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  text: string;
  buttons: meta.LinkButton[];
}): Promise<SendResult> {
  return meta.sendDirectMessageWithLinkButton(
    context.accessToken,
    instagramAccountId,
    userId,
    text,
    buttons
  );
}

export async function sendCommentReply({
  context,
  commentId,
  message,
}: CommentTarget & {
  context: InstagramContext;
  message: string;
}): Promise<{ id: string }> {
  return meta.sendCommentReply(context.accessToken, commentId, message);
}

/** A text DM carrying tappable quick replies. */
export async function sendDirectMessageWithQuickReplies({
  context,
  instagramAccountId,
  userId,
  text,
  quickReplies,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  text: string;
  quickReplies: QuickReply[];
}): Promise<SendResult> {
  return meta.sendDirectMessageWithQuickReplies(
    context.accessToken,
    instagramAccountId,
    userId,
    text,
    quickReplies
  );
}

/** A private reply to a comment, carrying quick replies. */
export async function sendPrivateReplyWithQuickReplies({
  context,
  instagramAccountId,
  commentId,
  text,
  quickReplies,
}: CommentTarget & {
  context: InstagramContext;
  instagramAccountId: string;
  text: string;
  quickReplies: QuickReply[];
}): Promise<SendResult> {
  return meta.sendPrivateReplyWithQuickReplies(
    context.accessToken,
    instagramAccountId,
    commentId,
    text,
    quickReplies
  );
}

/** An image, video, audio or file DM by public URL. */
export async function sendAttachment({
  context,
  instagramAccountId,
  userId,
  attachmentUrl,
  type,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  userId: string;
  attachmentUrl: string;
  type: meta.AttachmentType;
}): Promise<{ recipient_id: string; message_id: string }> {
  return meta.sendAttachment(
    context.accessToken,
    instagramAccountId,
    userId,
    attachmentUrl,
    type
  );
}

export { inferAttachmentType } from "@/lib/meta/client";
export type { AttachmentType } from "@/lib/meta/client";
