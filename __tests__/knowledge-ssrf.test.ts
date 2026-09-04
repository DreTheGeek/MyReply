import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_REDIRECTS,
  SsrfError,
  assertSafeUrl,
  assertSafeUrlShape,
  isBlockedAddress,
  safeFetch,
  type FetchLike,
} from "../lib/knowledge/ssrf";

/** A resolver that answers with whatever the test wants for a given host. */
function resolverFor(map: Record<string, string[]>): (
  hostname: string
) => Promise<string[]> {
  return async (hostname: string): Promise<string[]> => {
    const answer = map[hostname];
    if (!answer) throw new Error(`no record for ${hostname}`);
    return answer;
  };
}

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...headers },
  });
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe("isBlockedAddress", () => {
  const blocked: Array<[string, string]> = [
    ["10.0.0.1", "10/8 private"],
    ["10.255.255.254", "10/8 private, top of range"],
    ["172.16.0.1", "172.16/12 private, bottom of range"],
    ["172.31.255.254", "172.16/12 private, top of range"],
    ["192.168.1.1", "192.168/16 private"],
    ["127.0.0.1", "127/8 loopback"],
    ["127.1.2.3", "127/8 loopback, not just .0.0.1"],
    ["169.254.169.254", "169.254/16 link local, cloud metadata"],
    ["169.254.0.1", "169.254/16 link local"],
    ["0.0.0.0", "this network"],
    ["100.64.0.1", "carrier grade NAT"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fc00::1", "fc00::/7 unique local"],
    ["fd12:3456:789a::1", "fc00::/7 unique local, fd half"],
    ["fe80::1", "link local IPv6"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata address"],
    ["::ffff:10.0.0.1", "IPv4-mapped private address"],
    ["64:ff9b::127.0.0.1", "NAT64 wrapping loopback"],
    ["2002:7f00:0001::", "6to4 wrapping loopback"],
    ["not-an-address", "unparseable, must fail closed"],
  ];

  for (const [address, why] of blocked) {
    it(`blocks ${address} (${why})`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.32.0.1",
    "172.15.255.255",
    "11.0.0.1",
    "128.0.0.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ];

  for (const address of allowed) {
    it(`allows the public address ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }
});

describe("assertSafeUrlShape", () => {
  it.each([
    ["file:///etc/passwd", "file"],
    ["ftp://example.com/x", "ftp"],
    ["gopher://example.com/", "gopher"],
    ["data:text/html,<b>x</b>", "data"],
    ["javascript:alert(1)", "javascript"],
  ])("rejects the %s scheme", (raw) => {
    expect(() => assertSafeUrlShape(raw)).toThrowError(SsrfError);
    try {
      assertSafeUrlShape(raw);
    } catch (error) {
      expect((error as SsrfError).reason).toBe("BAD_SCHEME");
    }
  });

  it("rejects credentials smuggled into the address", () => {
    try {
      assertSafeUrlShape("http://admin:hunter2@example.com/");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as SsrfError).reason).toBe("EMBEDDED_CREDENTIALS");
    }
  });

  it("rejects a private IP literal without touching DNS", () => {
    try {
      assertSafeUrlShape("http://169.254.169.254/latest/meta-data/");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as SsrfError).reason).toBe("BLOCKED_ADDRESS");
    }
  });

  it("rejects a bracketed IPv6 loopback literal", () => {
    expect(() => assertSafeUrlShape("http://[::1]:8080/")).toThrowError(
      SsrfError
    );
  });

  it("accepts an ordinary https address", () => {
    expect(assertSafeUrlShape("https://example.com/docs").hostname).toBe(
      "example.com"
    );
  });
});

describe("assertSafeUrl", () => {
  it("rejects a public hostname that resolves into private space", async () => {
    const resolve = resolverFor({ "internal.example.com": ["10.1.2.3"] });
    await expect(
      assertSafeUrl("https://internal.example.com/", resolve)
    ).rejects.toThrowError(/private or reserved/);
  });

  it("rejects when any one of several answers is private", async () => {
    // A record set that mixes a public and a private address is the classic
    // way past a checker that only looks at the first answer.
    const resolve = resolverFor({ "mixed.example.com": ["93.184.216.34", "127.0.0.1"] });
    await expect(
      assertSafeUrl("https://mixed.example.com/", resolve)
    ).rejects.toThrowError(SsrfError);
  });

  it("rejects a host with no records at all", async () => {
    const resolve = resolverFor({ "empty.example.com": [] });
    await expect(
      assertSafeUrl("https://empty.example.com/", resolve)
    ).rejects.toThrowError(/Could not look up/);
  });

  it("accepts a host resolving only to public addresses", async () => {
    const resolve = resolverFor({ "example.com": ["93.184.216.34"] });
    await expect(
      assertSafeUrl("https://example.com/a", resolve)
    ).resolves.toBeInstanceOf(URL);
  });

  it("catches a decimal-encoded loopback through the resolver", async () => {
    // 2130706433 is 127.0.0.1. It is not a dotted quad, so it goes through DNS,
    // where getaddrinfo expands it. The address check is what stops it.
    const resolve = resolverFor({ "2130706433": ["127.0.0.1"] });
    await expect(
      assertSafeUrl("http://2130706433/", resolve)
    ).rejects.toThrowError(/private or reserved/);
  });
});

describe("safeFetch redirects", () => {
  it("re-checks the address after a redirect and refuses metadata", async () => {
    const resolve = resolverFor({ "public.example.com": ["93.184.216.34"] });
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.startsWith("https://public.example.com")) {
        return redirectTo("http://169.254.169.254/latest/meta-data/");
      }
      return html("<p>secrets</p>");
    }) as unknown as FetchLike;

    await expect(
      safeFetch("https://public.example.com/", { resolve, fetchImpl })
    ).rejects.toThrowError(/private or reserved/);

    // Crucially, the second hop was never dialled.
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect into a hostname that resolves privately", async () => {
    const resolve = resolverFor({
      "public.example.com": ["93.184.216.34"],
      "metadata.internal": ["169.254.169.254"],
    });
    const fetchImpl = vi.fn(async (input: string) => {
      if (input.startsWith("https://public.example.com")) {
        return redirectTo("https://metadata.internal/token");
      }
      return html("<p>secrets</p>");
    }) as unknown as FetchLike;

    await expect(
      safeFetch("https://public.example.com/", { resolve, fetchImpl })
    ).rejects.toThrowError(SsrfError);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect that changes scheme to file", async () => {
    const resolve = resolverFor({ "public.example.com": ["93.184.216.34"] });
    const fetchImpl = vi.fn(async () =>
      redirectTo("file:///etc/passwd")
    ) as unknown as FetchLike;

    await expect(
      safeFetch("https://public.example.com/", { resolve, fetchImpl })
    ).rejects.toThrowError(/http and https/);
  });

  it("follows a redirect to another public address", async () => {
    const resolve = resolverFor({
      "a.example.com": ["93.184.216.34"],
      "b.example.com": ["93.184.216.35"],
    });
    const fetchImpl = vi.fn(async (input: string) =>
      input.includes("a.example.com")
        ? redirectTo("https://b.example.com/final")
        : html("<p>ok</p>")
    ) as unknown as FetchLike;

    const result = await safeFetch("https://a.example.com/", {
      resolve,
      fetchImpl,
    });
    expect(result.finalUrl).toBe("https://b.example.com/final");
    expect(new TextDecoder().decode(result.bytes)).toContain("ok");
  });

  it("gives up once the redirect cap is passed", async () => {
    const resolve = resolverFor({ "loop.example.com": ["93.184.216.34"] });
    let hop = 0;
    const fetchImpl = vi.fn(async () => {
      hop += 1;
      return redirectTo(`https://loop.example.com/${hop}`);
    }) as unknown as FetchLike;

    await expect(
      safeFetch("https://loop.example.com/", { resolve, fetchImpl })
    ).rejects.toThrowError(/redirects/);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(
      DEFAULT_MAX_REDIRECTS + 1
    );
  });

  it("honours a lower redirect cap", async () => {
    const resolve = resolverFor({ "loop.example.com": ["93.184.216.34"] });
    const fetchImpl = vi.fn(async () =>
      redirectTo("https://loop.example.com/next")
    ) as unknown as FetchLike;

    await expect(
      safeFetch("https://loop.example.com/", {
        resolve,
        fetchImpl,
        maxRedirects: 1,
      })
    ).rejects.toThrowError(/redirects/);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it("rejects a redirect with no destination", async () => {
    const resolve = resolverFor({ "x.example.com": ["93.184.216.34"] });
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302 })
    ) as unknown as FetchLike;

    await expect(
      safeFetch("https://x.example.com/", { resolve, fetchImpl })
    ).rejects.toThrowError(/no destination/);
  });
});

describe("safeFetch limits", () => {
  it("refuses a body that declares a size over the cap", async () => {
    const resolve = resolverFor({ "big.example.com": ["93.184.216.34"] });
    const fetchImpl = vi.fn(async () =>
      html("x", { "content-length": "999999999" })
    ) as unknown as FetchLike;

    await expect(
      safeFetch("https://big.example.com/", {
        resolve,
        fetchImpl,
        maxBytes: 1000,
      })
    ).rejects.toThrowError(/over the 1000 byte limit/);
  });

  it("truncates a body that streams past the cap rather than buffering it", async () => {
    const resolve = resolverFor({ "stream.example.com": ["93.184.216.34"] });
    let chunksProduced = 0;

    const fetchImpl = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksProduced += 1;
          if (chunksProduced > 1000) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(100).fill(97));
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }) as unknown as FetchLike;

    const result = await safeFetch("https://stream.example.com/", {
      resolve,
      fetchImpl,
      maxBytes: 250,
    });

    expect(result.truncated).toBe(true);
    expect(result.bytes.byteLength).toBe(250);
    // Stopped reading rather than draining the whole stream.
    expect(chunksProduced).toBeLessThan(10);
  });

  it("reports a timeout as a readable message", async () => {
    const resolve = resolverFor({ "slow.example.com": ["93.184.216.34"] });
    const fetchImpl = vi.fn(
      (_input: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    ) as unknown as FetchLike;

    await expect(
      safeFetch("https://slow.example.com/", {
        resolve,
        fetchImpl,
        timeoutMs: 20,
      })
    ).rejects.toThrowError(/did not respond/);
  });

  it("passes an abort signal into every request it makes", async () => {
    const resolve = resolverFor({ "sig.example.com": ["93.184.216.34"] });
    let sawSignal = false;
    const fetchImpl = vi.fn(
      async (_input: string, init: { signal: AbortSignal }) => {
        sawSignal = init.signal instanceof AbortSignal;
        return html("<p>ok</p>");
      }
    ) as unknown as FetchLike;

    await safeFetch("https://sig.example.com/", { resolve, fetchImpl });
    expect(sawSignal).toBe(true);
  });
});
