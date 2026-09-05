import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  type AuthorizeParams,
  validateAuthorizationRequest,
} from "@/lib/oauth/authorize-request";
import { redirectHost } from "@/lib/oauth/clients";
import { AUTHORIZE_PATH, DECISION_PATH, resolveIssuerFromHeaders } from "@/lib/oauth/config";
import { signConsentRequest } from "@/lib/oauth/consent-request";
import { SCOPE_COPY, serializeScope } from "@/lib/oauth/scopes";
import { getWorkspaceMembership, listUserWorkspaces } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connect an app - MyReply",
  description: "Approve or deny an app asking for access to your MyReply workspace.",
};

/**
 * The OAuth authorization endpoint, and the only page a person sees in the
 * whole flow.
 *
 * It lives outside the (dashboard) route group on purpose. That group's layout
 * redirects a signed-out visitor to /login with no callbackUrl, which would
 * throw away the pending authorization request and leave the client waiting
 * forever. This page sends the visitor to /login carrying its own URL, so they
 * come back to the request they were in the middle of. Wrapping a security
 * decision in the workspace navigation shell would also be the wrong frame: the
 * question here is about one app, not about running campaigns.
 */

function ErrorCard({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): React.ReactElement {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <div className="panel rounded p-8">
          <h1 className="text-lg font-semibold text-foreground">{title}</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">{detail}</p>
          {/* This is a full screen page with no header, so without a link the
              person is stuck with the back button and a half finished
              authorization. */}
          <a
            href="/dashboard"
            className="mt-6 inline-block rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:text-foreground"
          >
            Back to MyReply
          </a>
        </div>
      </div>
    </main>
  );
}

function toQueryString(params: AuthorizeParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") search.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) search.set(key, value[0]);
  }
  return search.toString();
}

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<AuthorizeParams>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const headerList = await headers();
  const issuer = resolveIssuerFromHeaders(headerList);

  const outcome = await validateAuthorizationRequest(params, issuer);

  if (outcome.kind === "redirect") {
    redirect(outcome.url);
  }

  if (outcome.kind === "error_page") {
    return <ErrorCard title={outcome.title} detail={outcome.detail} />;
  }

  const session = await auth();
  if (!session?.user?.id) {
    const returnTo = `${AUTHORIZE_PATH}?${toQueryString(params)}`;
    redirect(
      `/login?callbackUrl=${encodeURIComponent(returnTo)}&session=expired`
    );
  }

  const userId = session.user.id;
  const workspaces = await listUserWorkspaces(userId);

  if (workspaces.length === 0) {
    return (
      <ErrorCard
        title="You have no workspace yet"
        detail="Open the MyReply dashboard once to finish setting up your workspace, then start this connection again."
      />
    );
  }

  const current = await getWorkspaceMembership(userId);
  const defaultWorkspaceId = current?.workspace.id ?? workspaces[0].id;

  const { client, redirectUri, scopes, resource, state, codeChallenge } =
    outcome.request;

  const consent = signConsentRequest({
    clientRecordId: client.id,
    clientId: client.clientId,
    redirectUri,
    scope: serializeScope(scopes),
    resource,
    state,
    codeChallenge,
    codeChallengeMethod: "S256",
    userId,
  });

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            MyReply
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-foreground">
            {client.clientName} wants access to your workspace
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Signed in as {session.user.email ?? "your account"}. Nothing is shared
            until you approve.
          </p>
        </div>

        <form action={DECISION_PATH} method="post" className="panel rounded p-8">
          <input type="hidden" name="consent" value={consent} />

          <section>
            <h2 className="text-sm font-semibold text-foreground">Who is asking</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-muted">App</dt>
                <dd className="font-medium text-foreground">{client.clientName}</dd>
              </div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <dt className="text-muted">Sends you back to</dt>
                <dd className="font-medium text-foreground">
                  {redirectHost(redirectUri)}
                </dd>
              </div>
            </dl>
            <p className="mt-3 break-all font-mono text-xs text-muted">{redirectUri}</p>
            <p className="mt-3 text-xs leading-relaxed text-muted">
              MyReply does not vet apps. Only continue if you started this from{" "}
              {client.clientName} yourself.
            </p>
          </section>

          <section className="mt-7 border-t border-border pt-6">
            <h2 className="text-sm font-semibold text-foreground">Which workspace</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Access is limited to the one you pick here. The app can never reach
              your other workspaces.
            </p>
            <div className="mt-3 space-y-2">
              {workspaces.map((workspace) => (
                <label
                  key={workspace.id}
                  className="flex cursor-pointer items-center gap-3 rounded border border-border bg-background px-4 py-3 text-sm transition-colors hover:border-border-hover"
                >
                  <input
                    type="radio"
                    name="workspaceId"
                    value={workspace.id}
                    defaultChecked={workspace.id === defaultWorkspaceId}
                    className="accent-accent"
                    required
                  />
                  <span className="font-medium text-foreground">{workspace.name}</span>
                  <span className="ml-auto text-xs uppercase tracking-wide text-muted">
                    {workspace.role}
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="mt-7 border-t border-border pt-6">
            <h2 className="text-sm font-semibold text-foreground">
              What it will be able to do
            </h2>
            <ul className="mt-3 space-y-3">
              {scopes.map((scope) => {
                const copy = SCOPE_COPY[scope];
                return (
                  <li key={scope}>
                    <p className="text-sm font-medium text-foreground">
                      {copy?.title ?? scope}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">
                      {copy?.detail ?? "No description is available for this scope."}
                    </p>
                  </li>
                );
              })}
            </ul>
            <p className="mt-4 text-xs leading-relaxed text-muted">
              Your own role still applies. If you are a member rather than an admin
              of the workspace you pick, this stays read only whatever the app
              asked for. It never sees your password, your email login, or your
              billing.
            </p>
          </section>

          <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="submit"
              name="decision"
              value="deny"
              className="w-full rounded border border-border bg-surface px-6 py-3 text-sm font-semibold text-foreground transition-colors hover:border-border-hover sm:w-auto sm:flex-1"
            >
              Deny
            </button>
            <button
              type="submit"
              name="decision"
              value="approve"
              className="w-full rounded bg-accent px-6 py-3 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover sm:w-auto sm:flex-1"
            >
              Approve access
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
