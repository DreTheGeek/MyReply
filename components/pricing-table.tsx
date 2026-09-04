"use client";

/**
 * Pricing table.
 *
 * Every price, every bullet and every "unlimited" on this page comes from
 * lib/plans, which is the same table requirePlan enforces. Nothing here is
 * typed by hand, so the page cannot promise a feature the gate would refuse or
 * quietly keep advertising one that moved to Pro.
 */

import { useState, type ReactElement } from "react";
import Link from "next/link";
import {
  PLAN_LIMITS,
  getPricingTiers,
  isUnlimited,
  monthlyPriceFor,
  type BillingPeriod,
  type PlanLimits,
  type PlanLimitValue,
  type PricingTier,
} from "@/lib/plans";

interface PricingTableProps {
  /** Where both calls to action point. Billing is not wired up yet. */
  ctaHref?: string;
}

const PERIODS: ReadonlyArray<{ id: BillingPeriod; label: string }> = [
  { id: "monthly", label: "Monthly" },
  { id: "annual", label: "Annual" },
];

/** The free tier's uncapped rows, named from the limits the gate reads. */
const UNCAPPED_LABELS: ReadonlyArray<[keyof PlanLimits, string]> = [
  ["contacts", "Contacts"],
  ["automations", "Automations"],
  ["dmsPerMonth", "DMs a month"],
  ["trackedLinks", "Tracked links"],
  ["apiRequests", "API requests"],
];

function formatLimit(value: PlanLimitValue): string {
  return isUnlimited(value) ? "Unlimited" : String(value);
}

function formatPrice(amount: number): string {
  return `$${amount}`;
}

function Check(): ReactElement {
  return (
    <span aria-hidden="true" className="mt-1 shrink-0 font-mono text-accent">
      +
    </span>
  );
}

function TierCard({
  tier,
  period,
  featured,
  ctaHref,
}: {
  tier: PricingTier;
  period: BillingPeriod;
  featured: boolean;
  ctaHref: string;
}): ReactElement {
  const price = monthlyPriceFor(tier.plan, period);
  const paid = tier.monthlyUsd > 0;
  const bullets = paid ? tier.addedFeatures : tier.features;

  return (
    <div
      className={`rounded-lg border p-7 ${
        featured ? "border-accent bg-surface" : "border-border bg-surface"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-display text-xl font-bold">{tier.name}</h3>
        {featured ? (
          <span className="rounded-full bg-accent px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-on-accent">
            Adds the AI
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted">{tier.tagline}</p>

      <p className="mt-6 font-display text-4xl font-bold tabular-nums">
        {formatPrice(price)}
        {paid ? (
          <span className="ml-1 text-base font-medium text-muted">/month</span>
        ) : null}
      </p>
      <p className="mt-1 min-h-[1.25rem] text-sm text-muted">
        {paid
          ? period === "annual"
            ? `Billed annually at ${formatPrice(tier.annualTotalUsd)}, which is ${tier.annualSavingPercent}% off the monthly price.`
            : `Or ${formatPrice(tier.annualMonthlyUsd)} a month billed annually, ${tier.annualSavingPercent}% less.`
          : "No card, no trial clock, no expiry."}
      </p>

      <ul className="mt-6 space-y-2.5 text-sm text-muted">
        {paid ? (
          <li className="flex gap-2">
            <Check />
            <span className="text-foreground">Everything in Free</span>
          </li>
        ) : null}
        {bullets.map((feature) => (
          <li key={feature.key} className="flex gap-2">
            <Check />
            <span>
              <span className="text-foreground">{feature.label}.</span>{" "}
              {feature.summary}
            </span>
          </li>
        ))}
        {paid ? null : (
          <li className="flex gap-2">
            <Check />
            <span>
              <span className="text-foreground">One seat.</span> Invite the rest
              of the team on Pro.
            </span>
          </li>
        )}
      </ul>

      <Link
        href={ctaHref}
        className={
          featured
            ? "mt-7 inline-flex w-full items-center justify-center rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent transition hover:bg-accent-hover"
            : "mt-7 inline-flex w-full items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm font-semibold transition hover:border-border-hover hover:bg-surface-hover"
        }
      >
        Start free
      </Link>
    </div>
  );
}

export default function PricingTable({
  ctaHref = "/login",
}: PricingTableProps): ReactElement {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const tiers = getPricingTiers();
  const paidTier = tiers.find((tier) => tier.monthlyUsd > 0);

  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="group"
          aria-label="Billing period"
          className="inline-flex w-fit rounded-md border border-border bg-surface p-1"
        >
          {PERIODS.map((option) => {
            const active = option.id === period;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => setPeriod(option.id)}
                className={`rounded px-4 py-1.5 text-sm font-semibold transition ${
                  active
                    ? "bg-accent text-on-accent"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {paidTier ? (
          <p className="text-sm text-muted">
            Annual billing takes {paidTier.annualSavingPercent}% off Pro.
          </p>
        ) : null}
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {tiers.map((tier) => (
          <TierCard
            key={tier.plan}
            tier={tier}
            period={period}
            featured={tier.monthlyUsd > 0}
            ctaHref={ctaHref}
          />
        ))}
      </div>

      <div className="mt-10 overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[34rem] text-sm">
          <caption className="border-b border-border bg-surface px-5 py-3 text-left text-sm text-muted">
            What we never meter, on the free plan.
          </caption>
          <thead>
            <tr className="border-b border-border bg-surface text-left">
              <th className="px-5 py-3 font-mono text-xs font-medium uppercase tracking-wide text-muted">
                Counted elsewhere
              </th>
              <th className="px-5 py-3 font-mono text-xs font-medium uppercase tracking-wide text-muted">
                MyReply Free
              </th>
              <th className="px-5 py-3 font-mono text-xs font-medium uppercase tracking-wide text-muted">
                MyReply Pro
              </th>
            </tr>
          </thead>
          <tbody>
            {UNCAPPED_LABELS.map(([key, label]) => (
              <tr key={key} className="border-b border-border last:border-0">
                <td className="px-5 py-3 text-foreground">{label}</td>
                <td className="px-5 py-3 font-mono font-semibold tabular-nums text-accent">
                  {formatLimit(PLAN_LIMITS.FREE[key])}
                </td>
                <td className="px-5 py-3 font-mono font-semibold tabular-nums text-accent">
                  {formatLimit(PLAN_LIMITS.PRO[key])}
                </td>
              </tr>
            ))}
            <tr className="border-b border-border last:border-0">
              <td className="px-5 py-3 text-foreground">Team seats</td>
              <td className="px-5 py-3 font-mono tabular-nums text-muted">
                {formatLimit(PLAN_LIMITS.FREE.teamSeats)}
              </td>
              <td className="px-5 py-3 font-mono font-semibold tabular-nums text-accent">
                {formatLimit(PLAN_LIMITS.PRO.teamSeats)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
