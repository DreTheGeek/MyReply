import { describe, expect, it } from "vitest";

import { inferAttachmentType } from "../lib/meta/client";

describe("inferAttachmentType", () => {
  it("recognises images", () => {
    expect(inferAttachmentType("https://cdn.example.com/guide.png")).toBe("image");
    expect(inferAttachmentType("https://cdn.example.com/a.JPG")).toBe("image");
    expect(inferAttachmentType("https://cdn.example.com/a.jpeg")).toBe("image");
    expect(inferAttachmentType("https://cdn.example.com/a.webp")).toBe("image");
  });

  it("recognises video and audio", () => {
    expect(inferAttachmentType("https://cdn.example.com/clip.mp4")).toBe("video");
    expect(inferAttachmentType("https://cdn.example.com/clip.mov")).toBe("video");
    expect(inferAttachmentType("https://cdn.example.com/voice.mp3")).toBe("audio");
  });

  it("treats a PDF as a file, which is what Instagram calls a document", () => {
    expect(inferAttachmentType("https://cdn.example.com/pricing.pdf")).toBe("file");
  });

  it("ignores query strings and fragments when reading the extension", () => {
    // Signed and cache-busted URLs are the normal case, not the exception.
    expect(
      inferAttachmentType("https://cdn.example.com/guide.png?v=2&sig=abc")
    ).toBe("image");
    expect(inferAttachmentType("https://cdn.example.com/deck.pdf#page=3")).toBe(
      "file"
    );
  });

  it("falls back to file for an extensionless URL rather than guessing image", () => {
    // Meta rejects a mismatched type, so the permissive option is the safe one.
    expect(inferAttachmentType("https://example.com/download/12345")).toBe("file");
  });
});
