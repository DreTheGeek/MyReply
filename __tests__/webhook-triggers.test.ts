import { describe, expect, it } from "vitest";

import {
  parseLiveCommentEvents,
  parseMessageEvents,
  parseReferralEvents,
} from "../lib/meta/webhook";

const ACCOUNT = "17841400000000000";
const USER = "1681657229596137";

function messaging(message: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: 1,
        messaging: [{ sender: { id: USER }, recipient: { id: ACCOUNT }, message }],
      },
    ],
  };
}

describe("parseMessageEvents: telling the three inbound kinds apart", () => {
  it("marks an ordinary DM as a dm", () => {
    const [event] = parseMessageEvents(
      messaging({ mid: "m1", text: "LINK please" })
    );
    expect(event).toMatchObject({ kind: "dm", messageText: "LINK please" });
    expect(event.storyId).toBeUndefined();
  });

  it("marks a reply to a story as a story_reply and keeps the story id", () => {
    const [event] = parseMessageEvents(
      messaging({
        mid: "m2",
        text: "how much?",
        reply_to: { story: { id: "story_9", url: "https://cdn/story.jpg" } },
      })
    );
    expect(event).toMatchObject({
      kind: "story_reply",
      messageText: "how much?",
      storyId: "story_9",
      storyUrl: "https://cdn/story.jpg",
    });
  });

  it("keeps a story mention even though it carries no text", () => {
    // The old parser dropped these outright, because it required text.
    const [event] = parseMessageEvents(
      messaging({
        mid: "m3",
        attachments: [
          { type: "story_mention", payload: { url: "https://cdn/mention.jpg" } },
        ],
      })
    );
    expect(event).toMatchObject({
      kind: "story_mention",
      messageText: "",
      storyUrl: "https://cdn/mention.jpg",
    });
  });

  it("still drops a textless message that is not a story mention", () => {
    expect(
      parseMessageEvents(
        messaging({ mid: "m4", attachments: [{ type: "image" }] })
      )
    ).toHaveLength(0);
  });

  it("treats a mention as a mention even when it also carries text", () => {
    const [event] = parseMessageEvents(
      messaging({
        mid: "m5",
        text: "look",
        attachments: [{ type: "story_mention" }],
      })
    );
    expect(event.kind).toBe("story_mention");
  });

  it("still ignores echoes, deletions and unsupported messages", () => {
    expect(parseMessageEvents(messaging({ mid: "e", text: "x", is_echo: true })))
      .toHaveLength(0);
    expect(
      parseMessageEvents(messaging({ mid: "d", text: "x", is_deleted: true }))
    ).toHaveLength(0);
    expect(
      parseMessageEvents(messaging({ mid: "u", text: "x", is_unsupported: true }))
    ).toHaveLength(0);
  });

  it("ignores a story reply the account sent to itself", () => {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          messaging: [
            {
              sender: { id: ACCOUNT },
              recipient: { id: ACCOUNT },
              message: { mid: "m6", text: "hi", reply_to: { story: { id: "s" } } },
            },
          ],
        },
      ],
    };
    expect(parseMessageEvents(payload)).toHaveLength(0);
  });
});

describe("parseLiveCommentEvents", () => {
  function live(value: Record<string, unknown>) {
    return {
      object: "instagram",
      entry: [
        { id: ACCOUNT, time: 1, changes: [{ field: "live_comments", value }] },
      ],
    };
  }

  it("parses a comment left on a live broadcast", () => {
    const [event] = parseLiveCommentEvents(
      live({
        id: "lc1",
        text: "LINK",
        from: { id: USER, username: "viewer" },
        media: { id: "live_1" },
      })
    );
    expect(event).toMatchObject({
      instagramAccountId: ACCOUNT,
      commentId: "lc1",
      commentText: "LINK",
      commenterId: USER,
      commenterName: "viewer",
      mediaId: "live_1",
    });
  });

  it("ignores the host commenting on their own broadcast", () => {
    expect(
      parseLiveCommentEvents(
        live({ id: "lc2", text: "hi", from: { id: ACCOUNT }, media: { id: "l" } })
      )
    ).toHaveLength(0);
  });

  it("does not confuse a feed comment for a live comment", () => {
    const feed = {
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          changes: [
            {
              field: "comments",
              value: { id: "c1", text: "LINK", from: { id: USER }, media: { id: "m" } },
            },
          ],
        },
      ],
    };
    expect(parseLiveCommentEvents(feed)).toHaveLength(0);
  });
});

describe("parseReferralEvents", () => {
  it("reads a ref from a fresh conversation", () => {
    const [event] = parseReferralEvents({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          messaging: [
            {
              sender: { id: USER },
              recipient: { id: ACCOUNT },
              referral: { ref: "qr-flyer-a", source: "QR_CODE", type: "OPEN_THREAD" },
            },
          ],
        },
      ],
    });
    expect(event).toMatchObject({ ref: "qr-flyer-a", source: "QR_CODE", userId: USER });
  });

  it("reads a ref nested inside a postback", () => {
    const [event] = parseReferralEvents({
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          messaging: [
            {
              sender: { id: USER },
              recipient: { id: ACCOUNT },
              postback: { payload: "GET_STARTED", referral: { ref: "site-button" } },
            },
          ],
        },
      ],
    });
    expect(event.ref).toBe("site-button");
  });

  it("ignores messaging with no ref at all", () => {
    expect(
      parseReferralEvents({
        object: "instagram",
        entry: [
          {
            id: ACCOUNT,
            time: 1,
            messaging: [
              { sender: { id: USER }, recipient: { id: ACCOUNT }, message: { mid: "m", text: "hi" } },
            ],
          },
        ],
      })
    ).toHaveLength(0);
  });

  it("ignores non-instagram payloads", () => {
    expect(
      parseReferralEvents({
        object: "page",
        entry: [
          {
            id: ACCOUNT,
            time: 1,
            messaging: [
              { sender: { id: USER }, recipient: { id: ACCOUNT }, referral: { ref: "x" } },
            ],
          },
        ],
      })
    ).toHaveLength(0);
  });
});
