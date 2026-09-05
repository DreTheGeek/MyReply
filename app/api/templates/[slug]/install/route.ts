import { NextRequest, NextResponse } from "next/server";
import { POST as createAutomation } from "@/app/api/automations/route";
import { prisma } from "@/lib/db/client";
import { getTemplate } from "@/lib/templates/catalogue";
import {
  buildInstallPayload,
  templateInstallInputSchema,
} from "@/lib/templates/install";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteProps = { params: Promise<{ slug: string }> };

interface CreatedAutomation {
  id: string;
  isActive: boolean;
}

/**
 * POST /api/templates/[slug]/install
 *
 * Turns a catalogue entry into a real campaign.
 *
 * The campaign itself is created by POST /api/automations, called directly
 * rather than reimplemented. That route owns the Zod schema, the trigger
 * refinements, the tracked-link creation and the report slug, so an install
 * cannot drift from what the builder produces: if a template ever presets an
 * invalid combination, this returns that route's own 400 instead of writing a
 * campaign nothing else in the product would have accepted.
 *
 * Auth reaches that route through the ambient request headers rather than
 * through the Request object, so the delegated call is authenticated exactly
 * as this one is. Both the role gate and the account ownership check are still
 * applied here first, so a refusal names the real reason.
 */
export async function POST(
  request: NextRequest,
  { params }: RouteProps
): Promise<NextResponse> {
  const { slug } = await params;
  const template = getTemplate(slug);

  if (!template) {
    return NextResponse.json(
      { success: false, error: "Template not found" },
      { status: 404 }
    );
  }

  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can install templates" },
      { status: 403 }
    );
  }

  // An empty body is the common case: one tap, no choices. It has to parse as
  // an empty object rather than throwing on absent JSON.
  const rawBody: unknown = await request.json().catch(() => ({}));
  const parsed = templateInstallInputSchema.safeParse(rawBody ?? {});

  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid input",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const workspaceId = context.workspaceId;
  const requestedAccountId = parsed.data.instagramAccountId?.trim() || null;

  // The id and the workspace are matched in one query, so an account belonging
  // to another workspace is a 404 rather than a 403. A 403 would confirm the
  // id exists somewhere, which is a tenant enumeration oracle.
  const instagramAccount = requestedAccountId
    ? await prisma.instagramAccount.findFirst({
        where: { id: requestedAccountId, workspaceId },
        select: { id: true },
      })
    : await prisma.instagramAccount.findFirst({
        where: { workspaceId },
        orderBy: { connectedAt: "desc" },
        select: { id: true },
      });

  if (!instagramAccount) {
    return requestedAccountId
      ? NextResponse.json(
          { success: false, error: "Instagram account not found" },
          { status: 404 }
        )
      : NextResponse.json(
          {
            success: false,
            error: "Connect Instagram before installing a template",
          },
          { status: 400 }
        );
  }

  const payload = buildInstallPayload(template, {
    ...parsed.data,
    instagramAccountId: instagramAccount.id,
  });

  const createResponse = await createAutomation(
    new NextRequest(new URL("/api/automations", request.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  );

  const created: unknown = await createResponse.json();

  if (!createResponse.ok) {
    return NextResponse.json(created, { status: createResponse.status });
  }

  const automation = (created as { data?: CreatedAutomation }).data;

  if (!automation?.id) {
    return NextResponse.json(
      { success: false, error: "Could not install the template" },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      success: true,
      data: {
        automation,
        templateSlug: template.slug,
        // Switched off means the DM has no link yet, which is the one thing
        // left to do. Either way the person lands on the campaign they made.
        needsLink: template.needsLink && !automation.isActive,
        redirectTo: `/campaigns/${automation.id}`,
      },
    },
    { status: 201 }
  );
}
