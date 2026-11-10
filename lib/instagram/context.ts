import { decryptToken } from "@/lib/meta/oauth";

/**
 * What a send or a read needs to act as one connected Instagram account: the
 * decrypted Graph API token. Built per job from the stored ciphertext and never
 * persisted or logged.
 */
export type InstagramContext = { accessToken: string };

/** The stored account fields a context is built from. */
export type ProviderAccount = { accessToken: string };

export function hasInstagramCredentials(
  account: Pick<ProviderAccount, "accessToken">
): boolean {
  return Boolean(account.accessToken);
}

/**
 * Decrypt the account's token into a context. Throws when the ciphertext does
 * not decrypt, which callers record as a decrypt failure.
 */
export async function createInstagramContext(
  account: Pick<ProviderAccount, "accessToken">
): Promise<InstagramContext> {
  return { accessToken: decryptToken(account.accessToken) };
}
