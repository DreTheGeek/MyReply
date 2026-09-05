import type { Metadata } from "next";
import DashboardShell from "@/components/dashboard-shell";
import PublicTemplateIndex from "@/components/templates/public-template-index";
import TemplateGallery from "@/components/templates/template-gallery";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getTemplate } from "@/lib/templates/catalogue";
import { buildGallerySections } from "@/lib/templates/gallery";
import { ensureWorkspaceForUser, getWorkspaceMembership } from "@/lib/workspace";

export const metadata: Metadata = {
  title: "Instagram Comment to DM Templates - MyReply",
  description:
    "Copy ready-to-launch Instagram comment-to-DM campaign templates for product links, lead magnets, real estate, fitness, restaurants, events, and creators.",
  keywords: [
    "Instagram comment to DM templates",
    "comment to DM campaigns",
    "Instagram DM automation templates",
    "Manychat alternative templates",
  ],
};

type TemplatesPageProps = {
  searchParams: Promise<{ install?: string }>;
};

/**
 * One URL, two audiences.
 *
 * /templates is a public SEO surface and it stays one, so it cannot live under
 * the (dashboard) group: two pages resolving to the same path is a build
 * error, and moving the marketing library off /templates would break the links
 * that point at it from the public header and every comparison page.
 *
 * So the branch happens here. Signed out, this is the library it has always
 * been. Signed in, it is the in-app gallery inside the portal shell, which is
 * what turns the SEO surface into a funnel that finishes on a real campaign
 * rather than at a signup form.
 */
export default async function TemplatesPage({
  searchParams,
}: TemplatesPageProps): Promise<React.JSX.Element> {
  const { install } = await searchParams;
  // Resolved through the catalogue so an arbitrary query string can never
  // reach the gallery as a slug.
  const pendingSlug = getTemplate(install)?.slug ?? null;

  const session = await auth();

  if (!session?.user?.id) {
    return <PublicTemplateIndex pendingSlug={pendingSlug} />;
  }

  // The same four reads the (dashboard) layout does. Repeated rather than
  // shared because this page sits outside that group by necessity, above.
  const workspace = await ensureWorkspaceForUser(
    session.user.id,
    session.user.email
  );
  const membership = await getWorkspaceMembership(session.user.id);
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true },
  });

  const role = membership?.role ?? "MEMBER";

  return (
    <DashboardShell
      workspaceName={workspace.name}
      workspaceId={workspace.id}
      instagramUsername={accounts[0]?.username ?? null}
      instagramAccountCount={accounts.length}
      userName={session.user.name ?? null}
      userEmail={session.user.email ?? null}
      role={role}
    >
      <TemplateGallery
        sections={buildGallerySections()}
        accounts={accounts}
        canManage={role === "OWNER" || role === "ADMIN"}
        pendingSlug={pendingSlug}
      />
    </DashboardShell>
  );
}
