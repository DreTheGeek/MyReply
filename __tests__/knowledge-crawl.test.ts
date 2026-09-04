import { describe, expect, it, vi } from "vitest";

import {
  MAX_CRAWL_PAGES,
  CrawlError,
  crawlSite,
} from "../lib/knowledge/crawl";
import {
  decodeHtmlEntities,
  extractLinks,
  extractReadableText,
  extractTitle,
  readRobotsMeta,
} from "../lib/knowledge/html";
import {
  isAllowedByRobots,
  parseRobotsTxt,
} from "../lib/knowledge/robots";
import type { FetchLike } from "../lib/knowledge/ssrf";

const PUBLIC_ADDRESS = "93.184.216.34";

const resolveAllPublic = async (): Promise<string[]> => [PUBLIC_ADDRESS];
const noSleep = async (): Promise<void> => undefined;

/** Serves a fixed map of paths, and 404s anything else. */
function siteFetcher(
  pages: Record<string, string>,
  robots?: string
): { fetchImpl: FetchLike; requested: string[] } {
  const requested: string[] = [];

  const fetchImpl = (async (input: string) => {
    requested.push(input);
    const url = new URL(input);

    if (url.pathname === "/robots.txt") {
      return robots === undefined
        ? new Response("not found", { status: 404 })
        : new Response(robots, {
            status: 200,
            headers: { "content-type": "text/plain" },
          });
    }

    const body = pages[url.pathname];
    if (body === undefined) {
      return new Response("missing", { status: 404 });
    }

    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as unknown as FetchLike;

  return { fetchImpl, requested };
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

/** Enough prose that a page survives the "no readable text" check. */
function prose(word: string): string {
  return `<p>${`${word} `.repeat(40).trim()}.</p>`;
}

describe("html extraction", () => {
  it("drops script, style and navigation chrome", () => {
    const text = extractReadableText(
      page(
        "Shop",
        `<nav><a href="/a">Home</a><a href="/b">About</a></nav>
         <script>window.tracker = 1;</script>
         <style>body { color: red }</style>
         <main><p>We are open until six on weekdays.</p></main>
         <footer>Copyright 2026</footer>`
      )
    );

    expect(text).toContain("We are open until six on weekdays.");
    expect(text).not.toContain("window.tracker");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("Copyright 2026");
    expect(text).not.toContain("About");
  });

  it("turns block elements into paragraph breaks", () => {
    const text = extractReadableText("<p>First thing.</p><p>Second thing.</p>");
    expect(text).toBe("First thing.\n\nSecond thing.");
  });

  it("decodes named and numeric entities", () => {
    expect(decodeHtmlEntities("Ben &amp; Jerry&#39;s &#x2014; open")).toBe(
      "Ben & Jerry's \u2014 open"
    );
    expect(decodeHtmlEntities("&notarealentity;")).toBe("&notarealentity;");
  });

  it("reads a title, falling back to the first heading", () => {
    expect(extractTitle("<title>  Our  Prices </title>")).toBe("Our Prices");
    expect(extractTitle("<body><h1>Our <em>Prices</em></h1></body>")).toBe(
      "Our Prices"
    );
    expect(extractTitle("<body><p>nothing</p></body>")).toBeNull();
  });

  it("resolves links against the page and honours a base tag", () => {
    expect(
      extractLinks(
        `<a href="/about">a</a><a href="contact">b</a><a href="#top">c</a>
         <a href="mailto:x@y.z">d</a><a href="https://other.test/e">e</a>`,
        "https://shop.test/store/index.html"
      )
    ).toEqual([
      "https://shop.test/about",
      "https://shop.test/store/contact",
      "https://other.test/e",
    ]);

    expect(
      extractLinks(
        `<base href="https://shop.test/docs/"><a href="guide">g</a>`,
        "https://shop.test/"
      )
    ).toEqual(["https://shop.test/docs/guide"]);
  });

  it("reads the robots meta tag", () => {
    expect(readRobotsMeta('<meta name="robots" content="noindex, follow">')).toEqual(
      { noindex: true, nofollow: false }
    );
    expect(readRobotsMeta('<meta name="robots" content="none">')).toEqual({
      noindex: true,
      nofollow: true,
    });
    expect(readRobotsMeta("<p>nothing</p>")).toEqual({
      noindex: false,
      nofollow: false,
    });
  });
});

describe("robots.txt", () => {
  it("applies the wildcard group when no agent matches us", () => {
    const policy = parseRobotsTxt(
      `User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n`
    );
    expect(isAllowedByRobots(policy, "/admin/users")).toBe(false);
    expect(isAllowedByRobots(policy, "/pricing")).toBe(true);
  });

  it("prefers a group naming us over the wildcard", () => {
    const policy = parseRobotsTxt(
      `User-agent: *\nDisallow: /\n\nUser-agent: MyReplyKnowledgeBot\nDisallow: /private\n`
    );
    expect(isAllowedByRobots(policy, "/pricing")).toBe(true);
    expect(isAllowedByRobots(policy, "/private/x")).toBe(false);
  });

  it("lets a longer Allow carve out of a broad Disallow", () => {
    const policy = parseRobotsTxt(
      `User-agent: *\nDisallow: /docs\nAllow: /docs/public\n`
    );
    expect(isAllowedByRobots(policy, "/docs/secret")).toBe(false);
    expect(isAllowedByRobots(policy, "/docs/public/a")).toBe(true);
  });

  it("treats an empty Disallow as imposing nothing", () => {
    const policy = parseRobotsTxt(`User-agent: *\nDisallow:\n`);
    expect(policy.disallowAll).toBe(false);
    expect(isAllowedByRobots(policy, "/anything")).toBe(true);
  });

  it("supports wildcards and end anchors", () => {
    const policy = parseRobotsTxt(
      `User-agent: *\nDisallow: /*.json$\nDisallow: /a/*/b\n`
    );
    expect(isAllowedByRobots(policy, "/data/feed.json")).toBe(false);
    expect(isAllowedByRobots(policy, "/data/feed.json.html")).toBe(true);
    expect(isAllowedByRobots(policy, "/a/x/b")).toBe(false);
  });

  it("ignores comments", () => {
    const policy = parseRobotsTxt(
      `# a note\nUser-agent: * # everyone\nDisallow: /admin # keep out\n`
    );
    expect(isAllowedByRobots(policy, "/admin")).toBe(false);
  });
});

describe("crawlSite depth", () => {
  const pages: Record<string, string> = {
    "/": page("Home", `${prose("home")}<a href="/a">A</a><a href="/b">B</a>`),
    "/a": page("A", `${prose("alpha")}<a href="/a1">A1</a>`),
    "/b": page("B", `${prose("bravo")}<a href="/b1">B1</a>`),
    "/a1": page("A1", `${prose("deepest")}<a href="/a2">A2</a>`),
    "/b1": page("B1", prose("deeper")),
    "/a2": page("A2", prose("deepest2")),
  };

  it("depth 1 reads only the root", async () => {
    const { fetchImpl } = siteFetcher(pages);
    const result = await crawlSite("https://shop.test/", {
      depth: 1,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(result.pages.map((p) => p.title)).toEqual(["Home"]);
  });

  it("depth 2 reads the root and its links", async () => {
    const { fetchImpl } = siteFetcher(pages);
    const result = await crawlSite("https://shop.test/", {
      depth: 2,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(result.pages.map((p) => p.title).sort()).toEqual(["A", "B", "Home"]);
  });

  it("depth 3 reads one level further and stops there", async () => {
    const { fetchImpl } = siteFetcher(pages);
    const result = await crawlSite("https://shop.test/", {
      depth: 3,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    const titles = result.pages.map((p) => p.title).sort();
    expect(titles).toEqual(["A", "A1", "B", "B1", "Home"]);
    // A2 sits at level 3, past the depth we asked for.
    expect(titles).not.toContain("A2");
  });

  it("clamps a depth above the ceiling rather than crawling forever", async () => {
    const { fetchImpl } = siteFetcher(pages);
    const result = await crawlSite("https://shop.test/", {
      depth: 99,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(result.pages.map((p) => p.title)).not.toContain("A2");
  });
});

describe("crawlSite limits and scoping", () => {
  it("stops at the page cap", async () => {
    // A root linking to 40 pages, each of which links onward.
    const pages: Record<string, string> = {};
    const links = Array.from(
      { length: 40 },
      (_unused, index) => `<a href="/p${index}">p${index}</a>`
    ).join("");
    pages["/"] = page("Home", prose("home") + links);
    for (let index = 0; index < 40; index += 1) {
      const onward = Array.from(
        { length: 40 },
        (_unused, child) => `<a href="/p${index}-${child}">c</a>`
      ).join("");
      pages[`/p${index}`] = page(`P${index}`, prose("page") + onward);
      for (let child = 0; child < 40; child += 1) {
        pages[`/p${index}-${child}`] = page(`P${index}C${child}`, prose("leaf"));
      }
    }

    const { fetchImpl } = siteFetcher(pages);
    const result = await crawlSite("https://shop.test/", {
      depth: 3,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(result.pages.length).toBeLessThanOrEqual(MAX_CRAWL_PAGES);
    expect(result.hitPageCap).toBe(true);
  });

  it("honours a lower explicit page cap", async () => {
    const pages: Record<string, string> = {
      "/": page(
        "Home",
        prose("home") +
          Array.from(
            { length: 10 },
            (_unused, index) => `<a href="/p${index}">p</a>`
          ).join("")
      ),
    };
    for (let index = 0; index < 10; index += 1) {
      pages[`/p${index}`] = page(`P${index}`, prose("page"));
    }

    const { fetchImpl } = siteFetcher(pages);
    const result = await crawlSite("https://shop.test/", {
      depth: 2,
      maxPages: 4,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(result.pages).toHaveLength(4);
  });

  it("never leaves the origin", async () => {
    const { fetchImpl, requested } = siteFetcher({
      "/": page(
        "Home",
        `${prose("home")}<a href="https://evil.test/steal">out</a><a href="/ok">in</a>`
      ),
      "/ok": page("Ok", prose("inside")),
    });

    const result = await crawlSite("https://shop.test/", {
      depth: 3,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(result.pages.map((p) => p.title).sort()).toEqual(["Home", "Ok"]);
    expect(requested.some((url) => url.includes("evil.test"))).toBe(false);
  });

  it("does not fetch the same page twice through a different link shape", async () => {
    const { fetchImpl, requested } = siteFetcher({
      "/": page(
        "Home",
        `${prose("home")}<a href="/a">1</a><a href="/a/">2</a><a href="/a#top">3</a>`
      ),
      "/a": page("A", prose("alpha")),
    });

    await crawlSite("https://shop.test/", {
      depth: 2,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(requested.filter((url) => url.includes("/a")).length).toBe(1);
  });

  it("refuses to crawl a site whose robots.txt shuts everyone out", async () => {
    const { fetchImpl } = siteFetcher(
      { "/": page("Home", prose("home")) },
      "User-agent: *\nDisallow: /\n"
    );

    await expect(
      crawlSite("https://shop.test/", {
        fetchImpl,
        resolve: resolveAllPublic,
        sleep: noSleep,
      })
    ).rejects.toThrowError(CrawlError);
  });

  it("skips a path robots.txt disallows while reading the rest", async () => {
    const { fetchImpl, requested } = siteFetcher(
      {
        "/": page(
          "Home",
          `${prose("home")}<a href="/admin/panel">x</a><a href="/pricing">p</a>`
        ),
        "/pricing": page("Pricing", prose("pricing")),
        "/admin/panel": page("Admin", prose("secret")),
      },
      "User-agent: *\nDisallow: /admin\n"
    );

    const result = await crawlSite("https://shop.test/", {
      depth: 2,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(result.pages.map((p) => p.title).sort()).toEqual([
      "Home",
      "Pricing",
    ]);
    expect(requested.some((url) => url.includes("/admin"))).toBe(false);
  });

  it("skips a page marked noindex but keeps following its links", async () => {
    const { fetchImpl } = siteFetcher({
      "/": page(
        "Home",
        `<meta name="robots" content="noindex">${prose("home")}<a href="/real">r</a>`
      ),
      "/real": page("Real", prose("real")),
    });

    const result = await crawlSite("https://shop.test/", {
      depth: 2,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(result.pages.map((p) => p.title)).toEqual(["Real"]);
    expect(result.skipped[0].reason).toContain("noindex");
  });

  it("fails with a readable message when the root cannot be read", async () => {
    const { fetchImpl } = siteFetcher({});

    await expect(
      crawlSite("https://shop.test/", {
        fetchImpl,
        resolve: resolveAllPublic,
        sleep: noSleep,
      })
    ).rejects.toThrowError(/HTTP 404/);
  });

  it("fails rather than crawling a root that resolves privately", async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike;

    await expect(
      crawlSite("https://internal.test/", {
        fetchImpl,
        resolve: async (): Promise<string[]> => ["10.0.0.5"],
        sleep: noSleep,
      })
    ).rejects.toThrowError(/private or reserved/);
  });

  it("skips links that are plainly not pages", async () => {
    const { fetchImpl, requested } = siteFetcher({
      "/": page(
        "Home",
        `${prose("home")}<a href="/logo.png">img</a><a href="/app.js">js</a><a href="/report.pdf">pdf</a><a href="/ok">ok</a>`
      ),
      "/ok": page("Ok", prose("ok")),
    });

    await crawlSite("https://shop.test/", {
      depth: 2,
      fetchImpl,
      resolve: resolveAllPublic,
      sleep: noSleep,
    });

    expect(requested.some((url) => url.endsWith(".png"))).toBe(false);
    expect(requested.some((url) => url.endsWith(".js"))).toBe(false);
    expect(requested.some((url) => url.endsWith(".pdf"))).toBe(false);
  });
});
