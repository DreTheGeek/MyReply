import { NextResponse } from "next/server";
import type {
  ChannelAccountRow,
  ChannelContext,
  ChannelErrorRules,
  ChannelProfileSettings,
} from "./adapter";
import type { ChannelPlatform } from "./platforms";
import { getChannelAdapter, openChannel } from "./registry";

export interface OpenProfileSettings {
  settings: ChannelProfileSettings;
  context: ChannelContext;
  errors: ChannelErrorRules;
}

/**
 * An account's profile settings (ice breakers, persistent menu), or null when
 * its platform has none. Checked before the credential is decrypted, so an
 * unsupported platform costs nothing.
 */
export async function openProfileSettings(
  account: ChannelAccountRow & { platform: ChannelPlatform }
): Promise<OpenProfileSettings | null> {
  const adapter = getChannelAdapter(account.platform);
  if (!adapter.profileSettings) return null;
  const { context } = await openChannel(account);
  return { settings: adapter.profileSettings, context, errors: adapter.errors };
}

/** The answer for a platform that has no such settings. */
export function profileSettingsUnsupported(): NextResponse {
  return NextResponse.json(
    { success: false, error: "This account's platform does not offer this setting." },
    { status: 400 }
  );
}
