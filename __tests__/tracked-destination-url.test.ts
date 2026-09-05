import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The same shape the automations route uses for a tracked destination.
 *
 * Kept as its own test rather than reaching into the route, because the point
 * being pinned is a property of the validator: z.string().url() alone accepts
 * schemes that must never reach a customer.
 */
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Only http and https links can be sent to a customer",
  });

describe("what zod's url() accepts on its own", () => {
  // This is the reason the refine exists. If a future zod tightens url() and
  // these start failing, the refine can go.
  it("accepts schemes that have no business in a Location header", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
    ]) {
      expect(z.string().url().safeParse(value).success).toBe(true);
    }
  });
});

describe("tracked destination validation", () => {
  it("refuses every non-http scheme", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "ftp://example.com/x",
    ]) {
      expect(httpUrl.safeParse(value).success).toBe(false);
    }
  });

  it("accepts the links a campaign actually sends", () => {
    for (const value of [
      "https://example.com/guide",
      "http://example.com",
      "https://example.com/a?b=c#d",
      "HTTPS://EXAMPLE.COM/SHOUTING",
    ]) {
      expect(httpUrl.safeParse(value).success).toBe(true);
    }
  });

  it("still refuses something that is not a URL at all", () => {
    expect(httpUrl.safeParse("not a url").success).toBe(false);
    expect(httpUrl.safeParse("").success).toBe(false);
  });

  // Empty string is how the route says "no tracked link", and it is handled by
  // the union around this validator rather than by the validator itself.
  it("pairs with an empty-string literal to mean no link", () => {
    const field = z.union([httpUrl, z.literal("")]);
    expect(field.safeParse("").success).toBe(true);
    expect(field.safeParse("https://example.com").success).toBe(true);
    expect(field.safeParse("javascript:alert(1)").success).toBe(false);
  });
});
