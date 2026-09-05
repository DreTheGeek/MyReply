/**
 * Minimal CSV parser for the campaign importer.
 *
 * Handles quoted fields, commas and newlines inside quotes, and escaped
 * quotes (""). Returns one object per data row, keyed by the lowercased,
 * trimmed header names. Blank lines are skipped.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseRows(text);
  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const out: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    // Skip a fully empty line.
    if (cells.length === 1 && cells[0].trim() === "") continue;

    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? "").trim();
    });
    out.push(record);
  }

  return out;
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];

    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // Flush the last field and row if the file did not end with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Pull the shortcode out of an Instagram post or reel URL so a pasted link
 * can be matched against a media item's permalink. Returns null if the value
 * does not look like an Instagram post URL.
 */
export function instagramShortcode(value: string): string | null {
  const match = value.match(/instagram\.com\/(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

/**
 * RFC 4180 cell escaping.
 *
 * Wrapped in quotes when the value contains a comma, a newline or a quote,
 * with embedded quotes doubled. Null and undefined render as empty rather than
 * the literal words, which a spreadsheet would import as text.
 */
export function escapeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Formula-injection defence, per OWASP.
 *
 * A cell whose first character is =, @, + or - is executed as a formula when
 * the file is opened in Excel, Sheets or Numbers. An Instagram username or a
 * DM body is attacker-controlled text that lands in this export, so
 * `=cmd|'/c calc'!A1` as a display name would run on the machine of whoever
 * opens it.
 *
 * The fix is to prepend a single quote, which spreadsheets read as
 * "treat as text" and do not display. The offending character is deliberately
 * NOT stripped: that would silently corrupt real data, and "+1 555..." or a
 * handle starting with "-" are legitimate values somebody may need back.
 *
 * Leading whitespace is skipped when deciding, because some spreadsheet
 * versions trim it before parsing, so " =EVIL()" is the same attack.
 */
const FORMULA_TRIGGERS = new Set(["=", "@", "+", "-"]);

export function sanitizeCsvCell(value: string): string {
  if (value === "") return value;
  const leading = value.replace(/^\s+/, "");
  if (leading.length === 0) return value;
  return FORMULA_TRIGGERS.has(leading.charAt(0)) ? `'${value}` : value;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/**
 * Rows to a CSV document.
 *
 * Sanitise first, then escape. The other order would quote the cell before the
 * leading quote was added, putting the guard inside the quoted value where a
 * spreadsheet never sees it.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines: string[] = [
    columns.map((column) => escapeCsvCell(column.header)).join(","),
  ];

  for (const row of rows) {
    lines.push(
      columns
        .map((column) => {
          const raw = column.value(row);
          if (raw === null || raw === undefined) return "";
          return escapeCsvCell(sanitizeCsvCell(String(raw)));
        })
        .join(",")
    );
  }

  // CRLF, which is what RFC 4180 specifies and what Excel expects.
  return lines.join("\r\n");
}
