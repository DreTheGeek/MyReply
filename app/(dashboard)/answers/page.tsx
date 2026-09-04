"use client";

/**
 * The answer review queue.
 *
 * Its own page rather than a panel in the inbox, because correcting what the
 * assistant told a customer is a different job from replying to one. The inbox
 * is worked conversation by conversation as messages arrive; this is worked in
 * batches, after the fact, and by whoever owns what the product is allowed to
 * claim.
 *
 * A correction here becomes a knowledge chunk, so the same question cannot get
 * the same wrong answer twice.
 */

import { useEffect, useState } from "react";
import AnswerReview from "@/components/inbox/answer-review";

type Role = "OWNER" | "ADMIN" | "MEMBER";

export default function AnswersPage(): React.JSX.Element {
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/workspace/members")
      .then((res) => res.json())
      .then((payload: { success?: boolean; data?: { currentUserRole?: Role } }) => {
        if (cancelled) return;
        if (payload.success && payload.data?.currentUserRole) {
          setRole(payload.data.currentUserRole);
        }
      })
      .catch(() => {
        // The queue still renders read-only without a resolved role, which is
        // the safe direction: it shows the answers and withholds the verdict
        // controls rather than showing nothing.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-display text-2xl font-bold tracking-tight text-foreground">
          Answers
        </h2>
        <p className="mt-1 text-sm text-muted">
          What the assistant told people, and what it refused to answer. Marking
          one wrong and writing the correct answer teaches it, so the same
          question does not come back the same way.
        </p>
      </div>

      {loading ? (
        <div className="h-64 rounded-lg bg-surface-hover" />
      ) : (
        <AnswerReview currentUserRole={role} />
      )}
    </div>
  );
}
