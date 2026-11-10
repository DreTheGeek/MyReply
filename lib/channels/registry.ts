import type { ChannelPlatform as StoredPlatform } from "@/app/generated/prisma/client";
import type { ChannelAccountRow, ChannelAdapter, ChannelContext } from "./adapter";
import { instagramAdapter } from "./instagram/adapter";
import type { ChannelPlatform } from "./platforms";

/**
 * Every adapter, by platform. Server only.
 *
 * Typed against both the client-safe platform list and the Prisma enum, so a
 * platform present in one and missing from the other is a compile error here
 * rather than a row the engine cannot route.
 */
const ADAPTERS: Record<ChannelPlatform, ChannelAdapter> &
  Record<StoredPlatform, ChannelAdapter> = {
  INSTAGRAM: instagramAdapter,
};

export function getChannelAdapter(platform: ChannelPlatform): ChannelAdapter {
  const adapter = ADAPTERS[platform];
  // The column is NOT NULL with a default, so this only fires on a row read
  // without selecting `platform`. Say so, instead of failing on undefined.
  if (!adapter) {
    throw new Error(`No channel adapter for platform "${String(platform)}"`);
  }
  return adapter;
}

export function allChannelAdapters(): ChannelAdapter[] {
  return Object.values(ADAPTERS);
}

/** The adapters that receive their events at one webhook endpoint. */
export function webhookAdapters(
  endpoint: ChannelAdapter["webhook"]["endpoint"]
): ChannelAdapter[] {
  return allChannelAdapters().filter((adapter) => adapter.webhook.endpoint === endpoint);
}

/**
 * The adapter that owns a webhook payload, among those that share an
 * endpoint. Meta signs Instagram and Facebook Page events with the same app
 * secret and lets one callback URL receive both, so the Meta endpoint asks
 * each Meta adapter in turn.
 */
export function adapterForWebhookPayload(
  payload: unknown,
  candidates: ChannelAdapter[] = allChannelAdapters()
): ChannelAdapter | null {
  return candidates.find((adapter) => adapter.webhook.accepts(payload)) ?? null;
}

export interface OpenChannel {
  adapter: ChannelAdapter;
  context: ChannelContext;
}

/**
 * The adapter and a ready context for one stored account. Throws when the
 * stored credential cannot be decrypted, which callers record as a decrypt
 * failure rather than a send failure.
 */
export async function openChannel(
  account: ChannelAccountRow & { platform: ChannelPlatform }
): Promise<OpenChannel> {
  const adapter = getChannelAdapter(account.platform);
  return { adapter, context: await adapter.openContext(account) };
}
