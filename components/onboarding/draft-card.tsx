"use client";

/**
 * One finished automation, offered as a card.
 *
 * Everything on it is already decided. The post, the keyword, the DM and the
 * public replies are shown so the user can see what they are turning on, not
 * so they can fill anything in. Activate is the primary action and the only
 * one anybody needs; Edit is quiet, and exists for the minority who want to
 * change something before it goes live.
 */

import type { OnboardingDraft } from "@/lib/onboarding/types";

export type DraftState = "idle" | "activating" | "editing" | "active";

interface DraftCardProps {
  draft: OnboardingDraft;
  state: DraftState;
  /** Disabled while any other card on the screen is mid-flight. */
  disabled: boolean;
  error: string | null;
  onActivate: () => void;
  onEdit: () => void;
}

export default function DraftCard({
  draft,
  state,
  disabled,
  error,
  onActivate,
  onEdit,
}: DraftCardProps): React.JSX.Element {
  const busy = state === "activating" || state === "editing";
  const activated = state === "active";

  return (
    <article className="panel rounded p-4 sm:p-5">
      <div className="flex gap-4">
        {draft.post?.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={draft.post.thumbnailUrl}
            alt=""
            className="h-20 w-20 shrink-0 rounded object-cover"
          />
        ) : (
          <div className="grid h-20 w-20 shrink-0 place-items-center rounded border border-border bg-surface-hover text-center text-[10px] font-medium text-muted">
            Any post
          </div>
        )}

        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            {draft.goalLabel}
          </p>
          <p className="mt-1 text-sm font-medium text-foreground">
            {draft.summary}
          </p>
          {draft.postContext && (
            <p className="mt-1 text-xs text-muted">{draft.postContext}</p>
          )}
        </div>
      </div>

      <dl className="mt-4 space-y-3">
        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            They comment
          </dt>
          <dd className="mt-1 flex flex-wrap gap-1.5">
            {draft.automation.matchAnyWord ? (
              // This campaign answers everyone, so there is no keyword to show
              // and the create route discards the list anyway.
              <span className="rounded border border-accent/40 px-2 py-0.5 text-xs text-accent">
                Anything at all
              </span>
            ) : (
              draft.automation.keywords.map((keyword) => (
                <span
                  key={keyword}
                  className="rounded border border-accent/40 px-2 py-0.5 font-mono text-xs text-accent"
                >
                  {keyword}
                </span>
              ))
            )}
          </dd>
        </div>

        <div>
          <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            They get
          </dt>
          <dd className="mt-1 whitespace-pre-line rounded border border-border bg-surface px-3 py-2 text-xs text-foreground">
            {draft.dmMessage}
          </dd>
        </div>

        {draft.publicReplyMessages.length > 0 && (
          <div>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              You reply publicly with one of
            </dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {draft.publicReplyMessages.map((reply) => (
                <span
                  key={reply}
                  className="rounded border border-border px-2 py-0.5 text-xs text-muted"
                >
                  {reply}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>

      {error && <p className="mt-3 text-xs text-error">{error}</p>}

      <div className="mt-4 flex items-center gap-3">
        {activated ? (
          draft.needsLink ? (
            // Saved, but deliberately not sending. Saying "live" here would be
            // a lie, and the person would find out from a customer.
            <p className="text-sm text-warning">
              Saved and paused. Its message offers a link and your caption had
              none, so add one on the campaign and switch it on there.
            </p>
          ) : (
            <p className="text-sm font-semibold text-success">This one is live.</p>
          )
        ) : (
          <>
            <button
              type="button"
              onClick={onActivate}
              disabled={disabled || busy}
              className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {state === "activating" ? "Activating..." : "Activate"}
            </button>
            <button
              type="button"
              onClick={onEdit}
              disabled={disabled || busy}
              className="rounded border border-border px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground disabled:opacity-50"
            >
              {state === "editing" ? "Opening..." : "Edit first"}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
