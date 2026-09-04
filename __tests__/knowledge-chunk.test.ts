import { describe, expect, it } from "vitest";

import {
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
  chunkQuestionAndAnswer,
  chunkText,
  normalizeText,
} from "../lib/knowledge/chunk";
import {
  detectDocumentKind,
  extractDocumentText,
  parseDelimited,
} from "../lib/knowledge/documents";

/**
 * The smallest PDF that still has a real text object in it, built by hand so
 * the PDF path is exercised against a genuine file rather than a mock. If unpdf
 * is ever swapped out, this is the test that notices.
 */
function buildPdf(sentence: string): Uint8Array {
  const content = `BT /F1 18 Tf 72 700 Td (${sentence}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(pdf.length);
  for (let index = 0; index < pdf.length; index += 1) {
    bytes[index] = pdf.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/** A paragraph of exactly `length` characters, made of readable words. */
function paragraph(length: number, word: string): string {
  const unit = `${word} `;
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length).trim();
}

describe("normalizeText", () => {
  it("keeps blank lines but collapses everything else", () => {
    expect(normalizeText("a  \t b\r\n\r\n\r\n  c   ")).toBe("a b\n\nc");
  });

  it("turns a non-breaking space into an ordinary one", () => {
    expect(normalizeText("open\u00a0today")).toBe("open today");
  });
});

describe("chunkText boundaries", () => {
  it("returns nothing for empty input", () => {
    expect(chunkText("   \n\n  ", "cite")).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = chunkText("We open at nine.", "Hours page");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      content: "We open at nine.",
      citation: "Hours page",
    });
  });

  it("splits on paragraph boundaries, never mid paragraph", () => {
    const first = paragraph(600, "alpha");
    const second = paragraph(600, "bravo");
    const third = paragraph(600, "delta");

    const chunks = chunkText(`${first}\n\n${second}\n\n${third}`, "cite");

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content).toBe(first);
    expect(chunks[1].content).toBe(second);
    expect(chunks[2].content).toBe(third);
  });

  it("merges short paragraphs up toward the minimum", () => {
    const short = paragraph(120, "short");
    const chunks = chunkText(Array(8).fill(short).join("\n\n"), "cite");

    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.content.length).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
    }
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    // The paragraph break survives the merge, so the structure is still there.
    expect(chunks[0].content).toContain("\n\n");
  });

  it("never exceeds the maximum even for one enormous paragraph", () => {
    const sentences = Array.from(
      { length: 60 },
      (_unused, index) => `Sentence number ${index} says something useful here.`
    ).join(" ");

    const chunks = chunkText(sentences, "cite");

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    }
    // Sentence ends were preferred, so no chunk starts mid word.
    for (const chunk of chunks) {
      expect(chunk.content.startsWith("Sentence")).toBe(true);
    }
  });

  it("falls back to word boundaries inside one huge sentence", () => {
    const words = Array(400).fill("watermelon").join(" ");
    const chunks = chunkText(words, "cite");

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      // Every piece is whole words, so no chunk has a truncated token.
      expect(
        chunk.content.split(" ").every((token) => token === "watermelon")
      ).toBe(true);
    }
  });

  it("hard cuts only a single token longer than the whole window", () => {
    const token = "z".repeat(2500);
    const chunks = chunkText(token, "cite");

    expect(chunks).toHaveLength(3);
    expect(chunks[0].content.length).toBe(MAX_CHUNK_CHARS);
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(token);
  });

  it("carries the citation onto every chunk", () => {
    const chunks = chunkText(
      Array(6).fill(paragraph(400, "word")).join("\n\n"),
      "Pricing (https://shop.test/pricing)"
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.citation).toBe("Pricing (https://shop.test/pricing)");
    }
  });

  it("honours a custom window", () => {
    const chunks = chunkText(paragraph(300, "word"), "cite", {
      minChars: 50,
      maxChars: 100,
    });

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("chunkQuestionAndAnswer", () => {
  it("keeps the pair together in one chunk and cites the question", () => {
    const chunk = chunkQuestionAndAnswer(
      "  Do you ship to Canada?  ",
      "  Yes, in five to seven days.  "
    );

    expect(chunk.content).toBe(
      "Q: Do you ship to Canada?\nA: Yes, in five to seven days."
    );
    expect(chunk.citation).toBe("Do you ship to Canada?");
  });

  it("does not split even a very long answer", () => {
    const chunk = chunkQuestionAndAnswer("Why?", paragraph(4000, "because"));
    expect(chunk.content.length).toBeGreaterThan(MAX_CHUNK_CHARS);
  });
});

describe("detectDocumentKind", () => {
  it.each([
    ["policy.pdf", "application/pdf", "pdf"],
    ["handbook.DOCX", "", "docx"],
    ["notes.txt", "text/plain", "txt"],
    ["readme.md", "", "md"],
    ["readme.markdown", "", "md"],
    ["prices.csv", "text/csv", "csv"],
    ["prices.tsv", "", "csv"],
  ])("reads %s as %s", (filename, mime, expected) => {
    expect(detectDocumentKind(filename, mime)).toBe(expected);
  });

  it("falls back to the MIME type when there is no extension", () => {
    expect(detectDocumentKind("upload", "application/pdf")).toBe("pdf");
  });

  it("refuses anything it cannot read", () => {
    expect(detectDocumentKind("archive.zip", "application/zip")).toBeNull();
    expect(detectDocumentKind("image.png", "image/png")).toBeNull();
    expect(detectDocumentKind("sheet.xlsx", "")).toBeNull();
  });
});

describe("parseDelimited", () => {
  it("handles quoted fields containing the delimiter and newlines", () => {
    expect(
      parseDelimited('a,b\n"one, two","line\nbreak"\n', ",")
    ).toEqual([
      ["a", "b"],
      ["one, two", "line\nbreak"],
    ]);
  });

  it("handles doubled quotes", () => {
    expect(parseDelimited('name\n"He said ""hi"""\n', ",")).toEqual([
      ["name"],
      ['He said "hi"'],
    ]);
  });

  it("drops rows that are entirely blank", () => {
    expect(parseDelimited("a,b\n\n,\nc,d\n", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("extractDocumentText", () => {
  const encode = (text: string): Uint8Array =>
    new TextEncoder().encode(text);

  it("reads plain text and strips a byte order mark", async () => {
    const text = await extractDocumentText(
      encode("\ufeffOpen at nine."),
      "txt",
      "hours.txt"
    );
    expect(text).toBe("Open at nine.");
  });

  it("pairs every CSV value with its header so a row stands alone", async () => {
    const text = await extractDocumentText(
      encode("Product,Price,Notes\nMug,12,Ships free\nHat,25,\n"),
      "csv",
      "prices.csv"
    );

    expect(text).toBe(
      "Product: Mug\nPrice: 12\nNotes: Ships free\n\nProduct: Hat\nPrice: 25"
    );
  });

  it("rejects an empty file with a readable message", async () => {
    await expect(
      extractDocumentText(new Uint8Array(0), "txt", "blank.txt")
    ).rejects.toThrowError(/blank.txt is empty/);
  });

  it("rejects a file with no readable text in it", async () => {
    await expect(
      extractDocumentText(encode("   \n  \n "), "txt", "whitespace.txt")
    ).rejects.toThrowError(/no readable text/);
  });

  it("reads text out of a real PDF", async () => {
    const text = await extractDocumentText(
      buildPdf("Our shop opens at nine and closes at six."),
      "pdf",
      "hours.pdf"
    );
    expect(text).toContain("opens at nine");
  });

  it("reports a corrupt PDF against its own filename", async () => {
    await expect(
      extractDocumentText(encode("%PDF-1.4 not really a pdf"), "pdf", "scan.pdf")
    ).rejects.toThrowError(/scan.pdf/);
  });

  it("refuses a file over the size ceiling", async () => {
    await expect(
      extractDocumentText(new Uint8Array(20_000_000).fill(97), "txt", "huge.txt")
    ).rejects.toThrowError(/larger than the 15 MB limit/);
  });
});
