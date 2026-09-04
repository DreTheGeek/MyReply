"use client";

/**
 * Answering Section
 *
 * The switch that decides whether a model replies to customers in the DM
 * inbox, and the three numbers that shape what it does when it is on.
 *
 * Written to be readable by somebody who has to defend it. Every control says
 * what happens when it is wrong, because the failure mode here is not a broken
 * page, it is a business telling a customer something untrue.
 */

import { useEffect, useState, type FormEvent } from "react";

export type WorkspaceRoleName = "OWNER" | "ADMIN" | "MEMBER";

export interface AnsweringSectionProps {
  /**
   * The signed-in user's role in this workspace, or null while it is still
   * loading. Owners and admins can change these; members read only, which
   * mirrors the gate the API itself applies.
   */
  currentUserRole: WorkspaceRoleName | null;
}

interface AnsweringSettings {
  enabled: boolean;
  confidenceThreshold: number;
  autoPauseMinutes: number;
  disclosure: string;
}

const ENDPOINT = "/api/assistant/answers/settings";

const MAX_DISCLOSURE_LENGTH = 200;

const PAUSE_OPTIONS: Array<{ label: string; minutes: number }> = [
  { label: "Off", minutes: 0 },
  { label: "15 minutes", minutes: 15 },
  { label: "30 minutes", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "24 hours", minutes: 1440 },
];

function describeThreshold(value: number): string {
  if (value >= 0.85) {
    return "Very strict. Almost everything goes to a human. Use this while you are still building the knowledge base.";
  }
  if (value >= 0.7) {
    return "Strict. Only answers with strong support in your knowledge base are sent.";
  }
  if (value >= 0.5) {
    return "Balanced. The default. Well supported answers send, thin ones wait for a person.";
  }
  if (value >= 0.3) {
    return "Loose. Weakly supported answers will reach customers. Watch the review queue closely.";
  }
  return "Almost nothing is held back. Not recommended.";
}

function isSettings(value: unknown): value is AnsweringSettings {
  return (
    typeof value === "object" &&
    value !== null &&
    "enabled" in value &&
    "confidenceThreshold" in value
  );
}

export default function AnsweringSection({
  currentUserRole,
}: AnsweringSectionProps): React.JSX.Element {
  const [settings, setSettings] = useState<AnsweringSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const canManage = currentUserRole === "OWNER" || currentUserRole === "ADMIN";

  useEffect(() => {
    let cancelled = false;

    fetch(ENDPOINT)
      .then((response) => response.json())
      .then((payload: { success?: boolean; data?: unknown }) => {
        if (cancelled) return;
        if (!payload.success || !isSettings(payload.data)) {
          setError("Could not load the answering settings.");
          return;
        }
        setSettings(payload.data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the answering settings.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function update(patch: Partial<AnsweringSettings>): void {
    setSettings((current) => (current ? { ...current, ...patch } : current));
    setNotice("");
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!settings) return;

    setError("");
    setNotice("");
    setSaving(true);

    try {
      const response = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: settings.enabled,
          confidenceThreshold: settings.confidenceThreshold,
          autoPauseMinutes: settings.autoPauseMinutes,
          disclosure: settings.disclosure,
        }),
      });
      const payload: { success?: boolean; data?: unknown; error?: string } =
        await response.json();

      if (!response.ok || !payload.success || !isSettings(payload.data)) {
        setError(payload.error || "Could not save those settings.");
        return;
      }

      setSettings(payload.data);
      setNotice("Saved.");
    } catch {
      setError("Could not save those settings. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="panel rounded p-5">
        <p className="text-sm text-muted">Loading answering settings...</p>
      </section>
    );
  }

  if (!settings) {
    return (
      <section className="panel rounded p-5">
        <p className="text-sm text-error">
          {error || "Could not load the answering settings."}
        </p>
      </section>
    );
  }

  const thresholdPercent = Math.round(settings.confidenceThreshold * 100);

  return (
    <section className="panel rounded p-5 space-y-4">
      <header className="space-y-1">
        <h2 className="text-base font-medium text-foreground">
          Answering customers
        </h2>
        <p className="text-sm text-muted">
          When a DM matches none of your campaigns, the assistant can answer it
          from your knowledge base. It answers only from what it finds there,
          and only inside Instagram&apos;s 24 hour reply window. Anything it is
          not sure enough about goes to your review queue instead of the
          customer.
        </p>
      </header>

      <form onSubmit={handleSave} className="space-y-5">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={!canManage}
            onChange={(event) => update({ enabled: event.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--accent)] disabled:opacity-50"
          />
          <span className="space-y-0.5">
            <span className="block text-sm text-foreground">
              Answer unmatched DMs automatically
            </span>
            <span className="block text-xs text-muted">
              Off until you turn it on. Nothing is sent without a knowledge
              source and an AI provider key.
            </span>
          </span>
        </label>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label
              htmlFor="answering-threshold"
              className="block text-sm text-foreground"
            >
              Confidence threshold
            </label>
            <span className="font-mono text-sm text-foreground">
              {thresholdPercent}%
            </span>
          </div>
          <input
            id="answering-threshold"
            type="range"
            min={0}
            max={100}
            step={5}
            value={thresholdPercent}
            disabled={!canManage}
            onChange={(event) =>
              update({ confidenceThreshold: Number(event.target.value) / 100 })
            }
            className="w-full accent-[var(--accent)] disabled:opacity-50"
          />
          <p className="text-xs text-muted">
            {describeThreshold(settings.confidenceThreshold)}
          </p>
          <p className="text-xs text-muted">
            Confidence is measured, not guessed: it combines how much of the
            question your knowledge base actually covers with how much of the
            answer is traceable back to it. An answer below this line is
            recorded and handed to a human, never sent.
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="answering-pause"
            className="block text-sm text-foreground"
          >
            Pause after a human replies
          </label>
          <select
            id="answering-pause"
            value={settings.autoPauseMinutes}
            disabled={!canManage}
            onChange={(event) =>
              update({ autoPauseMinutes: Number(event.target.value) })
            }
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
          >
            {PAUSE_OPTIONS.map((option) => (
              <option key={option.minutes} value={option.minutes}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted">
            When you or a teammate replies to someone by hand, the assistant
            stops answering that person for this long. It counts replies typed
            in the Instagram app too, not only ones sent from here.
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="answering-disclosure"
            className="block text-sm text-foreground"
          >
            Automation disclosure
          </label>
          <input
            id="answering-disclosure"
            type="text"
            value={settings.disclosure}
            maxLength={MAX_DISCLOSURE_LENGTH}
            disabled={!canManage}
            onChange={(event) => update({ disclosure: event.target.value })}
            placeholder="Leave empty to send nothing extra"
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
          />
          <p className="text-xs text-muted">
            Added to the end of every automated reply. Meta requires you to tell
            people in Canada and Germany that they are talking to automation, and
            a DM does not tell you where somebody is, so leaving this on for
            everyone is the only setting that is safe by default.
          </p>
        </div>

        {error ? <p className="text-sm text-error">{error}</p> : null}
        {notice ? <p className="text-sm text-muted">{notice}</p> : null}

        {canManage ? (
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save answering settings"}
          </button>
        ) : (
          <p className="text-sm text-muted">
            Only workspace owners and admins can change these settings.
          </p>
        )}
      </form>
    </section>
  );
}
