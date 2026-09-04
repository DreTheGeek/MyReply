/**
 * Turning an uploaded file into plain text.
 *
 * PDF and DOCX go to real libraries. Hand-rolling either is how you end up
 * shipping a parser that silently returns nothing for a third of real files:
 *
 *   unpdf   serverless build of Mozilla's pdf.js, no native modules, no
 *           filesystem access at import time, which is what makes it safe to
 *           run inside a Next.js route handler.
 *   mammoth the standard DOCX reader. extractRawText walks the document part
 *           rather than unzipping blindly, so headers, footnotes and tracked
 *           changes do not leak into the body text.
 *
 * TXT, MD and CSV are decoded here, because for those "parsing" means choosing
 * an encoding and a row layout, not decoding a container format.
 */

import { chunkQuestionAndAnswer, chunkText, type TextChunk } from "./chunk";

export type DocumentKind = "pdf" | "docx" | "txt" | "md" | "csv";

/** Upload ceiling. Above this the file is a data dump, not a knowledge source. */
export const MAX_DOCUMENT_BYTES = 15_000_000;

/** Sane ceiling on extracted text, so one enormous PDF cannot fill the table. */
export const MAX_DOCUMENT_CHARS = 2_000_000;

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentError";
  }
}

const EXTENSION_KINDS: Record<string, DocumentKind> = {
  pdf: "pdf",
  docx: "docx",
  txt: "txt",
  text: "txt",
  md: "md",
  markdown: "md",
  mdx: "md",
  csv: "csv",
  tsv: "csv",
};

const MIME_KINDS: Record<string, DocumentKind> = {
  "application/pdf": "pdf",
  "application/x-pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "csv",
  "application/csv": "csv",
};

export const ACCEPTED_UPLOAD_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".txt",
  ".md",
  ".csv",
];

/**
 * Decide what a file is. The extension is trusted first because it is what the
 * operator sees, and browsers report wildly inconsistent MIME types for CSV and
 * Markdown. The MIME type is only a fallback for an extensionless upload.
 */
export function detectDocumentKind(
  filename: string,
  mimeType?: string | null
): DocumentKind | null {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot > -1) {
    const extension = filename.slice(lastDot + 1).toLowerCase();
    const byExtension = EXTENSION_KINDS[extension];
    if (byExtension) return byExtension;
  }

  if (mimeType) {
    const bare = mimeType.split(";")[0].trim().toLowerCase();
    const byMime = MIME_KINDS[bare];
    if (byMime) return byMime;
  }

  return null;
}

function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Strip a byte order mark, which otherwise becomes the first character of the
  // first chunk and of the first CSV header.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * A small RFC 4180 reader. Quoted fields may contain the delimiter, newlines,
 * and doubled quotes. Written out rather than pulled in because the whole
 * behaviour is four rules and a dependency would be larger than the code.
 */
export function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (character === "\r") continue;

    if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += character;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

/**
 * Render a spreadsheet as prose. A raw comma soup retrieves badly, because a
 * chunk of it carries no column names. Pairing every value with its header
 * makes each row answer a question on its own.
 */
function csvToText(input: string, filename: string): string {
  const delimiter = filename.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  const rows = parseDelimited(input, delimiter);
  if (rows.length === 0) return "";

  const headers = rows[0].map((header) => header.trim());
  const body = rows.slice(1);

  // A single column, or a file with no data rows, is just a list of lines.
  if (headers.length < 2 || body.length === 0) {
    return rows.map((row) => row.join(" ").trim()).join("\n\n");
  }

  return body
    .map((row) =>
      headers
        .map((header, column) => {
          const value = (row[column] ?? "").trim();
          if (value === "") return null;
          return header === "" ? value : `${header}: ${value}`;
        })
        .filter((line): line is string => line !== null)
        .join("\n")
    )
    .filter((block) => block !== "")
    .join("\n\n");
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  // Imported lazily so a workspace that never uploads a PDF does not pay to
  // load pdf.js into every route handler that touches this module.
  const { extractText, getDocumentProxy } = await import("unpdf");

  // unpdf mutates the buffer it is handed, so it gets its own copy.
  const document = await getDocumentProxy(new Uint8Array(bytes));
  // mergePages joins the per-page arrays for us, so this is already one string.
  const { text } = await extractText(document, { mergePages: true });

  return text;
}

async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({
    buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  });
  return value;
}

/**
 * Extract plain text from an uploaded file. Throws DocumentError with a message
 * meant for the operator, so a failed ingest can put it straight in
 * KnowledgeSource.errorMessage.
 */
export async function extractDocumentText(
  bytes: Uint8Array,
  kind: DocumentKind,
  filename: string
): Promise<string> {
  if (bytes.byteLength === 0) {
    throw new DocumentError(`${filename} is empty`);
  }
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new DocumentError(
      `${filename} is larger than the ${Math.round(MAX_DOCUMENT_BYTES / 1_000_000)} MB limit`
    );
  }

  let text: string;

  try {
    switch (kind) {
      case "pdf":
        text = await extractPdfText(bytes);
        break;
      case "docx":
        text = await extractDocxText(bytes);
        break;
      case "csv":
        text = csvToText(decodeUtf8(bytes), filename);
        break;
      case "txt":
      case "md":
        text = decodeUtf8(bytes);
        break;
    }
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError(
      `${filename} could not be read: ${
        error instanceof Error ? error.message : "the file may be corrupt"
      }`
    );
  }

  const trimmed = text.trim();
  if (trimmed === "") {
    throw new DocumentError(
      kind === "pdf"
        ? `${filename} has no selectable text. Scanned pages need to be run through OCR first.`
        : `${filename} had no readable text in it`
    );
  }

  return trimmed.slice(0, MAX_DOCUMENT_CHARS);
}

/** Extract and chunk in one step, citing the filename. */
export async function chunkDocument(
  bytes: Uint8Array,
  kind: DocumentKind,
  filename: string
): Promise<TextChunk[]> {
  const text = await extractDocumentText(bytes, kind, filename);
  return chunkText(text, filename);
}

export { chunkQuestionAndAnswer };
