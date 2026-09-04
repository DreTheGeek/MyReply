import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const { mockPrisma, mockContext } = vi.hoisted(() => ({
  mockPrisma: {
    workspace: {
      update: vi.fn(),
    },
  },
  mockContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

// The real canManageBilling, on purpose. The point of the plan route's gate is
// that it is the role ladder's own rule, not a second copy of it.
vi.mock("@/lib/workspace-access", async () => {
  const roles = await import("../lib/roles");
  return {
    getCurrentWorkspaceContext: mockContext,
    canManageBilling: roles.canManageBilling,
    canManageWorkspace: roles.canManageWorkspace,
    hasWorkspaceRole: roles.hasWorkspaceRole,
  };
});

import { NextRequest } from "next/server";

import {
  PLAN_FEATURES,
  PLAN_IDS,
  PLAN_LIMITS,
  PLAN_PRICING,
  UNLIMITED,
  annualSavingPercent,
  featuresAddedByPlan,
  featuresForPlan,
  getPlanEntitlements,
  getPricingTiers,
  isPlanFeature,
  isUnlimited,
  monthlyPriceFor,
  planFeatureKeys,
  planHasFeature,
  requirePlan,
  type PlanFeature,
} from "../lib/plans";
import { GET, POST } from "../app/api/workspace/plan/route";

const URL_BASE = "https://myreply.test/api/workspace/plan";

/**
 * The features that must be free, named here rather than derived, so that
 * moving one to PRO in lib/plans breaks this test instead of shipping quietly.
 */
const MUST_BE_FREE: readonly PlanFeature[] = [
  "automations",
  "contacts",
  "dm_sends",
  "tags",
  "triggers",
  "quick_replies",
  "persistent_menu",
  "conversation_starters",
  "tracked_links",
  "inbox",
  "analytics",
  "rest_api",
  "mcp_server",
  "byok_ai",
];

const MUST_BE_PAID: readonly PlanFeature[] = [
  "managed_ai",
  "knowledge_base",
  "ai_dm_answering",
  "advanced_flows",
  "multi_account",
  "team_seats",
  "white_label_reports",
];

function asRole(
  role: "OWNER" | "ADMIN" | "MEMBER",
  plan: "FREE" | "PRO" = "FREE"
): void {
  mockContext.mockResolvedValue({
    userId: "user_1",
    workspaceId: "workspace_1",
    workspace: { id: "workspace_1", plan },
    role,
  });
}

function get(query = ""): Promise<Response> {
  return GET(new NextRequest(`${URL_BASE}${query}`));
}

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(URL_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  asRole("OWNER");
  mockPrisma.workspace.update.mockImplementation(
    async ({ data }: { data: { plan: string } }) => ({
      id: "workspace_1",
      plan: data.plan,
    })
  );
});

describe("free carries everything that costs us nothing", () => {
  it("gives FREE every zero marginal cost feature", () => {
    for (const feature of MUST_BE_FREE) {
      expect(planHasFeature("FREE", feature)).toBe(true);
    }
  });

  it("keeps BYOK AI on FREE, since the inference bill is the customer's", () => {
    expect(planHasFeature("FREE", "byok_ai")).toBe(true);
    expect(requirePlan("FREE", "byok_ai")).toEqual({ allowed: true });
  });

  it("marks every free feature as having no marginal cost, and no paid one", () => {
    for (const feature of PLAN_FEATURES) {
      const free = feature.minimumPlan === "FREE";
      expect(feature.reason === "no_marginal_cost").toBe(free);
    }
  });

  it("never gates a feature it also calls free", () => {
    const freeKeys = new Set(planFeatureKeys("FREE"));
    for (const feature of MUST_BE_FREE) {
      expect(freeKeys.has(feature)).toBe(true);
    }
    for (const feature of MUST_BE_PAID) {
      expect(freeKeys.has(feature)).toBe(false);
    }
  });

  it("caps nothing on FREE except seats", () => {
    const limits = PLAN_LIMITS.FREE;
    const capped = Object.entries(limits)
      .filter(([, value]) => !isUnlimited(value))
      .map(([key]) => key);

    // Instagram accounts are the one capped resource on Free: each connected
    // account multiplies webhook volume and worker load for as long as it is
    // connected, so it is not zero marginal cost.
    expect(capped).toEqual(["instagramAccounts", "teamSeats"]);
    expect(limits.contacts).toBe(UNLIMITED);
    expect(limits.dmsPerMonth).toBe(UNLIMITED);
    expect(limits.automations).toBe(UNLIMITED);
    expect(limits.apiRequests).toBe(UNLIMITED);
  });

  it("costs nothing", () => {
    expect(PLAN_PRICING.FREE.monthlyUsd).toBe(0);
    expect(monthlyPriceFor("FREE", "annual")).toBe(0);
    expect(annualSavingPercent("FREE")).toBe(0);
  });
});

describe("pro features are refused on free", () => {
  it("refuses each paid feature with a 402 and the plan that would unlock it", () => {
    for (const feature of MUST_BE_PAID) {
      const gate = requirePlan("FREE", feature);

      expect(gate.allowed).toBe(false);
      if (gate.allowed) throw new Error("unreachable");
      expect(gate.status).toBe(402);
      expect(gate.requiredPlan).toBe("PRO");
      expect(gate.feature).toBe(feature);
      expect(gate.error).toContain("Pro");
    }
  });

  it("allows every one of them on PRO", () => {
    for (const feature of MUST_BE_PAID) {
      expect(planHasFeature("PRO", feature)).toBe(true);
      expect(requirePlan("PRO", feature)).toEqual({ allowed: true });
    }
  });

  it("makes PRO a superset of FREE, so upgrading never takes anything away", () => {
    const free = planFeatureKeys("FREE");
    const pro = new Set(planFeatureKeys("PRO"));
    for (const feature of free) {
      expect(pro.has(feature)).toBe(true);
    }
    expect(featuresAddedByPlan("PRO").map((f) => f.key)).toEqual([
      ...MUST_BE_PAID,
    ]);
    expect(featuresAddedByPlan("FREE").map((f) => f.key)).toEqual([
      ...MUST_BE_FREE,
    ]);
  });

  it("rejects a feature name that is not in the table", () => {
    expect(isPlanFeature("byok_ai")).toBe(true);
    expect(isPlanFeature("free_money")).toBe(false);
  });

  it("lists the locked features on FREE and none on PRO", () => {
    expect(getPlanEntitlements("FREE").locked.map((f) => f.key)).toEqual([
      ...MUST_BE_PAID,
    ]);
    expect(getPlanEntitlements("PRO").locked).toEqual([]);
  });
});

describe("pricing", () => {
  it("prices Pro monthly and annually, and states the saving as a percentage", () => {
    expect(PLAN_PRICING.PRO.monthlyUsd).toBe(69);
    expect(PLAN_PRICING.PRO.annualMonthlyUsd).toBe(49);
    expect(PLAN_PRICING.PRO.annualTotalUsd).toBe(588);
    expect(monthlyPriceFor("PRO", "monthly")).toBe(69);
    expect(monthlyPriceFor("PRO", "annual")).toBe(49);
    expect(annualSavingPercent("PRO")).toBe(29);
  });

  it("keeps the annual total consistent with the annual monthly figure", () => {
    expect(PLAN_PRICING.PRO.annualMonthlyUsd * 12).toBe(
      PLAN_PRICING.PRO.annualTotalUsd
    );
  });
});

describe("the pricing table renders from the same table the gate enforces", () => {
  const source = readFileSync(
    path.join(__dirname, "..", "components", "pricing-table.tsx"),
    "utf8"
  );

  it("has one tier per plan, in plan order", () => {
    expect(getPricingTiers().map((tier) => tier.plan)).toEqual([...PLAN_IDS]);
  });

  it("only ever claims a feature the gate would allow on that plan", () => {
    for (const tier of getPricingTiers()) {
      for (const feature of tier.features) {
        expect(requirePlan(tier.plan, feature.key).allowed).toBe(true);
      }
      for (const feature of tier.addedFeatures) {
        expect(feature.minimumPlan).toBe(tier.plan);
      }
    }
  });

  it("shows a free tier whose bullets are exactly the free features", () => {
    const free = getPricingTiers().find((tier) => tier.plan === "FREE");
    expect(free?.features.map((feature) => feature.key)).toEqual([
      ...MUST_BE_FREE,
    ]);
    expect(free?.features).toEqual(featuresForPlan("FREE"));
  });

  it("carries the price, the saving and the limits the gate reads", () => {
    const pro = getPricingTiers().find((tier) => tier.plan === "PRO");
    expect(pro?.monthlyUsd).toBe(PLAN_PRICING.PRO.monthlyUsd);
    expect(pro?.annualMonthlyUsd).toBe(PLAN_PRICING.PRO.annualMonthlyUsd);
    expect(pro?.annualSavingPercent).toBe(annualSavingPercent("PRO"));
    expect(pro?.limits).toBe(PLAN_LIMITS.PRO);
  });

  it("imports its data from lib/plans rather than restating it", () => {
    expect(source).toContain('from "@/lib/plans"');
    expect(source).toContain("getPricingTiers");
    expect(source).toContain("PLAN_LIMITS");
  });

  it("hardcodes no price and no feature copy", () => {
    // A number or a bullet typed into the component is one that can disagree
    // with the gate. Prices come from PLAN_PRICING, bullets from PLAN_FEATURES.
    expect(source).not.toMatch(/\b(69|49|588)\b/);
    for (const feature of PLAN_FEATURES) {
      expect(source).not.toContain(feature.summary);
    }
  });
});

describe("GET /api/workspace/plan", () => {
  it("returns the workspace's plan and what it unlocks", async () => {
    const payload = await (await get()).json();

    expect(payload.success).toBe(true);
    expect(payload.data.plan).toBe("FREE");
    expect(payload.data.features).toEqual([...MUST_BE_FREE]);
    expect(payload.data.limits.contacts).toBe(UNLIMITED);
    expect(payload.data.locked.map((f: { key: string }) => f.key)).toEqual([
      ...MUST_BE_PAID,
    ]);
  });

  it("answers a gate question about a single feature", async () => {
    const free = await (await get("?feature=byok_ai")).json();
    expect(free.data.gate).toEqual({ allowed: true });

    const paid = await (await get("?feature=managed_ai")).json();
    expect(paid.data.gate.allowed).toBe(false);
    expect(paid.data.gate.status).toBe(402);
    expect(paid.data.gate.requiredPlan).toBe("PRO");
  });

  it("allows the paid feature once the workspace is on PRO", async () => {
    asRole("MEMBER", "PRO");
    const payload = await (await get("?feature=managed_ai")).json();
    expect(payload.data.gate).toEqual({ allowed: true });
  });

  it("rejects a feature name it does not know", async () => {
    expect((await get("?feature=free_money")).status).toBe(400);
  });

  it("tells a member they cannot change the plan, without hiding it", async () => {
    asRole("MEMBER");
    const payload = await (await get()).json();

    expect(payload.data.canManagePlan).toBe(false);
    expect(payload.data.plan).toBe("FREE");
  });

  it("rejects an unauthenticated caller", async () => {
    mockContext.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });
});

describe("POST /api/workspace/plan is owner only", () => {
  it("lets an owner change the plan", async () => {
    const response = await post({ plan: "PRO" });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockPrisma.workspace.update).toHaveBeenCalledWith({
      where: { id: "workspace_1" },
      data: { plan: "PRO" },
      select: { id: true, plan: true },
    });
    expect(payload.data.plan).toBe("PRO");
    expect(payload.data.features).toContain("managed_ai");
  });

  it("refuses an admin, who can manage the workspace but not the billing", async () => {
    asRole("ADMIN");

    const response = await post({ plan: "PRO" });

    expect(response.status).toBe(403);
    expect(mockPrisma.workspace.update).not.toHaveBeenCalled();
  });

  it("refuses a member", async () => {
    asRole("MEMBER");

    const response = await post({ plan: "PRO" });

    expect(response.status).toBe(403);
    expect(mockPrisma.workspace.update).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    mockContext.mockResolvedValue(null);

    expect((await post({ plan: "PRO" })).status).toBe(401);
    expect(mockPrisma.workspace.update).not.toHaveBeenCalled();
  });

  it("scopes the write to the caller's own workspace", async () => {
    await post({ plan: "PRO", workspaceId: "workspace_someone_else" });

    expect(mockPrisma.workspace.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "workspace_1" } })
    );
  });

  it("rejects a plan that does not exist", async () => {
    const response = await post({ plan: "ENTERPRISE" });

    expect(response.status).toBe(400);
    expect(mockPrisma.workspace.update).not.toHaveBeenCalled();
  });

  it("rejects a body with no plan at all", async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect(mockPrisma.workspace.update).not.toHaveBeenCalled();
  });

  it("allows a downgrade back to FREE", async () => {
    asRole("OWNER", "PRO");

    const payload = await (await post({ plan: "FREE" })).json();

    expect(payload.data.plan).toBe("FREE");
    expect(payload.data.features).not.toContain("managed_ai");
  });
});
