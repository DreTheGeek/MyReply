"use client";

import { useState } from "react";

interface InvitationAcceptCardProps {
  token: string;
  isSignedIn: boolean;
  invitedEmail: string;
}

export default function InvitationAcceptCard({
  token,
  isSignedIn,
  invitedEmail,
}: InvitationAcceptCardProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function acceptInvite() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/workspace/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const payload = await response.json().catch(() => null);
      if (payload?.success) {
        window.location.assign("/dashboard");
        return;
      }
      setMessage(payload?.error ?? "Could not accept invitation");
      setBusy(false);
    } catch {
      // Without this a rejection left busy true and the button stuck on
      // "Accepting..." with no way to try again.
      setMessage("We could not reach the server. Try again in a moment.");
      setBusy(false);
    }
  }

  if (!isSignedIn) {
    return (
      // Signing in without a callbackUrl dropped the invitation: the person
      // landed on the dashboard and had to go back to their email to find the
      // link again. The OAuth consent screen already does this correctly.
      <a
        href={`/login?callbackUrl=${encodeURIComponent(`/invite/${token}`)}`}
        className="inline-flex items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-on-accent transition hover:bg-accent-hover"
      >
        Sign in to accept
      </a>
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={acceptInvite}
        disabled={busy}
        className="inline-flex items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-on-accent transition hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? "Accepting..." : "Accept invitation"}
      </button>
      {message && <p className="text-sm text-error">{message}</p>}
      <p className="text-xs text-muted">
        Use the magic link account for {invitedEmail}.
      </p>
    </div>
  );
}

