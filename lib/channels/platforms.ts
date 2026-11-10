/**
 * Every messaging platform the engine can connect.
 *
 * Mirrors the ChannelPlatform enum in prisma/schema.prisma. This file is kept
 * free of server imports so client components can read it; the server-only
 * registry asserts the two lists match, so adding a platform to one and not
 * the other fails to compile.
 */
export const CHANNEL_PLATFORMS = ["INSTAGRAM", "FACEBOOK"] as const;

export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export function isChannelPlatform(value: unknown): value is ChannelPlatform {
  return (
    typeof value === "string" &&
    (CHANNEL_PLATFORMS as readonly string[]).includes(value)
  );
}

/** What each platform is called on screen. */
export const PLATFORM_LABELS: Record<ChannelPlatform, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
};
