import Redis from "ioredis";

/**
 * Per-credential request limit for the machine surfaces: /api/v1 and /api/mcp.
 *
 * A fixed 60 second window in Redis, keyed by credential, so one integration
 * that loops cannot starve the others and a leaked key cannot be used to
 * hammer the database. Ported from upstream's read-only integration limiter.
 *
 * It fails CLOSED. If Redis cannot be reached the answer is "unavailable",
 * never "allowed": an outage must not quietly turn a limited endpoint into an
 * unlimited one.
 *
 * This client is separate from the queue's on purpose. BullMQ needs
 * maxRetriesPerRequest: null, which makes a command wait forever while Redis
 * is down. A rate check has to give up in seconds.
 */

export const REQUESTS_PER_WINDOW = 120;
export const WINDOW_SECONDS = 60;

export type RateLimitDecision =
  | { status: "allowed"; remaining: number }
  | { status: "limited"; retryAfterSeconds: number }
  | { status: "unavailable" };

const INCREMENT_SCRIPT =
  'local n=redis.call("INCR",KEYS[1]); if n==1 then redis.call("EXPIRE",KEYS[1],ARGV[1]) end; return {n, redis.call("TTL",KEYS[1])}';

let client: Redis | undefined;
let connecting: Promise<void> | undefined;

async function limiterClient(): Promise<Redis> {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");

  client ??= new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
    connectTimeout: 3000,
    retryStrategy: () => null,
  });
  // Without a listener ioredis logs every connection error, and those lines
  // carry the Redis host.
  if (!client.listenerCount("error")) client.on("error", () => undefined);

  if (client.status !== "ready") {
    connecting ??= client.connect().finally(() => {
      connecting = undefined;
    });
    await connecting;
  }
  return client;
}

/**
 * Count one request against a credential and say whether it may proceed.
 *
 * `credentialId` must already identify the credential, for example
 * `key:<apiKeyId>`. It never carries the secret itself.
 */
export async function consumeCredentialRequest(
  credentialId: string
): Promise<RateLimitDecision> {
  let count: number;
  let ttl: number;
  try {
    const redis = await limiterClient();
    const reply = (await redis.eval(
      INCREMENT_SCRIPT,
      1,
      `api-rate:${credentialId}`,
      String(WINDOW_SECONDS)
    )) as [number, number];
    count = Number(reply[0]);
    ttl = Number(reply[1]);
  } catch (error) {
    console.error(
      "[API rate limit] Redis unavailable, refusing the request:",
      error instanceof Error ? error.name : "unknown"
    );
    return { status: "unavailable" };
  }

  if (count > REQUESTS_PER_WINDOW) {
    return {
      status: "limited",
      retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
    };
  }
  return { status: "allowed", remaining: REQUESTS_PER_WINDOW - count };
}

/** The HTTP shape of a refusal, shared by both surfaces. */
export function rateLimitRefusal(
  decision: Exclude<RateLimitDecision, { status: "allowed" }>
): { status: number; message: string; headers: Record<string, string> } {
  if (decision.status === "limited") {
    return {
      status: 429,
      message: `Too many requests. This key allows ${REQUESTS_PER_WINDOW} a minute; try again in ${decision.retryAfterSeconds} seconds.`,
      headers: { "Retry-After": String(decision.retryAfterSeconds) },
    };
  }
  return {
    status: 503,
    message: "The API is briefly unavailable. Try again shortly.",
    headers: { "Retry-After": "5" },
  };
}
