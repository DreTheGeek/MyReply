"use client";

import { useSearchParams } from "next/navigation";

/**
 * The outcome of connecting a Facebook Page, read from ?facebook= on the
 * settings page. Never shows an internal error: the reason for a failure stays
 * server side.
 */

type Tone = "error" | "warning" | "success";

const TONE_CLASSES: Record<Tone, string> = {
  error: "border-error/20 bg-error/10 text-error",
  warning: "border-warning/20 bg-warning/10 text-warning",
  success: "border-success/20 bg-success/10 text-success",
};

const MESSAGES: Record<string, { tone: Tone; title: string; detail: string }> = {
  connected: {
    tone: "success",
    title: "Facebook Page connected",
    detail: "Comments and messages on the Page now reach your campaigns.",
  },
  denied: {
    tone: "warning",
    title: "Facebook connection cancelled",
    detail: "You declined the Facebook prompt. Start again and allow everything it asks for.",
  },
  invalid: {
    tone: "error",
    title: "Facebook connection expired",
    detail: "The login link was missing or older than 10 minutes. Start again to get a fresh one.",
  },
  forbidden: {
    tone: "error",
    title: "Not permitted",
    detail: "Only workspace owners and admins can connect a Facebook Page.",
  },
  already_connected: {
    tone: "warning",
    title: "Page already connected",
    detail: "That Page is connected to another workspace. Disconnect it there first.",
  },
  plan_limit: {
    tone: "warning",
    title: "Your plan is full",
    detail: "Your plan's account limit is already in use. Disconnect an account or upgrade, then connect again.",
  },
  none_granted: {
    tone: "warning",
    title: "No Page was shared",
    detail: "Facebook did not share a Page you can message from. Start again and choose the Page when Facebook asks.",
  },
  misconfigured: {
    tone: "error",
    title: "Facebook connection is not set up",
    detail: "This deployment is missing its Facebook app settings. Ask whoever runs it to add them.",
  },
  failed: {
    tone: "error",
    title: "Facebook connection failed",
    detail: "Facebook accepted the login but the Page could not be connected. Try again in a minute.",
  },
};

export function FacebookConnectNotice(): React.JSX.Element | null {
  const status = useSearchParams().get("facebook");
  const known = status ? MESSAGES[status] : undefined;
  if (!known) return null;

  return (
    <div className={`rounded border p-4 text-sm ${TONE_CLASSES[known.tone]}`}>
      <p className="font-semibold">{known.title}</p>
      <p className="mt-1 opacity-90">{known.detail}</p>
    </div>
  );
}
