import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getWorkspaceMembership } from "@/lib/workspace";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    // The cookie the browser is holding did not resolve to a session. Say so
    // in the URL: middleware cannot tell a live cookie from a dead one without
    // a database read, so without this marker it bounces straight back here
    // and the two redirect at each other forever.
    redirect("/login?session=expired");
  }

  const workspace = await ensureWorkspaceForUser(
    session.user.id,
    session.user.email
  );

  // The membership is read after ensure so a first-time user, whose workspace
  // is created by that call, still resolves to a role rather than to null.
  const membership = await getWorkspaceMembership(session.user.id);

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { connectedAt: "desc" },
    select: { username: true },
  });

  return (
    <DashboardShell
      workspaceName={workspace.name}
      workspaceId={workspace.id}
      instagramUsername={accounts[0]?.username ?? null}
      instagramAccountCount={accounts.length}
      userName={session.user.name ?? null}
      userEmail={session.user.email ?? null}
      role={membership?.role ?? "MEMBER"}
    >
      {children}
    </DashboardShell>
  );
}
