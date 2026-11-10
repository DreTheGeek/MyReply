import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * Idempotency-Key on v1 writes.
 *
 * A program that sends a write and loses the connection cannot tell whether
 * it happened. With a key it can simply send it again: the first answer is
 * stored against the key and replayed, so a retried "create campaign" or
 * "send message" happens once. The same key on a different request is
 * refused, and a key whose first request is still running is told to wait.
 *
 * A 5xx is not stored. The request did not finish, so a retry should run it.
 */

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Printable ASCII, the way Stripe and the IETF draft describe keys. */
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

/** A first request older than this with no answer is taken to have died. */
const IN_FLIGHT_STALE_MS = 2 * 60 * 1000;

function json(status: number, error: string): Response {
  return Response.json(
    { success: false, error },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function hashRequest(method: string, path: string, body: string): string {
  return createHash("sha256").update(`${method}\n${path}\n${body}`).digest("hex");
}

export interface IdempotencyOptions {
  /** Refuse a write that carries no key, for writes where a duplicate does harm. */
  required?: boolean;
}

/**
 * Run a write once per key. Requests without a key run as they always did,
 * unless the endpoint requires one.
 */
export async function withIdempotency(
  request: NextRequest,
  credentialId: string,
  run: (request: NextRequest) => Promise<Response>,
  options: IdempotencyOptions = {}
): Promise<Response> {
  if (!WRITE_METHODS.has(request.method)) return run(request);

  const key = request.headers.get(IDEMPOTENCY_HEADER);
  if (key === null) {
    return options.required
      ? json(400, "This endpoint needs an Idempotency-Key header, so a retry never sends twice.")
      : run(request);
  }
  if (!KEY_PATTERN.test(key)) {
    return json(400, "Idempotency-Key must be 1 to 255 printable characters.");
  }

  // The body is read once here and handed on in a fresh request, because a
  // request body can only be read once.
  const body = await request.text();
  const path = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const requestHash = hashRequest(request.method, path, body);

  let recordId: string;
  try {
    const created = await prisma.idempotencyRecord.create({
      data: { credentialId, key, method: request.method, path, requestHash },
      select: { id: true },
    });
    recordId = created.id;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      throw error;
    }
    const existing = await prisma.idempotencyRecord.findUnique({
      where: { credentialId_key: { credentialId, key } },
    });
    if (!existing) return json(409, "That Idempotency-Key is busy. Try again in a moment.");
    if (existing.requestHash !== requestHash) {
      return json(422, "That Idempotency-Key was already used for a different request.");
    }
    if (existing.status === null || existing.body === null) {
      const age = Date.now() - existing.createdAt.getTime();
      if (age < IN_FLIGHT_STALE_MS) {
        return json(409, "A request with this Idempotency-Key is still running. Try again shortly.");
      }
      // The first attempt died without answering. Take the key over and run.
      const taken = await prisma.idempotencyRecord.updateMany({
        where: { id: existing.id, status: null, createdAt: existing.createdAt },
        data: { createdAt: new Date() },
      });
      if (taken.count === 0) {
        return json(409, "A request with this Idempotency-Key is still running. Try again shortly.");
      }
      recordId = existing.id;
    } else {
      return new Response(existing.body, {
        status: existing.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Idempotent-Replayed": "true",
        },
      });
    }
  }

  const replayable = new NextRequest(request.url, {
    method: request.method,
    headers: request.headers,
    ...(body ? { body } : {}),
  });

  let response: Response;
  try {
    response = await run(replayable);
  } catch (error) {
    await releaseKey(recordId);
    throw error;
  }

  if (response.status >= 500) {
    await releaseKey(recordId);
    return response;
  }

  const text = await response.clone().text();
  await prisma.idempotencyRecord.update({
    where: { id: recordId },
    data: { status: response.status, body: text, completedAt: new Date() },
  });
  return response;
}

/** Let a retry run again after a failure that never answered. */
async function releaseKey(recordId: string): Promise<void> {
  try {
    await prisma.idempotencyRecord.delete({ where: { id: recordId } });
  } catch (error) {
    console.error(
      "[idempotency] Could not release a key after a failed request:",
      error instanceof Error ? error.name : "unknown"
    );
  }
}
