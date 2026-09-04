/**
 * Turning a fetched HTML page into readable text and outbound links.
 *
 * This is deliberately a tolerant scanner rather than a DOM parser. Crawled
 * pages are frequently malformed, and a strict parser that throws on bad markup
 * would fail an ingest over something a browser renders fine. Nothing here
 * executes or evaluates page content, so the usual reason to reach for a real
 * parser does not apply.
 *
 * Chrome, navigation, and script payloads are removed before extraction. Those
 * are the same words on every page of a site, and leaving them in means every
 * chunk retrieves the cookie banner.
 */

/** Elements whose entire contents are furniture, not answers. */
const STRIPPED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "select",
  "button",
];

/** Tags that imply a line break once their markup is gone. */
const BLOCK_ELEMENTS =
  "address|article|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|h1|h2|h3|h4|h5|h6|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul";

// Values are written as escapes so this source file stays plain ASCII, and so
// no long dash character ever appears literally in the codebase.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "...",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bull: "\u2022",
  middot: "\u00b7",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  deg: "\u00b0",
  eacute: "\u00e9",
  pound: "\u00a3",
  euro: "\u20ac",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const isHex = entity[1] === "x" || entity[1] === "X";
        const code = Number.parseInt(
          isHex ? entity.slice(2) : entity.slice(1),
          isHex ? 16 : 10
        );
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }

      const named = NAMED_ENTITIES[entity.toLowerCase()];
      return named === undefined ? match : named;
    }
  );
}

/** Removes comments and every element listed in STRIPPED_ELEMENTS. */
function stripFurniture(html: string): string {
  let output = html.replace(/<!--[\s\S]*?-->/g, " ");

  for (const tag of STRIPPED_ELEMENTS) {
    // Non-greedy to the matching close tag. An unclosed <nav> would otherwise
    // swallow the article, so a missing close tag falls back to dropping only
    // the open tag itself via the generic tag strip below.
    output = output.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
      " "
    );
  }

  return output;
}

export function extractTitle(html: string): string | null {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (titleMatch) {
    const title = decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim();
    if (title !== "") return title;
  }

  const h1Match = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  if (h1Match) {
    const heading = decodeHtmlEntities(h1Match[1].replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (heading !== "") return heading;
  }

  return null;
}

/** Readable body text, with paragraph breaks preserved for the chunker. */
export function extractReadableText(html: string): string {
  let text = stripFurniture(html);

  // Blocks become paragraph breaks so chunk boundaries land where a reader
  // would put them.
  text = text.replace(
    new RegExp(`<\\s*/?\\s*(?:${BLOCK_ELEMENTS})\\b[^>]*>`, "gi"),
    "\n\n"
  );

  text = text.replace(/<[^>]*>/g, " ");
  text = decodeHtmlEntities(text);

  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Every href on the page, resolved against the page URL. Fragments, mailto,
 * tel, javascript and data URLs are dropped here rather than left for the
 * crawler to trip over.
 */
export function extractLinks(html: string, pageUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }

  // An explicit <base href> changes what relative links mean.
  const baseMatch = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i.exec(html);
  if (baseMatch) {
    try {
      base = new URL(baseMatch[1], base);
    } catch {
      // A malformed base tag is ignored, which matches browser behaviour.
    }
  }

  const found: string[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

  for (
    let match = anchorPattern.exec(html);
    match !== null;
    match = anchorPattern.exec(html)
  ) {
    const raw = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (raw === "" || raw.startsWith("#")) continue;

    let resolved: URL;
    try {
      resolved = new URL(raw, base);
    } catch {
      continue;
    }

    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }

    // The fragment names a position on a page, not a different page, so
    // dropping it keeps the crawler from fetching the same document ten times.
    resolved.hash = "";
    const normalized = resolved.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    found.push(normalized);
  }

  return found;
}

/** True when the page asked robots not to index or follow it. */
export function readRobotsMeta(html: string): {
  noindex: boolean;
  nofollow: boolean;
} {
  const pattern =
    /<meta\b[^>]*\bname\s*=\s*["']?robots["']?[^>]*\bcontent\s*=\s*["']([^"']*)["']/gi;

  let noindex = false;
  let nofollow = false;

  for (
    let match = pattern.exec(html);
    match !== null;
    match = pattern.exec(html)
  ) {
    const directives = match[1].toLowerCase();
    if (directives.includes("noindex") || directives.includes("none")) {
      noindex = true;
    }
    if (directives.includes("nofollow") || directives.includes("none")) {
      nofollow = true;
    }
  }

  return { noindex, nofollow };
}
