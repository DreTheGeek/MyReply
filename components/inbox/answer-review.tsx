"use client";

/**
 * Answer Review
 *
 * The queue where a human closes the loop on what the assistant told customers.
 *
 * The layout is an argument. The customer's question sits above the answer,
 * because the question is what a reviewer has to judge against. The confidence
 * and the sources sit between them, because "why did it say that" is the second
 * thing anyone asks. And Wrong opens a correction box that cannot be skipped,
 * because a Wrong with nothing behind it teaches the assistant nothing and the
 * same customer gets the same wrong answer next week.
 */

import { useEffect, useState } from "react";

export type WorkspaceRoleName = "OWNER" | "ADMIN" | "MEMBER";

interface AnswerSource {
  chunkId: string;
  sourceTitle: string;
  citation: string | null;
  excerpt: string;
}

interface AnswerRow {
  id: string;
  question: string;
  answer: string;
  confidence: number;
  handedOff: boolean;
  verdict: "GOOD" | "WRONG" | null;
  correction: string | null;
  createdAt: string;
  contact: { id: string; username: string | null; name: string | null } | null;
  sources: AnswerSource[];
}

interface AnswersPayload {
  answers: AnswerRow[];
  nextCursor: string | null;
  unreviewedCount: number;
}

export interface AnswerReviewProps {
  /** Owners and admins can record a verdict. Members read the queue. */
  currentUserRole: WorkspaceRoleName | null;
}

type FilterId = "unreviewed" | "handed_off" | "all";

const FILTERS: Array<{ id: FilterId; label: string; query: string }> = [
  { id: "unreviewed", label: "Needs review", query: "?unreviewed=1" },
  { id: "handed_off", label: "Handed to a human", query: "?handedOff=1" },
  { id: "all", label: "All answers", query: "" },
];

const MAX_CORRECTION_CHARS = 2000;

function confidenceTone(value: number): string {
  if (value >= 0.75) return "border-success/40 text-success";
  if (value >= 0.5) return "border-accent/40 text-accent";
  if (value >= 0.3) return "border-warning/40 text-warning";
  return "border-error/40 text-error";
}

function whoAsked(row: AnswerRow): string {
  if (!row.contact) return "Someone";
  if (row.contact.username) return `@${row.contact.username}`;
  return row.contact.name || "Someone";
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString();
}

export default function AnswerReview({
  currentUserRole,
}: AnswerReviewProps): React.JSX.Element {
  const [filter, setFilter] = useState<FilterId>("unreviewed");
  const [payload, setPayload] = useState<AnswersPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const [notice, setNotice] = useState("");

  // Bumped by anything that should refetch the current filter. The effect below
  // is the only place that loads, so a reload is a state change rather than a
  // second code path that could drift from it.
  const [reloadToken, setReloadToken] = useState(0);

  const canReview = currentUserRole === "OWNER" || currentUserRole === "ADMIN";

  // Fetching lives in the effect and every setState happens in a callback, not
  // in the effect body. A synchronous setState here would cascade a render on
  // every mount and filter change.
  useEffect(() => {
    let cancelled = false;
    const query = FILTERS.find((entry) => entry.id === filter)?.query ?? "";

    fetch(`/api/assistant/answers${query}`)
      .then((response) => response.json())
      .then((body: { success?: boolean; data?: AnswersPayload; error?: string }) => {
        if (cancelled) return;
        if (!body.success || !body.data) {
          setError(body.error || "Could not load the review queue.");
          return;
        }
        setError("");
        setPayload(body.data);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the review queue.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filter, reloadToken]);

  function reload(): void {
    setLoading(true);
    setReloadToken((token) => token + 1);
  }

  async function submitVerdict(
    id: string,
    verdict: "GOOD" | "WRONG"
  ): Promise<void> {
    setBusyId(id);
    setError("");
    setNotice("");

    try {
      const response = await fetch(`/api/assistant/answers/${id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          verdict,
          ...(verdict === "WRONG" ? { correction: correction.trim() } : {}),
        }),
      });
      const body: {
        success?: boolean;
        data?: { fedBack: boolean };
        error?: string;
      } = await response.json();

      if (!response.ok || !body.success) {
        setError(body.error || "Could not record that review.");
        return;
      }

      setCorrecting(null);
      setCorrection("");
      setNotice(
        body.data?.fedBack
          ? "Correction saved to your knowledge base. The assistant will use it next time."
          : "Marked as good."
      );
      reload();
    } catch {
      setError("Could not record that review.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">
            Assistant answers
          </h2>
          <p className="text-sm text-muted">
            What the assistant told customers, and what it held back. Marking one
            wrong writes your version into the knowledge base.
          </p>
        </div>
        {payload ? (
          <span className="rounded border border-border px-2 py-1 text-xs text-muted">
            {payload.unreviewedCount} unreviewed
          </span>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => {
              if (entry.id === filter) return;
              setLoading(true);
              setFilter(entry.id);
            }}
            className={
              entry.id === filter
                ? "rounded border border-accent/40 bg-surface px-3 py-1.5 text-sm text-accent"
                : "rounded border border-border px-3 py-1.5 text-sm text-muted hover:border-border-hover hover:text-foreground"
            }
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error ? <p className="text-sm text-error">{error}</p> : null}
      {notice ? <p className="text-sm text-success">{notice}</p> : null}

      {loading ? (
        <p className="text-sm text-muted">Loading answers...</p>
      ) : !payload || payload.answers.length === 0 ? (
        <p className="panel rounded p-5 text-sm text-muted">
          Nothing here yet. Answers appear once the assistant starts replying to
          DMs that match none of your campaigns.
        </p>
      ) : (
        <ul className="space-y-3">
          {payload.answers.map((row) => (
            <li key={row.id} className="panel rounded p-5 space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="text-foreground">{whoAsked(row)}</span>
                <span>{formatWhen(row.createdAt)}</span>
                <span
                  className={`rounded border px-2 py-0.5 font-mono ${confidenceTone(
                    row.confidence
                  )}`}
                >
                  {Math.round(row.confidence * 100)}% confidence
                </span>
                {row.handedOff ? (
                  <span className="rounded border border-warning/40 px-2 py-0.5 text-warning">
                    Not sent, handed to a human
                  </span>
                ) : (
                  <span className="rounded border border-border px-2 py-0.5">
                    Sent
                  </span>
                )}
                {row.verdict ? (
                  <span
                    className={
                      row.verdict === "GOOD"
                        ? "rounded border border-success/40 px-2 py-0.5 text-success"
                        : "rounded border border-error/40 px-2 py-0.5 text-error"
                    }
                  >
                    Reviewed: {row.verdict === "GOOD" ? "good" : "wrong"}
                  </span>
                ) : null}
              </div>

              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  They asked
                </p>
                <p className="text-sm text-foreground">{row.question}</p>
              </div>

              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  It answered
                </p>
                <p className="whitespace-pre-wrap text-sm text-foreground">
                  {row.answer}
                </p>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs uppercase tracking-wide text-muted">
                  Sources for this question
                </p>
                {row.sources.length === 0 ? (
                  <p className="text-sm text-muted">
                    Nothing in your knowledge base matches this question, which
                    is why it scored low.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {row.sources.map((source) => (
                      <li
                        key={source.chunkId}
                        className="rounded border border-border bg-background p-3"
                      >
                        <p className="text-xs text-foreground">
                          {source.sourceTitle}
                          {source.citation ? (
                            <span className="text-muted">
                              {" "}
                              &middot; {source.citation}
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {source.excerpt}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {row.correction ? (
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted">
                    Your correction
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-foreground">
                    {row.correction}
                  </p>
                </div>
              ) : null}

              {!canReview ? (
                <p className="text-xs text-muted">
                  Only owners and admins can review answers.
                </p>
              ) : correcting === row.id ? (
                <div className="space-y-2">
                  <label
                    htmlFor={`correction-${row.id}`}
                    className="block text-sm text-foreground"
                  >
                    What should it have said?
                  </label>
                  <textarea
                    id={`correction-${row.id}`}
                    value={correction}
                    maxLength={MAX_CORRECTION_CHARS}
                    rows={4}
                    onChange={(event) => setCorrection(event.target.value)}
                    placeholder="Write the answer you would have sent. This goes straight into the knowledge base."
                    className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busyId === row.id || !correction.trim()}
                      onClick={() => submitVerdict(row.id, "WRONG")}
                      className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
                    >
                      {busyId === row.id ? "Saving..." : "Save correction"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCorrecting(null);
                        setCorrection("");
                      }}
                      className="rounded px-3 py-2 text-sm text-muted"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => submitVerdict(row.id, "GOOD")}
                    className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:border-success/40 hover:text-success disabled:opacity-50"
                  >
                    Good
                  </button>
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => {
                      setCorrecting(row.id);
                      setCorrection(row.correction ?? "");
                      setNotice("");
                    }}
                    className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:border-error/40 hover:text-error disabled:opacity-50"
                  >
                    Wrong
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
