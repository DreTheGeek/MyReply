import type { ChannelCapabilities } from "./capabilities";
import type {
  ChannelComment,
  ChannelConversation,
  ChannelMedia,
  ChannelMediaInsights,
  ChannelMessage,
  ChannelProfile,
  FollowerDelta,
  IceBreaker,
  MenuItem,
  OutboundContent,
  SendReceipt,
  SendTarget,
} from "./content";
import type { ChannelEvent } from "./events";
import type { SendErrorRules } from "./errors";
import type { ChannelPlatform } from "./platforms";

/**
 * One messaging platform, behind one interface.
 *
 * The worker, the webhook, the inbox, the crons and the API talk only to this.
 * None of them import a platform's client directly; a test enforces it. A new
 * platform is a new adapter plus an entry in the registry, never a rebuild.
 *
 * Optional sections are optional because a platform may not offer them. The
 * capability flags say what exists; a caller checks the flag (or the section)
 * before calling, and an adapter that is asked for something it cannot do
 * throws rather than pretending.
 */

/**
 * What a call needs to act as one connected account. Built per job from the
 * stored row, held in memory only, never persisted or logged.
 */
export interface ChannelContext {
  platform: ChannelPlatform;
  /** The platform's id for the connected account. */
  accountExternalId: string;
  /** The decrypted credential. */
  accessToken: string;
}

/** The stored account fields a context is built from. */
export interface ChannelAccountRow {
  /** The platform's id for the account. Named for history; see the schema. */
  instagramId: string;
  /** Ciphertext, as stored. */
  accessToken: string;
}

/** What a successful connect produces, before it is stored. */
export interface ConnectedAccountGrant {
  externalId: string;
  username: string;
  name: string | null;
  /** Plaintext. The caller encrypts it before it touches the database. */
  accessToken: string;
  expiresAt: Date | null;
}

export interface ChannelAuth {
  /** Where to send the person to approve the connection. */
  authorizationUrl(input: { redirectUri: string; state: string }): string;
  /** Trade the code from the redirect for a stored-ready grant. */
  completeConnection(input: {
    code: string;
    redirectUri: string;
  }): Promise<ConnectedAccountGrant>;
  /** Extend a token close to expiry. */
  refreshToken(
    context: ChannelContext
  ): Promise<{ accessToken: string; expiresAt: Date | null }>;
  /** Ask the platform to deliver this account's events to our webhook. */
  subscribeToEvents(context: ChannelContext): Promise<boolean>;
}

export interface ChannelWebhook {
  /**
   * Which webhook endpoint the platform delivers to. Adapters that share one
   * (every Meta platform posts to the same callback URL, signed with the same
   * app secret) share a name; the route serves the adapters registered under
   * it.
   */
  endpoint: "meta";
  /** True when this adapter owns the payload, so one endpoint can serve several. */
  accepts(payload: unknown): boolean;
  /** Answer the platform's subscription handshake, or null to refuse it. */
  verifyChallenge(params: URLSearchParams): string | null;
  /** Check the payload was signed by the platform. Constant time. */
  verifySignature(rawBody: string, headers: Headers): boolean;
  /** Turn a verified payload into events, in the order they must be handled. */
  parse(payload: unknown): ChannelEvent[];
  /**
   * The payload with everything about accounts outside `accountExternalIds`
   * removed, for storing. A platform may batch several accounts' events into
   * one delivery, and the stored copy is filed under one workspace, so it must
   * never carry another tenant's events.
   */
  scopePayload(payload: unknown, accountExternalIds: Set<string>): unknown;
}

export interface ChannelMessaging {
  send(
    context: ChannelContext,
    input: { to: SendTarget; content: OutboundContent }
  ): Promise<SendReceipt>;
  /** Reply under a comment, publicly. Requires capabilities.publicReply. */
  publicReply(
    context: ChannelContext,
    input: { commentId: string; text: string; postId?: string }
  ): Promise<{ id: string }>;
  /** Null when the platform will not say. Requires capabilities.followGate. */
  followStatus(context: ChannelContext, userId: string): Promise<boolean | null>;
  /** The handle behind a platform user id, or null. */
  username(context: ChannelContext, userId: string): Promise<string | null>;
}

export interface ChannelContent {
  profile(context: ChannelContext): Promise<ChannelProfile>;
  /** Newest first. */
  recentMedia(context: ChannelContext, input: { limit: number }): Promise<ChannelMedia[]>;
  /** Newest first, paging until `max`. */
  allMedia(context: ChannelContext, input: { max: number }): Promise<ChannelMedia[]>;
  recentComments(
    context: ChannelContext,
    input: { mediaId: string; sinceMs: number; max?: number }
  ): Promise<ChannelComment[]>;
  mediaInsights(
    context: ChannelContext,
    input: { mediaId: string; metrics: string[] }
  ): Promise<ChannelMediaInsights>;
  /** Null when the platform keeps no follower history for this account. */
  followerHistory(context: ChannelContext): Promise<FollowerDelta[] | null>;
}

export interface ChannelInbox {
  conversations(context: ChannelContext): Promise<ChannelConversation[]>;
  messages(context: ChannelContext, conversationId: string): Promise<ChannelMessage[]>;
}

export interface ChannelProfileSettings {
  /** Null when the current value cannot be read. */
  iceBreakers(context: ChannelContext): Promise<IceBreaker[] | null>;
  setIceBreakers(context: ChannelContext, items: IceBreaker[]): Promise<void>;
  clearIceBreakers(context: ChannelContext): Promise<void>;
  /** Null when the current value cannot be read. */
  persistentMenu(context: ChannelContext): Promise<MenuItem[] | null>;
  setPersistentMenu(context: ChannelContext, items: MenuItem[]): Promise<void>;
  clearPersistentMenu(context: ChannelContext): Promise<void>;
}

export interface ChannelErrorRules extends SendErrorRules {
  /**
   * The platform refused the rich form of a message (a button template) in a
   * way a plain-text retry could fix. Anything else must not be retried as
   * text, because the retry is a second send.
   */
  isRichContentRejection(error: unknown): boolean;
  /** An error message an older worker logged for an uncertain outcome. */
  isLegacyUnconfirmed(errorMessage: string | null | undefined): boolean;
  /**
   * The platform's own explanation of a refusal, safe to show the person who
   * tried (for example that the messaging window has closed), or null when
   * the error is anything else. Never an internal error or a stack.
   */
  userMessage(error: unknown): string | null;
  /** The account never granted the permission a read needs. Reconnecting fixes it. */
  isPermissionDenied(error: unknown): boolean;
}

export interface ChannelAdapter {
  platform: ChannelPlatform;
  capabilities: ChannelCapabilities;

  hasCredentials(account: Pick<ChannelAccountRow, "accessToken">): boolean;
  /** Throws when the stored credential cannot be decrypted. */
  openContext(account: ChannelAccountRow): Promise<ChannelContext>;

  auth: ChannelAuth;
  webhook: ChannelWebhook;
  messaging: ChannelMessaging;
  content: ChannelContent;
  inbox?: ChannelInbox;
  profileSettings?: ChannelProfileSettings;
  errors: ChannelErrorRules;
}
