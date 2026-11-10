import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (value: string) => `decrypted:${value}`,
}));

import { createInstagramContext, getUserMedia } from "@/lib/instagram/provider";

const fetchMock = vi.fn();

describe("Instagram provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("builds a context from the account's decrypted token", async () => {
    await expect(
      createInstagramContext({ accessToken: "ciphertext" })
    ).resolves.toEqual({ accessToken: "decrypted:ciphertext" });
  });

  it("sends reads straight to the Instagram Graph API", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "media" }] }), { status: 200 })
    );
    expect(
      await getUserMedia({ context: { accessToken: "meta" }, limit: 3 })
    ).toEqual([{ id: "media" }]);
    expect(fetchMock.mock.calls[0][0]).toContain("graph.instagram.com");
  });
});
