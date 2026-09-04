/**
 * robots.txt, parsed to the level the exclusion standard actually specifies.
 *
 * The crawler identifies itself, so it has to obey. Groups are matched by user
 * agent with our own name winning over the wildcard, and within the winning
 * group the longest matching rule decides, with Allow beating Disallow on a
 * tie. That is the rule Google, Bing and RFC 9309 all agree on.
 *
 * A robots.txt that cannot be fetched is treated as permissive, which is the
 * standard's own default. A robots.txt that returns 401 or 403 is treated as
 * forbidding everything, because a site that gates its rules file is telling us
 * something.
 */

import { SsrfError, safeFetch, type SafeFetchOptions } from "./ssrf";

export const CRAWLER_USER_AGENT = "MyReplyKnowledgeBot";

const MAX_ROBOTS_BYTES = 512_000;

interface RobotsRule {
  /** The path pattern as written, supporting * and a trailing $. */
  pattern: string;
  allow: boolean;
}

export interface RobotsPolicy {
  /** Empty when the file allowed everything or could not be read. */
  rules: RobotsRule[];
  /** Seconds the site asked us to wait between requests, when it said so. */
  crawlDelaySeconds: number | null;
  /** True when the whole site is off limits. */
  disallowAll: boolean;
}

export const ALLOW_ALL: RobotsPolicy = {
  rules: [],
  crawlDelaySeconds: null,
  disallowAll: false,
};

export const DENY_ALL: RobotsPolicy = {
  rules: [{ pattern: "/", allow: false }],
  crawlDelaySeconds: null,
  disallowAll: true,
};

function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/**
 * Parse the file into the single group that applies to us. Groups whose user
 * agent lines do not name us or the wildcard are skipped entirely.
 */
export function parseRobotsTxt(
  body: string,
  userAgent: string = CRAWLER_USER_AGENT
): RobotsPolicy {
  const wanted = userAgent.toLowerCase();

  const specificRules: RobotsRule[] = [];
  const wildcardRules: RobotsRule[] = [];
  let specificDelay: number | null = null;
  let wildcardDelay: number | null = null;

  // A run of User-agent lines shares the directives that follow it, so the
  // group is only closed once a directive has been seen and a new agent starts.
  let currentAgents: string[] = [];
  let sawDirective = false;

  for (const rawLine of body.split(/\r\n?|\n/)) {
    const line = stripComment(rawLine);
    if (line === "") continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (sawDirective) {
        currentAgents = [];
        sawDirective = false;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }

    if (currentAgents.length === 0) continue;

    const matchesUs = currentAgents.some(
      (agent) => agent === "*" || wanted.startsWith(agent) || agent === wanted
    );
    if (!matchesUs) {
      sawDirective = true;
      continue;
    }

    const isSpecific = currentAgents.some((agent) => agent !== "*");

    if (field === "disallow" || field === "allow") {
      sawDirective = true;
      // "Disallow:" with an empty value means allow everything, which the
      // longest-match comparison below handles as a zero length pattern only if
      // we drop it. Dropping it is correct: an empty Disallow imposes nothing.
      if (field === "disallow" && value === "") continue;
      if (value === "") continue;

      const rule: RobotsRule = { pattern: value, allow: field === "allow" };
      if (isSpecific) specificRules.push(rule);
      else wildcardRules.push(rule);
      continue;
    }

    if (field === "crawl-delay") {
      sawDirective = true;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        if (isSpecific) specificDelay = seconds;
        else wildcardDelay = seconds;
      }
    }
  }

  const rules = specificRules.length > 0 ? specificRules : wildcardRules;
  const crawlDelaySeconds =
    specificRules.length > 0 ? specificDelay : wildcardDelay;

  const disallowAll = rules.some(
    (rule) => !rule.allow && (rule.pattern === "/" || rule.pattern === "/*")
  );

  return { rules, crawlDelaySeconds, disallowAll };
}

/** Length of the match, or -1 when the pattern does not apply to this path. */
function matchLength(pattern: string, path: string): number {
  const anchoredAtEnd = pattern.endsWith("$");
  const body = anchoredAtEnd ? pattern.slice(0, -1) : pattern;

  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  const expression = new RegExp(`^${escaped}${anchoredAtEnd ? "$" : ""}`);
  return expression.test(path) ? body.length : -1;
}

/** True when the policy permits fetching this path plus query string. */
export function isAllowedByRobots(policy: RobotsPolicy, path: string): boolean {
  let bestLength = -1;
  let bestAllow = true;

  for (const rule of policy.rules) {
    const length = matchLength(rule.pattern, path);
    if (length < 0) continue;

    if (length > bestLength) {
      bestLength = length;
      bestAllow = rule.allow;
    } else if (length === bestLength && rule.allow) {
      // Allow wins a tie, which is what keeps a narrow Allow carve-out inside a
      // broad Disallow working.
      bestAllow = true;
    }
  }

  return bestLength === -1 ? true : bestAllow;
}

/**
 * Fetch and parse the robots.txt for an origin. Never throws: a site with no
 * rules file, or one we cannot read, is treated as permissive, and only an
 * explicit 401 or 403 closes the door.
 */
export async function fetchRobotsPolicy(
  origin: string,
  options: SafeFetchOptions = {}
): Promise<RobotsPolicy> {
  let robotsUrl: string;
  try {
    robotsUrl = new URL("/robots.txt", origin).toString();
  } catch {
    return ALLOW_ALL;
  }

  try {
    const response = await safeFetch(robotsUrl, {
      ...options,
      accept: "text/plain,*/*;q=0.1",
      maxBytes: MAX_ROBOTS_BYTES,
    });

    if (response.status === 401 || response.status === 403) return DENY_ALL;
    if (response.status >= 400) return ALLOW_ALL;

    const body = new TextDecoder("utf-8", { fatal: false }).decode(
      response.bytes
    );
    return parseRobotsTxt(body);
  } catch (error) {
    // A blocked address here is worth surfacing, because it means the origin
    // itself is unreachable and the crawl is about to fail anyway.
    if (error instanceof SsrfError && error.reason === "BLOCKED_ADDRESS") {
      throw error;
    }
    return ALLOW_ALL;
  }
}
