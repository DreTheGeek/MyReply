/**
 * Breadth first, same origin website crawler.
 *
 * The competitive point of this file: rivals accept one URL and read one page.
 * This walks a site up to three link levels deep, up to a hard ceiling of 100
 * pages, and turns every readable page into cited passages.
 *
 * Every fetch goes through lib/knowledge/ssrf, so a link discovered on page
 * seven gets the same address validation as the root the operator typed. Links
 * are not trusted just because a page we already fetched produced them.
 */

import {
  extractLinks,
  extractReadableText,
  extractTitle,
  readRobotsMeta,
} from "./html";
import {
  ALLOW_ALL,
  CRAWLER_USER_AGENT,
  fetchRobotsPolicy,
  isAllowedByRobots,
  type RobotsPolicy,
} from "./robots";
import {
  SsrfError,
  safeFetch,
  type FetchLike,
  type HostResolver,
  type SafeFetchResult,
} from "./ssrf";

/** Hard ceiling on pages, whatever depth was asked for. */
export const MAX_CRAWL_PAGES = 100;
/** Per page body ceiling. Anything larger is a download, not a page. */
export const MAX_PAGE_BYTES = 1_500_000;
export const MIN_CRAWL_DEPTH = 1;
export const MAX_CRAWL_DEPTH = 3;
/** Politeness floor between requests to the same origin, in milliseconds. */
const DEFAULT_DELAY_MS = 150;
/** However politely a site asks, we will not wait longer than this. */
const MAX_DELAY_MS = 2_000;

/** File extensions that are never a readable HTML page. */
const SKIPPED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif",
  ".mp4", ".webm", ".mov", ".avi", ".mkv", ".mp3", ".wav", ".ogg", ".m4a",
  ".zip", ".gz", ".tar", ".rar", ".7z", ".dmg", ".exe", ".msi", ".pkg",
  ".css", ".js", ".mjs", ".map", ".json", ".xml", ".rss", ".atom",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
]);

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

export interface CrawlSkip {
  url: string;
  reason: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  skipped: CrawlSkip[];
  /** True when the page cap stopped the crawl before the frontier emptied. */
  hitPageCap: boolean;
}

export interface CrawlOptions {
  /** 1 fetches only the root. 2 adds its links. 3 adds one level beyond that. */
  depth?: number;
  maxPages?: number;
  maxPageBytes?: number;
  timeoutMs?: number;
  resolve?: HostResolver;
  fetchImpl?: FetchLike;
  /** Skipping robots is for tests only. Production always honours it. */
  respectRobots?: boolean;
  /** Injected so tests do not spend real time being polite. */
  sleep?: (ms: number) => Promise<void>;
}

export class CrawlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlError";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The crawl key for a URL. Trailing slashes and the fragment are normalised
 * away so /about and /about/ are not fetched as two different pages.
 */
function canonicalize(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = "";
  if (copy.pathname.length > 1 && copy.pathname.endsWith("/")) {
    copy.pathname = copy.pathname.slice(0, -1);
  }
  return copy.toString();
}

function isSameOrigin(candidate: URL, root: URL): boolean {
  return (
    candidate.protocol === root.protocol &&
    candidate.hostname === root.hostname &&
    candidate.port === root.port
  );
}

function hasSkippedExtension(url: URL): boolean {
  const lastDot = url.pathname.lastIndexOf(".");
  if (lastDot === -1) return false;
  const extension = url.pathname.slice(lastDot).toLowerCase();
  return SKIPPED_EXTENSIONS.has(extension);
}

function looksLikeHtml(response: SafeFetchResult): boolean {
  const type = response.contentType.toLowerCase();
  if (type === "") return true;
  return (
    type.includes("text/html") ||
    type.includes("application/xhtml") ||
    type.includes("text/plain")
  );
}

function decodeBody(response: SafeFetchResult): string {
  const charsetMatch = /charset=([^;\s]+)/i.exec(response.contentType);
  const charset = charsetMatch ? charsetMatch[1].replace(/["']/g, "") : "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(response.bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(response.bytes);
  }
}

/**
 * Walk a site and return its readable pages.
 *
 * Throws CrawlError only when the crawl produced nothing usable, which is the
 * case the operator needs told about. A site that yields ten pages and skips
 * two broken ones is a success with a skip list, not a failure.
 */
export async function crawlSite(
  rootUrl: string,
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const depth = Math.min(
    MAX_CRAWL_DEPTH,
    Math.max(MIN_CRAWL_DEPTH, Math.trunc(options.depth ?? 1))
  );
  const maxPages = Math.min(MAX_CRAWL_PAGES, options.maxPages ?? MAX_CRAWL_PAGES);
  const maxPageBytes = options.maxPageBytes ?? MAX_PAGE_BYTES;
  const respectRobots = options.respectRobots ?? true;
  const sleep = options.sleep ?? defaultSleep;

  let root: URL;
  try {
    root = new URL(rootUrl);
  } catch {
    throw new CrawlError(`${rootUrl} is not a valid address`);
  }

  const fetchOptions = {
    timeoutMs: options.timeoutMs,
    maxBytes: maxPageBytes,
    resolve: options.resolve,
    fetchImpl: options.fetchImpl,
    userAgent: `${CRAWLER_USER_AGENT}/1.0 (+https://myreply.app/bot)`,
  };

  let policy: RobotsPolicy = ALLOW_ALL;
  if (respectRobots) {
    policy = await fetchRobotsPolicy(root.origin, fetchOptions);
    if (
      policy.disallowAll ||
      !isAllowedByRobots(policy, root.pathname + root.search)
    ) {
      throw new CrawlError(
        `${root.hostname} asks crawlers not to read this address in its robots.txt, so nothing was read`
      );
    }
  }

  const delayMs = Math.min(
    MAX_DELAY_MS,
    Math.max(
      DEFAULT_DELAY_MS,
      (policy.crawlDelaySeconds ?? 0) * 1000
    )
  );

  const pages: CrawledPage[] = [];
  const skipped: CrawlSkip[] = [];
  const seen = new Set<string>([canonicalize(root)]);
  // level is the link distance from the root, so the root itself is level 0.
  let frontier: Array<{ url: string; level: number }> = [
    { url: root.toString(), level: 0 },
  ];
  let hitPageCap = false;
  let fetched = 0;
  let rootFailure: string | null = null;

  while (frontier.length > 0 && pages.length < maxPages) {
    const next: Array<{ url: string; level: number }> = [];

    for (const item of frontier) {
      if (pages.length >= maxPages) {
        hitPageCap = true;
        break;
      }

      if (fetched > 0) await sleep(delayMs);
      fetched += 1;

      let response: SafeFetchResult;
      try {
        response = await safeFetch(item.url, fetchOptions);
      } catch (error) {
        const reason =
          error instanceof SsrfError || error instanceof Error
            ? error.message
            : "could not be fetched";
        if (item.level === 0) rootFailure = reason;
        skipped.push({ url: item.url, reason });
        continue;
      }

      if (response.status >= 400) {
        const reason = `returned HTTP ${response.status}`;
        if (item.level === 0) rootFailure = reason;
        skipped.push({ url: item.url, reason });
        continue;
      }

      if (!looksLikeHtml(response)) {
        skipped.push({ url: item.url, reason: "is not a readable page" });
        continue;
      }

      const html = decodeBody(response);
      const meta = readRobotsMeta(html);
      const text = extractReadableText(html);

      if (!meta.noindex && text.length > 0) {
        pages.push({
          url: response.finalUrl,
          title: extractTitle(html) ?? new URL(response.finalUrl).hostname,
          text,
        });
      } else if (meta.noindex) {
        skipped.push({ url: item.url, reason: "is marked noindex" });
      } else {
        skipped.push({ url: item.url, reason: "had no readable text" });
      }

      // A page at the last level still gets read, it just contributes no links.
      if (item.level + 1 >= depth || meta.nofollow) continue;

      for (const link of extractLinks(html, response.finalUrl)) {
        let candidate: URL;
        try {
          candidate = new URL(link);
        } catch {
          continue;
        }

        if (!isSameOrigin(candidate, root)) continue;
        if (hasSkippedExtension(candidate)) continue;
        if (
          respectRobots &&
          !isAllowedByRobots(policy, candidate.pathname + candidate.search)
        ) {
          continue;
        }

        const key = canonicalize(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ url: candidate.toString(), level: item.level + 1 });
      }
    }

    if (pages.length >= maxPages && next.length > 0) hitPageCap = true;
    frontier = next;
  }

  if (pages.length === 0) {
    throw new CrawlError(
      rootFailure
        ? `${root.hostname} ${rootFailure}`
        : `No readable text was found at ${root.toString()}`
    );
  }

  return { pages, skipped, hitPageCap };
}
