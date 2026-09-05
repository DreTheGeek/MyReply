import { describe, expect, it } from "vitest";

import {
  escapeCsvCell,
  parseCsv,
  sanitizeCsvCell,
  toCsv,
} from "../lib/utils/csv";

describe("escapeCsvCell", () => {
  it("leaves an ordinary value alone", () => {
    expect(escapeCsvCell("acme")).toBe("acme");
    expect(escapeCsvCell(42)).toBe("42");
  });

  it("quotes and doubles what RFC 4180 says to", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("renders absent values as empty, not as the word", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });
});

describe("sanitizeCsvCell", () => {
  // The attack: an Instagram display name or a DM body is attacker-controlled
  // text that ends up in this file, and a spreadsheet executes a cell starting
  // with one of these.
  it("defuses every formula trigger", () => {
    expect(sanitizeCsvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(sanitizeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(sanitizeCsvCell("+1+1")).toBe("'+1+1");
    expect(sanitizeCsvCell("-2+3")).toBe("'-2+3");
  });

  // Some spreadsheet versions trim before parsing, so whitespace is not cover.
  it("sees through leading whitespace", () => {
    expect(sanitizeCsvCell(" =EVIL()")).toBe("' =EVIL()");
    expect(sanitizeCsvCell("\t=EVIL()")).toBe("'\t=EVIL()");
    expect(sanitizeCsvCell("\n@EVIL()")).toBe("'\n@EVIL()");
  });

  // Stripping the character instead of escaping it would silently corrupt real
  // data that a customer may need back.
  it("never mutates the value, only prefixes it", () => {
    expect(sanitizeCsvCell("+15558675309")).toBe("'+15558675309");
    expect(sanitizeCsvCell("-brandname")).toBe("'-brandname");
  });

  it("leaves ordinary text and blanks alone", () => {
    expect(sanitizeCsvCell("acme")).toBe("acme");
    expect(sanitizeCsvCell("")).toBe("");
    expect(sanitizeCsvCell("   ")).toBe("   ");
  });
});

describe("toCsv", () => {
  interface Row {
    handle: string;
    sends: number;
    note: string | null;
  }

  const columns = [
    { header: "Handle", value: (r: Row) => r.handle },
    { header: "Sends", value: (r: Row) => r.sends },
    { header: "Note", value: (r: Row) => r.note },
  ];

  it("writes a header and one line per row", () => {
    const csv = toCsv(
      [
        { handle: "acme", sends: 3, note: null },
        { handle: "beta", sends: 0, note: "hello" },
      ],
      columns
    );

    expect(csv.split("\r\n")).toEqual([
      "Handle,Sends,Note",
      "acme,3,",
      "beta,0,hello",
    ]);
  });

  it("writes just the header when there are no rows", () => {
    expect(toCsv([], columns)).toBe("Handle,Sends,Note");
  });

  // The ordering that matters: sanitise, then escape. Reversed, the guard
  // would land inside the quoted value where a spreadsheet never sees it.
  it("puts the guard outside the quoting, not inside it", () => {
    const csv = toCsv([{ handle: '=HYPERLINK("http://evil")', sends: 1, note: null }], columns);
    const line = csv.split("\r\n")[1];

    expect(line.startsWith(`"'=HYPERLINK`)).toBe(true);
  });

  // The round trip is the real proof the escaping is correct.
  it("survives a round trip through the parser, punctuation and all", () => {
    const rows = [
      { handle: 'we, "the" people', sends: 7, note: "line\nbreak" },
      { handle: "=danger", sends: 0, note: null },
    ];

    const parsed = parseCsv(toCsv(rows, columns));

    expect(parsed).toHaveLength(2);
    expect(parsed[0].handle).toBe('we, "the" people');
    expect(parsed[0].note).toBe("line\nbreak");
    // The guard survives, which is the point: it is data now, not a formula.
    expect(parsed[1].handle).toBe("'=danger");
  });
});
