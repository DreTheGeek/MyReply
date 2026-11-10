import { z } from "zod";
import type { ChannelPlatform } from "./platforms";

/**
 * Platforms connected through /api/channels/<platform>/connect. Instagram
 * keeps its own /api/instagram routes, whose redirect URL is already
 * registered with Meta.
 */
export const GENERIC_CONNECT_PLATFORMS = ["FACEBOOK"] as const satisfies readonly ChannelPlatform[];

export type GenericConnectPlatform = (typeof GENERIC_CONNECT_PLATFORMS)[number];

const segmentSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.enum(GENERIC_CONNECT_PLATFORMS));

/** The platform named by a route segment ("facebook"), or null. */
export function parsePlatformSegment(segment: string): GenericConnectPlatform | null {
  const parsed = segmentSchema.safeParse(segment);
  return parsed.success ? parsed.data : null;
}

/** The environment a platform's connect flow needs, and which of it is missing. */
const REQUIRED_ENV: Record<GenericConnectPlatform, string[]> = {
  FACEBOOK: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", "NEXTAUTH_SECRET", "ENCRYPTION_KEY"],
};

export function missingConnectEnv(platform: GenericConnectPlatform): string[] {
  return REQUIRED_ENV[platform].filter((name) => !process.env[name]);
}

/** The query key the settings page reads a connect outcome from. */
export function noticeKey(platform: GenericConnectPlatform): string {
  return platform.toLowerCase();
}
