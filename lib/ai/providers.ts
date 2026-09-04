/**
 * The AI providers a workspace can bring a key for.
 *
 * MyReply ships no key of its own. Every model call in the product is billed to
 * the workspace's own provider account, which is why the provider list is short
 * and explicit rather than a free-text base URL: a URL field would be an SSRF
 * hole, and there is no product reason to point the assistant at an arbitrary
 * host.
 */

export type AiProviderId = "ANTHROPIC" | "OPENROUTER";

export interface ProviderSpec {
  id: AiProviderId;
  /** Shown in the provider select. */
  label: string;
  /** Used when the workspace does not name a model. */
  defaultModel: string;
  /** Where the owner goes to mint a key, shown under the key field. */
  consoleUrl: string;
  /** Rendered as the input placeholder so a wrong-provider paste is obvious. */
  keyPlaceholder: string;
}

/**
 * Both defaults are the same Claude model. OpenRouter namespaces model ids by
 * author, hence the prefix; it is the same model behind the same words.
 */
export const AI_PROVIDERS: readonly ProviderSpec[] = [
  {
    id: "ANTHROPIC",
    label: "Anthropic",
    defaultModel: "claude-opus-5",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-...",
  },
  {
    id: "OPENROUTER",
    label: "OpenRouter",
    defaultModel: "anthropic/claude-opus-5",
    consoleUrl: "https://openrouter.ai/keys",
    keyPlaceholder: "sk-or-v1-...",
  },
] as const;

export const AI_PROVIDER_IDS: readonly AiProviderId[] = AI_PROVIDERS.map(
  (provider) => provider.id
);

export function getProviderSpec(id: AiProviderId): ProviderSpec {
  const spec = AI_PROVIDERS.find((provider) => provider.id === id);
  if (!spec) throw new Error(`Unknown AI provider: ${id}`);
  return spec;
}

export function isAiProviderId(value: unknown): value is AiProviderId {
  return (
    typeof value === "string" &&
    AI_PROVIDER_IDS.includes(value as AiProviderId)
  );
}

/** Longest model id we will store. Nothing real comes close. */
export const MAX_MODEL_LENGTH = 120;

/**
 * A key short enough to fail this is not a key, it is a typo or a paste of the
 * wrong field. The real floor is the provider's, which the validation call
 * enforces properly; this only keeps obvious junk out of the network path.
 */
export const MIN_KEY_LENGTH = 20;
export const MAX_KEY_LENGTH = 400;

/**
 * The only form of the key that ever leaves the server again: enough head to
 * name the provider and enough tail to tell two keys apart, and far too little
 * to use. Nothing else in this codebase may return any part of a stored key.
 */
export function maskProviderKey(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 8) return "...";
  return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`;
}

/**
 * Strip anything that looks like the caller's own key out of text we are about
 * to hand back. Providers do not echo keys in their errors, but this is the one
 * place provider text crosses into a response body, so it is guarded rather
 * than trusted.
 */
export function redactKey(text: string, plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length < 8) return text;
  return text.split(trimmed).join("[redacted]");
}
