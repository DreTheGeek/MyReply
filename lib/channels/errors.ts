/**
 * Whether a failed send might still have been delivered.
 *
 * The rule that keeps the engine from messaging someone twice, platform
 * neutral. Only an explicit rejection proves nothing went out; a timeout, a
 * dropped connection, an unreadable response or an ambiguous platform code
 * does not. An unconfirmed send is never retried automatically: a person
 * checks the inbox first.
 *
 * What counts as an explicit rejection is the platform's call, so each
 * adapter supplies `isConfirmedRejection`.
 */

export class DeliveryUnconfirmedError extends Error {
  constructor(error: unknown) {
    const detail =
      error instanceof Error ? error.message : "Unknown send outcome";
    super(
      `Message delivery is unconfirmed; automatic retries stopped. Inspect the Instagram inbox before retrying. ${detail}`
    );
    this.name = "DeliveryUnconfirmedError";
  }
}

export function isDeliveryUnconfirmed(
  error: unknown
): error is DeliveryUnconfirmedError {
  return error instanceof DeliveryUnconfirmedError;
}

/** The part of an adapter these rules need. */
export interface SendErrorRules {
  isConfirmedRejection(error: unknown): boolean;
}

/**
 * Pass a confirmed rejection (or an already-classified error) through
 * unchanged, and turn anything else into DeliveryUnconfirmedError.
 */
export function classifySendError(rules: SendErrorRules, error: unknown): unknown {
  return isDeliveryUnconfirmed(error) || rules.isConfirmedRejection(error)
    ? error
    : new DeliveryUnconfirmedError(error);
}
