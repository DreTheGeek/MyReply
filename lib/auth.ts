import NextAuth, { type NextAuthConfig } from "next-auth";
import { headers } from "next/headers";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import {
  type ApiKeyContext,
  extractApiKey,
  resolveApiKey,
  touchApiKey,
} from "@/lib/api-keys";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
      from: process.env.EMAIL_FROM ?? "MyReply <login@example.com>",
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
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
 * Resolve an API key from the ambient request headers, if one was sent.
 *
 * Reading headers() rather than taking a Request means every existing route
 * gains machine auth without changing its signature. Returns null outside a
 * request scope (the worker, cron scripts), where cookie auth is also absent.
 */
async function getApiKeyContext(): Promise<ApiKeyContext | null> {
  try {
    const headerList = await headers();
    const plaintext = extractApiKey(headerList.get("authorization"));
    if (!plaintext) return null;

    const context = await resolveApiKey(plaintext);
    if (context) touchApiKey(context.apiKeyId);
    return context;
  } catch {
    return null;
  }
}

export async function getRequestApiKeyContext(): Promise<ApiKeyContext | null> {
  return getApiKeyContext();
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  // A valid API key names its own workspace, so it short-circuits before the
  // session lookup. Cookie auth stays the fallback for the dashboard.
  const apiKeyContext = await getApiKeyContext();
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
