"use client";

/**
 * The onboarding screen.
 *
 * A three-step checklist, then five finished automations. There is no form on
 * this page and no empty input anywhere on it: every choice is a tap.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import DraftCard, { type DraftState } from "@/components/onboarding/draft-card";
import type { OnboardingDraft, OnboardingSuggestions } from "@/lib/onboarding/types";

interface OnboardingScreenProps {
  username: string;
  /** True when this workspace already has at least one live campaign. */
  hasLiveCampaign: boolean;
}

interface TestResult {
  status: "sent" | "window_closed";
  message: string;
}

type ApiEnvelope<T> = { success: boolean; error?: string; data?: T };

export default function OnboardingScreen({
  username,
  hasLiveCampaign,
}: OnboardingScreenProps): React.JSX.Element {
  const router = useRouter();

  const [suggestions, setSuggestions] = useState<OnboardingSuggestions | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [cardState, setCardState] = useState<Record<string, DraftState>>({});
  const [cardError, setCardError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // The id of the campaign the user just turned on, which is the one a test
  // send should use.
  const [activatedId, setActivatedId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/onboarding/suggestions", { cache: "no-store" })
      .then((res) => res.json())
      .then((payload: ApiEnvelope<OnboardingSuggestions>) => {
        if (cancelled) return;
        if (!payload.success || !payload.data) {
          setLoadError(payload.error ?? "We could not build your automations.");
          return;
        }
        setSuggestions(payload.data);
      })
      .catch(() => {
        if (!cancelled) setLoadError("We could not build your automations.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Turn a draft into a real campaign.
   *
   * `live` is false for the Edit path: the campaign is created paused and the
   * real campaign editor is opened on it, which is the only way to hand
   * someone a fully prefilled editor without a second copy of the builder.
   */
  const activate = useCallback(
    async (draft: OnboardingDraft, live: boolean): Promise<void> => {
      setBusy(true);
      setCardState((prev) => ({
        ...prev,
        [draft.id]: live ? "activating" : "editing",
      }));
      setCardError((prev) => {
        const next = { ...prev };
        delete next[draft.id];
        return next;
      });

      try {
        const res = await fetch("/api/onboarding/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draftId: draft.id,
            automation: { ...draft.automation, isActive: live },
          }),
        });
        const payload: ApiEnvelope<{ id: string }> = await res.json();

        if (!res.ok || !payload.success || !payload.data) {
          setCardState((prev) => ({ ...prev, [draft.id]: "idle" }));
          setCardError((prev) => ({
            ...prev,
            [draft.id]:
              payload.error ?? "We could not turn this on. Try again shortly.",
          }));
          return;
        }

        if (live) {
          setCardState((prev) => ({ ...prev, [draft.id]: "active" }));
          setActivatedId(payload.data.id);
        } else {
          router.push(`/campaigns/${payload.data.id}/edit`);
        }
      } catch {
        setCardState((prev) => ({ ...prev, [draft.id]: "idle" }));
        setCardError((prev) => ({
          ...prev,
          [draft.id]: "We could not turn this on. Try again shortly.",
        }));
      } finally {
        setBusy(false);
      }
    },
    [router]
  );

  const sendTest = useCallback(async (): Promise<void> => {
    if (!activatedId) return;
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch("/api/onboarding/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ automationId: activatedId }),
      });
      const payload: ApiEnvelope<TestResult> = await res.json();

      if (!payload.success || !payload.data) {
        setTestResult({
          status: "window_closed",
          message: payload.error ?? "We could not send the test.",
        });
        return;
      }
      setTestResult(payload.data);
    } catch {
      setTestResult({
        status: "window_closed",
        message: "We could not send the test. Try again shortly.",
      });
    } finally {
      setTesting(false);
    }
  }, [activatedId]);

  const anyActivated =
    hasLiveCampaign ||
    activatedId !== null ||
    Object.values(cardState).includes("active");
  const tested = testResult?.status === "sent";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
          Five automations, built for @{username}.
        </h1>
        <p className="mt-1 text-sm text-muted">
          {suggestions?.usedFallback
            ? "We could not read your posts yet, so these listen to every post you publish. Tap one to turn it on."
            : "We read your recent posts and wrote these for you. Tap one to turn it on."}
        </p>
      </header>

      <Checklist
        connected
        username={username}
        activated={anyActivated}
        tested={tested}
      />

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-56 rounded border border-border bg-surface/70" />
          ))}
        </div>
      ) : loadError ? (
        <div className="panel rounded p-6">
          <p className="text-sm font-medium text-error">{loadError}</p>
          <p className="mt-1 text-xs text-muted">
            Your campaigns are unaffected. Reconnect Instagram in Settings if
            this keeps happening.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {suggestions?.drafts.map((draft) => (
            <DraftCard
              key={draft.id}
              draft={draft}
              state={cardState[draft.id] ?? "idle"}
              disabled={busy}
              error={cardError[draft.id] ?? null}
              onActivate={() => void activate(draft, true)}
              onEdit={() => void activate(draft, false)}
            />
          ))}
        </div>
      )}

      {activatedId && (
        <section className="panel rounded p-4 sm:p-6">
          <h2 className="text-base font-semibold text-foreground">
            Send yourself a test
          </h2>
          <p className="mt-1 text-xs text-muted">
            Instagram only lets us message someone who has messaged @{username}{" "}
            in the last 24 hours. Send @{username} a DM from your personal
            Instagram, then tap the button and the campaign will reply to you
            exactly as it will reply to a stranger.
          </p>
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={testing}
            className="mt-4 rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {testing ? "Sending..." : "Send test"}
          </button>
          {testResult && (
            <p
              className={`mt-3 text-xs ${
                testResult.status === "sent" ? "text-success" : "text-muted"
              }`}
            >
              {testResult.message}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

interface ChecklistProps {
  connected: boolean;
  username: string;
  activated: boolean;
  tested: boolean;
}

function Checklist({
  connected,
  username,
  activated,
  tested,
}: ChecklistProps): React.JSX.Element {
  const steps: Array<{ label: string; done: boolean }> = [
    { label: `Connect Instagram (@${username})`, done: connected },
    { label: "Turn on an automation", done: activated },
    { label: "Send yourself a test", done: tested },
  ];

  return (
    <ol className="panel flex flex-col gap-2 rounded p-4 sm:flex-row sm:items-center sm:gap-6">
      {steps.map((step, index) => (
        <li key={step.label} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold ${
              step.done
                ? "border-accent bg-accent text-on-accent"
                : "border-border text-muted"
            }`}
          >
            {step.done ? "✓" : index + 1}
          </span>
          <span
            className={`text-xs ${
              step.done ? "text-foreground" : "text-muted"
            }`}
          >
            {step.label}
            <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
