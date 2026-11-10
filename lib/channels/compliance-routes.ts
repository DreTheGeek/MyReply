import { NextResponse } from "next/server";
import { z } from "zod";
import { CHANNEL_PLATFORMS, type ChannelPlatform } from "./platforms";
import { getChannelAdapter } from "./registry";

/** A signed_request form is a few hundred bytes; anything far larger is not one. */
const MAX_CALLBACK_BYTES = 8 * 1024;

const segmentSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.enum(CHANNEL_PLATFORMS));

export type VerifiedCallback = { platform: ChannelPlatform; userId: string };

/**
 * Read and verify a platform's privacy callback. Returns the person it is
 * about, or the response to send back when it cannot be believed. The
 * refusals say nothing about why, so the endpoint is no help to anyone
 * probing it.
 */
export async function readComplianceCallback(
  request: Request,
  segment: string
): Promise<VerifiedCallback | NextResponse> {
  const parsedPlatform = segmentSchema.safeParse(segment);
  const adapter = parsedPlatform.success ? getChannelAdapter(parsedPlatform.data) : null;
  if (!parsedPlatform.success || !adapter?.compliance) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_CALLBACK_BYTES) {
    return NextResponse.json({ error: "Invalid request" }, { status: 413 });
  }
  const raw = await request.text().catch(() => "");
  if (raw.length === 0 || raw.length > MAX_CALLBACK_BYTES) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const verified = adapter.compliance.verifyCallback(new URLSearchParams(raw));
  if (!verified) {
    console.warn(`[Compliance] Refused an unverified ${parsedPlatform.data} callback`);
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  return { platform: parsedPlatform.data, userId: verified.userId };
}
