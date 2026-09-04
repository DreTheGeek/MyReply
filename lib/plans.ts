import type { WorkspacePlan } from "@/app/generated/prisma/client";

/**
 * The plan model, as one declarative table.
 *
 * The rule this file encodes, and the only rule worth remembering: anything
 * that does not cost us money per use is free. Automations, contacts, DMs,
 * tags, every trigger, the inbox, reports, the REST API, the MCP server and
 * BYOK AI all run on the customer's own quota or on storage we would pay for
 * anyway, so gating them would be charging for nothing. Paid is reserved for
 * inference we buy, storage we index, and the surfaces built for teams.
 *
 * BYOK AI is deliberately on FREE. The customer supplies the provider key, the
 * inference bill is theirs, and by our own rule that makes it free. Moving it
 * to PRO would be the single easiest way to break the promise this file exists
 * to keep.
 *
 * Deliberately a leaf module, like lib/roles. It imports one generated type and
 * nothing else, so a route, a worker, a test and the marketing page can all
 * read the same table without dragging Prisma or NextAuth in behind it. The
 * pricing table renders from these exports, so what the page claims and what
 * the gate enforces cannot drift apart.
 */

/** Higher wins. Mirrors the shape of lib/roles so the two read alike. */
const PLAN_ORDER: Record<WorkspacePlan, number> = {
  FREE: 1,
  PRO: 2,
};

/**
 * Every plan there is, low to high. Kept as a literal tuple so a schema can be
 * built from it rather than restating the list somewhere a new plan would miss.
 */
export const PLAN_IDS = ["FREE", "PRO"] as const satisfies readonly WorkspacePlan[];

export type PlanFeature =
  // Free, because none of it costs us anything per use.
  | "automations"
  | "contacts"
  | "dm_sends"
  | "tags"
  | "triggers"
  | "quick_replies"
  | "persistent_menu"
  | "conversation_starters"
  | "tracked_links"
  | "inbox"
  | "analytics"
  | "rest_api"
  | "mcp_server"
  | "byok_ai"
  // Paid, because each one has a bill or a team behind it.
  | "managed_ai"
  | "knowledge_base"
  | "ai_dm_answering"
  | "advanced_flows"
  | "multi_account"
  | "team_seats"
  | "white_label_reports";

/**
 * Why a feature sits where it sits. Written down so a future gate has to argue
 * with a reason rather than quietly move a line.
 */
export type PlanFeatureReason =
  /** Costs us nothing per use, so it is free and unmetered. */
  | "no_marginal_cost"
  /** We pay a provider per call, so it is paid. */
  | "metered_cost"
  /** Real engineering leverage for teams and agencies, so it is paid. */
  | "engineering_leverage";

export interface PlanFeatureSpec {
  readonly key: PlanFeature;
  readonly label: string;
  readonly summary: string;
  /** The lowest plan that includes this feature. */
  readonly minimumPlan: WorkspacePlan;
  readonly reason: PlanFeatureReason;
}

/**
 * The whole matrix. One place to look, so a feature cannot be gated in a route
 * and left ungated on the page, or the other way round.
 */
export const PLAN_FEATURES: readonly PlanFeatureSpec[] = [
  {
    key: "automations",
    label: "Unlimited automations",
    summary:
      "Build as many as you want. There is no count, no cap, and no upgrade prompt at four.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "contacts",
    label: "Unlimited contacts",
    summary:
      "Every person who ever replies is yours to keep. We never charge by how many there are.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "dm_sends",
    label: "Unlimited DMs",
    summary:
      "Sends go out on your own Instagram quota, so the only ceiling is Meta's.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "tags",
    label: "Unlimited tags and segments",
    summary: "Tag contacts however you like and filter on any of it.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "triggers",
    label: "Every trigger",
    summary:
      "Comments, DM keywords, story replies, story mentions, Live comments and referral links. All of them, on every plan.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "quick_replies",
    label: "Quick replies",
    summary: "Saved answers your team can drop into any conversation.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "persistent_menu",
    label: "Persistent menu",
    summary: "The menu that sits under every conversation on your account.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "conversation_starters",
    label: "Conversation starters",
    summary: "The prompts a new person sees before they have typed anything.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "tracked_links",
    label: "Tracked links",
    summary:
      "Every link wrapped, every click attributed to the campaign and the account it came from.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "inbox",
    label: "The full inbox",
    summary: "Read and reply to every conversation, with the whole history.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "analytics",
    label: "Analytics and reports",
    summary:
      "Sends, clicks, keyword breakdown and follower history kept past Instagram's own thirty day window.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "rest_api",
    label: "The REST API",
    summary:
      "The same API we build on, with your own keys. Not an add-on and not a tier.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "mcp_server",
    label: "The MCP server",
    summary:
      "Point Claude or any MCP client at your workspace and let it do the work.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "byok_ai",
    label: "AI with your own key",
    summary:
      "Bring a key from your own provider and the AI features run on it. Your inference bill, so no charge from us.",
    minimumPlan: "FREE",
    reason: "no_marginal_cost",
  },
  {
    key: "managed_ai",
    label: "Managed AI, no key needed",
    summary:
      "We supply the model and pay the provider. Nothing to sign up for and nothing to paste in.",
    minimumPlan: "PRO",
    reason: "metered_cost",
  },
  {
    key: "knowledge_base",
    label: "Knowledge base",
    summary:
      "Feed it your pages and documents so answers come from what you actually sell.",
    minimumPlan: "PRO",
    reason: "metered_cost",
  },
  {
    key: "ai_dm_answering",
    label: "AI answering your DMs",
    summary:
      "Real questions in the inbox answered from the knowledge base, not from a keyword table.",
    minimumPlan: "PRO",
    reason: "metered_cost",
  },
  {
    key: "advanced_flows",
    label: "Advanced flows",
    summary:
      "Branches, conditions and multi step sequences for campaigns that need more than one path.",
    minimumPlan: "PRO",
    reason: "engineering_leverage",
  },
  {
    key: "multi_account",
    label: "More than one Instagram account",
    summary:
      "Run every client from one workspace. Free covers one account in full, with nothing else held back.",
    minimumPlan: "PRO",
    reason: "metered_cost",
  },
  {
    key: "team_seats",
    label: "Team seats",
    summary:
      "Invite the rest of the team with owner, admin and member roles. One seat is free.",
    minimumPlan: "PRO",
    reason: "engineering_leverage",
  },
  {
    key: "white_label_reports",
    label: "White label client reports",
    summary:
      "Share links under your own brand, for clients who never need to see ours.",
    minimumPlan: "PRO",
    reason: "engineering_leverage",
  },
] as const;

const FEATURE_INDEX: ReadonlyMap<PlanFeature, PlanFeatureSpec> = new Map(
  PLAN_FEATURES.map((feature) => [feature.key, feature])
);

export function isPlanFeature(value: string): value is PlanFeature {
  return FEATURE_INDEX.has(value as PlanFeature);
}

export function getPlanFeature(feature: PlanFeature): PlanFeatureSpec {
  const spec = FEATURE_INDEX.get(feature);
  if (!spec) {
    // Unreachable while PlanFeature and PLAN_FEATURES agree, which the type
    // system enforces at every call site. Thrown rather than defaulted so a
    // future key added to the union without a row here fails loudly.
    throw new Error(`Unknown plan feature: ${feature}`);
  }
  return spec;
}

export function planIncludes(
  plan: WorkspacePlan,
  minimumPlan: WorkspacePlan
): boolean {
  return PLAN_ORDER[plan] >= PLAN_ORDER[minimumPlan];
}

export function planHasFeature(
  plan: WorkspacePlan,
  feature: PlanFeature
): boolean {
  return planIncludes(plan, getPlanFeature(feature).minimumPlan);
}

/** Everything this plan can do, in table order. */
export function featuresForPlan(
  plan: WorkspacePlan
): readonly PlanFeatureSpec[] {
  return PLAN_FEATURES.filter((feature) =>
    planIncludes(plan, feature.minimumPlan)
  );
}

/** What this plan adds on top of the one below it. Empty for FREE. */
export function featuresAddedByPlan(
  plan: WorkspacePlan
): readonly PlanFeatureSpec[] {
  return PLAN_FEATURES.filter((feature) => feature.minimumPlan === plan);
}

/** The feature keys a plan holds, for a response body. */
export function planFeatureKeys(plan: WorkspacePlan): readonly PlanFeature[] {
  return featuresForPlan(plan).map((feature) => feature.key);
}

/**
 * 402 Payment Required. The refusal is about the plan, not about who is asking,
 * so it is not a 403. A client can tell the two apart without parsing prose.
 */
export const PLAN_GATE_STATUS = 402 as const;

export type PlanGateResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly status: typeof PLAN_GATE_STATUS;
      readonly feature: PlanFeature;
      readonly requiredPlan: WorkspacePlan;
      readonly error: string;
    };

/**
 * The one gate. Every route that needs a paid feature calls this and returns
 * the refusal verbatim, so the wording and the status code stay identical
 * across the product.
 */
export function requirePlan(
  plan: WorkspacePlan,
  feature: PlanFeature
): PlanGateResult {
  const spec = getPlanFeature(feature);
  if (planIncludes(plan, spec.minimumPlan)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    status: PLAN_GATE_STATUS,
    feature: spec.key,
    requiredPlan: spec.minimumPlan,
    error: `${spec.label} is on ${PLAN_PRICING[spec.minimumPlan].name}. Upgrade to turn it on.`,
  };
}

/** A cap that has no number, because there is no cap. */
export const UNLIMITED = "unlimited" as const;

export type PlanLimitValue = typeof UNLIMITED | number;

export interface PlanLimits {
  readonly automations: PlanLimitValue;
  readonly contacts: PlanLimitValue;
  readonly dmsPerMonth: PlanLimitValue;
  readonly tags: PlanLimitValue;
  readonly trackedLinks: PlanLimitValue;
  readonly instagramAccounts: PlanLimitValue;
  readonly apiRequests: PlanLimitValue;
  /** The one number that moves. One seat free, the team on Pro. */
  readonly teamSeats: PlanLimitValue;
}

/**
 * What is unlimited, named. The pricing table reads this rather than restating
 * it in copy, so the page cannot promise a ceiling the product does not have.
 */
export const PLAN_LIMITS: Record<WorkspacePlan, PlanLimits> = {
  FREE: {
    automations: UNLIMITED,
    contacts: UNLIMITED,
    dmsPerMonth: UNLIMITED,
    tags: UNLIMITED,
    trackedLinks: UNLIMITED,
    // The one resource on Free that is capped, and the only one where the
    // zero-marginal-cost rule does not hold: every connected account multiplies
    // webhook volume, worker load and stored rows for as long as it stays
    // connected. It is also the agency signal, so it is the natural upgrade
    // moment. One account is a whole product; the second is a business.
    instagramAccounts: 1,
    apiRequests: UNLIMITED,
    teamSeats: 1,
  },
  PRO: {
    automations: UNLIMITED,
    contacts: UNLIMITED,
    dmsPerMonth: UNLIMITED,
    tags: UNLIMITED,
    trackedLinks: UNLIMITED,
    instagramAccounts: UNLIMITED,
    apiRequests: UNLIMITED,
    teamSeats: UNLIMITED,
  },
};

export function isUnlimited(value: PlanLimitValue): boolean {
  return value === UNLIMITED;
}

export interface PlanPricing {
  readonly plan: WorkspacePlan;
  readonly name: string;
  readonly tagline: string;
  readonly monthlyUsd: number;
  /** The per month figure when the year is paid up front. */
  readonly annualMonthlyUsd: number;
  /** What that year actually costs. */
  readonly annualTotalUsd: number;
}

export const PLAN_PRICING: Record<WorkspacePlan, PlanPricing> = {
  FREE: {
    plan: "FREE",
    name: "Free",
    tagline: "Everything that costs us nothing to run. Forever.",
    monthlyUsd: 0,
    annualMonthlyUsd: 0,
    annualTotalUsd: 0,
  },
  PRO: {
    plan: "PRO",
    name: "Pro",
    tagline: "For when you want the AI bill to be ours and the team to grow.",
    monthlyUsd: 69,
    annualMonthlyUsd: 49,
    annualTotalUsd: 588,
  },
};

/** Rounded to a whole percent, which is how a price page should say it. */
export function annualSavingPercent(plan: WorkspacePlan): number {
  const pricing = PLAN_PRICING[plan];
  if (pricing.monthlyUsd <= 0) return 0;
  const yearAtMonthly = pricing.monthlyUsd * 12;
  return Math.round(
    ((yearAtMonthly - pricing.annualTotalUsd) / yearAtMonthly) * 100
  );
}

export type BillingPeriod = "monthly" | "annual";

/** The per month figure to show for a period. */
export function monthlyPriceFor(
  plan: WorkspacePlan,
  period: BillingPeriod
): number {
  const pricing = PLAN_PRICING[plan];
  return period === "annual" ? pricing.annualMonthlyUsd : pricing.monthlyUsd;
}

export interface PricingTier {
  readonly plan: WorkspacePlan;
  readonly name: string;
  readonly tagline: string;
  readonly monthlyUsd: number;
  readonly annualMonthlyUsd: number;
  readonly annualTotalUsd: number;
  readonly annualSavingPercent: number;
  readonly limits: PlanLimits;
  /** Everything the plan can do. */
  readonly features: readonly PlanFeatureSpec[];
  /** Only what this plan adds over the one below it. */
  readonly addedFeatures: readonly PlanFeatureSpec[];
}

/**
 * The pricing table's entire data source. Derived, never hand written, so a
 * bullet on the page cannot claim something requirePlan would refuse.
 */
export function getPricingTiers(): readonly PricingTier[] {
  return PLAN_IDS.map((plan) => {
    const pricing = PLAN_PRICING[plan];
    return {
      plan,
      name: pricing.name,
      tagline: pricing.tagline,
      monthlyUsd: pricing.monthlyUsd,
      annualMonthlyUsd: pricing.annualMonthlyUsd,
      annualTotalUsd: pricing.annualTotalUsd,
      annualSavingPercent: annualSavingPercent(plan),
      limits: PLAN_LIMITS[plan],
      features: featuresForPlan(plan),
      addedFeatures: featuresAddedByPlan(plan),
    };
  });
}

export interface PlanEntitlements {
  readonly plan: WorkspacePlan;
  readonly name: string;
  readonly features: readonly PlanFeature[];
  readonly limits: PlanLimits;
  readonly locked: readonly PlanFeatureSpec[];
}

/** What a workspace has, and what it does not, in one object a route can return. */
export function getPlanEntitlements(plan: WorkspacePlan): PlanEntitlements {
  return {
    plan,
    name: PLAN_PRICING[plan].name,
    features: planFeatureKeys(plan),
    limits: PLAN_LIMITS[plan],
    locked: PLAN_FEATURES.filter(
      (feature) => !planIncludes(plan, feature.minimumPlan)
    ),
  };
}
