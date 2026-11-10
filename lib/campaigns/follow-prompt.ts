/**
 * What the follow gate says when a campaign has not written its own prompt.
 *
 * It goes to a stranger in the business's name, so it is neutral and short.
 * The old default asked people to star a GitHub repository, which made sense
 * for one creator promoting their own open source project and for nobody
 * else: every studio, shop and agency on this platform inherited it.
 *
 * This is also a translation key, so the builder can show it in the
 * operator's interface language. What is actually sent is this English text
 * unless the campaign sets its own.
 */
export const DEFAULT_FOLLOW_PROMPT =
  "Follow this account, then tap the button below and I'll send your link.";

