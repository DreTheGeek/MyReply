import NextAuth, { type NextAuthConfig } from "next-auth";
import { headers } from "next/headers";
import Nodemailer from "next-auth/providers/nodemailer";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { CURRENT_TERMS_VERSION } from "@/lib/legal/terms-version";
import {
  type ApiKeyContext,
  extractApiKey,
  resolveApiKey,
  touchApiKey,
} from "@/lib/api-keys";
import { currentCaller } from "@/lib/api/caller-context";
import {
  WORKSPACE_HEADER,
  extractPartnerKey,
  partnerWorkspaceContext,
  resolvePartnerKey,
  touchPartnerKey,
  type PartnerCaller,
} from "@/lib/partners/keys";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";
import { isEmailAllowedToSignIn } from "@/lib/env";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

const emailFrom = process.env.EMAIL_FROM ?? "MyReply <login@example.com>";
// Setting EMAIL_SERVER switches magic links to your own SMTP server, for
// self-hosters who do not want a third-party mail service. Resend stays the
// default, so an existing deployment is unaffected.
const smtpServer = process.env.EMAIL_SERVER;

/**
 * Provider id the login form has to sign in with. It differs per transport,
 * so it is derived here rather than hardcoded at the call site.
 */
export const EMAIL_PROVIDER_ID = smtpServer ? "nodemailer" : "resend";

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    smtpServer
      ? Nodemailer({ server: smtpServer, from: emailFrom })
      : Resend({
          apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
          from: emailFrom,
        }),
  ],
  callbacks: {
    // Runs before the magic link is sent, so a blocked address never receives
    // one, and again when the link is verified.
    async signIn({ user }) {
      return isEmailAllowedToSignIn(user?.email);
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (!user.id) return;

      // Recorded here because this fires exactly once, when the account is
      // created, and the only way to reach it is by submitting the login form,
      // which carries the notice and the two links. That is the moment of
      // acceptance, so that is the moment worth stamping.
      await prisma.user.update({
        where: { id: user.id },
        data: {
          termsAcceptedAt: new Date(),
          termsVersion: CURRENT_TERMS_VERSION,
        },
      });

      await ensureWorkspaceForUser(user.id, user.email);
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

/**
 * Resolve the key in the ambient request headers, if one was sent. Only the
 * doors call this (lib/api/v1.ts); everything behind a door reads the caller
 * the door let in, through getRequestApiKeyContext.
 *
 * Returns null outside a request scope (the worker, cron scripts), where
 * cookie auth is also absent.
 */
export async function resolveRequestApiKey(): Promise<ApiKeyContext | null> {
  try {
    const headerList = await headers();
    const authorization = headerList.get("authorization");

    // A partner key acts inside a workspace only when it names one of its own.
    const partnerKey = extractPartnerKey(authorization);
    if (partnerKey) {
      const partner = await resolvePartnerKey(partnerKey);
      if (!partner) return null;
      const workspaceId = headerList.get(WORKSPACE_HEADER)?.trim() ?? "";
      const context = workspaceId ? await partnerWorkspaceContext(partner, workspaceId) : null;
      if (context) touchPartnerKey(partner.keyId);
      return context;
    }

    const plaintext = extractApiKey(authorization);
    if (!plaintext) return null;

    const context = await resolveApiKey(plaintext);
    if (context) touchApiKey(context.apiKeyId);
    return context;
  } catch (error) {
    // headers() throws outside a request; a lookup failure is logged so a
    // database outage does not read as "wrong key" with nothing said.
    if (!(error instanceof Error && /outside a request scope/i.test(error.message))) {
      console.error(
        "[auth] API key lookup failed:",
        error instanceof Error ? error.name : "unknown"
      );
    }
    return null;
  }
}

/**
 * A partner key in the ambient request, for the partner's own endpoints
 * (making and listing its workspaces). Only the partner door calls this.
 */
export async function resolveRequestPartner(): Promise<PartnerCaller | null> {
  try {
    const headerList = await headers();
    const partnerKey = extractPartnerKey(headerList.get("authorization"));
    if (!partnerKey) return null;
    const partner = await resolvePartnerKey(partnerKey);
    if (partner) touchPartnerKey(partner.keyId);
    return partner;
  } catch (error) {
    console.error(
      "[auth] Partner key lookup failed:",
      error instanceof Error ? error.name : "unknown"
    );
    return null;
  }
}

/** True when the request carries a partner key, whether or not it resolved. */
export async function requestCarriesPartnerKey(): Promise<boolean> {
  try {
    const headerList = await headers();
    return extractPartnerKey(headerList.get("authorization")) !== null;
  } catch {
    // Outside a request there is no header to carry anything.
    return false;
  }
}

/**
 * The machine caller this request was let in as, or null.
 *
 * A key only counts once a door has checked it, its scope and its rate limit
 * (lib/api/caller-context.ts). A key sent straight to a dashboard route is no
 * credential at all, so a key cut to read-only cannot write by skipping v1.
 */
export async function getRequestApiKeyContext(): Promise<ApiKeyContext | null> {
  return currentCaller();
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  // A valid API key names its own workspace, so it short-circuits before the
  // session lookup. Cookie auth stays the fallback for the dashboard.
  const apiKeyContext = await getRequestApiKeyContext();
  if (apiKeyContext) return apiKeyContext.workspaceId;

  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
