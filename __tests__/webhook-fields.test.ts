/**
 * Webhook fields: echoes, edits, reactions and mentions.
 *
 * These four fields are delivered on scopes MyReply already holds and were
 * being dropped on the floor. The tests below pin the parsing rules that keep
 * them from breaking the paths that already work: an echo must never look like
 * an inbound message, and a mention must never look like a comment on our own
 * media.
 */

import { describe, expect, it } from "vitest";

import {
  parseCommentEvents,
  parseMentionEvents,
  parseMessageEchoEvents,
  parseMessageEditEvents,
  parseMessageEvents,
  parseReactionEvents,
} from "../lib/meta/webhook";

const ACCOUNT = "17841400000000000";
const USER = "1681657229596137";

function messaging(entryFields: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: 1,
        messaging: [
          {
            sender: { id: USER },
            recipient: { id: ACCOUNT },
            timestamp: 1_760_000_000_000,
            ...entryFields,
          },
        ],
      },
    ],
  };
}

/** An echo reverses the envelope: the account is the sender. */
function echo(message: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [
      {
        id: ACCOUNT,
        time: 1,
        messaging: [
          {
            sender: { id: ACCOUNT },
            recipient: { id: USER },
            timestamp: 1_760_000_000_000,
            message: { is_echo: true, ...message },
          },
        ],
      },
    ],
  };
}

function change(field: string, value: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [{ id: ACCOUNT, time: 1, changes: [{ field, value }] }],
  };
}

describe("parseMessageEchoEvents", () => {
  it("records a message the account sent, addressed to the person it went to", () => {
    const [event] = parseMessageEchoEvents(
      echo({ mid: "echo_1", text: "sent from my phone" })
    );

    expect(event).toMatchObject({
      instagramAccountId: ACCOUNT,
      messageId: "echo_1",
      messageText: "sent from my phone",
      recipientId: USER,
    });
    expect(event.sentAt?.getTime()).toBe(1_760_000_000_000);
  });

  it("keeps a textless echo, because sending a photo is still answering", () => {
    const [event] = parseMessageEchoEvents(
      echo({ mid: "echo_2", attachments: [{ type: "image" }] })
    );
    expect(event).toMatchObject({ messageId: "echo_2", messageText: "" });
  });

  it("drops an echo of a deleted message", () => {
    expect(
      parseMessageEchoEvents(echo({ mid: "echo_3", is_deleted: true }))
    ).toHaveLength(0);
  });

  it("ignores an ordinary inbound message", () => {
    expect(
      parseMessageEchoEvents(messaging({ message: { mid: "m1", text: "hi" } }))
    ).toHaveLength(0);
  });

  it("does not let an echo reach the automation path", () => {
    // The whole reason echoes were dropped in the first place: an autoreply
    // containing its own keyword would otherwise trigger itself forever.
    const payload = echo({ mid: "echo_4", text: "LINK" });

    expect(parseMessageEvents(payload)).toHaveLength(0);
    expect(parseMessageEchoEvents(payload)).toHaveLength(1);
  });
});

describe("parseMessageEditEvents", () => {
  it("returns the corrected text against the original message id", () => {
    const [event] = parseMessageEditEvents(
      messaging({ message_edit: { mid: "m_9", text: "LINK", num_edit: 1 } })
    );

    expect(event).toMatchObject({
      instagramAccountId: ACCOUNT,
      messageId: "m_9",
      messageText: "LINK",
      senderId: USER,
      numEdit: 1,
    });
  });

  it("defaults num_edit when Meta omits it", () => {
    const [event] = parseMessageEditEvents(
      messaging({ message_edit: { mid: "m_10", text: "LNIK fixed" } })
    );
    expect(event.numEdit).toBe(1);
  });

  it("drops an edit with no text left to match on", () => {
    expect(
      parseMessageEditEvents(
        messaging({ message_edit: { mid: "m_11", text: "   " } })
      )
    ).toHaveLength(0);
  });

  it("ignores the account correcting its own message", () => {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          messaging: [
            {
              sender: { id: ACCOUNT },
              recipient: { id: USER },
              message_edit: { mid: "m_12", text: "LINK", num_edit: 1 },
            },
          ],
        },
      ],
    };
    expect(parseMessageEditEvents(payload)).toHaveLength(0);
  });
});

describe("parseReactionEvents", () => {
  it("reports a react with its emoji", () => {
    const [event] = parseReactionEvents(
      messaging({
        reaction: { mid: "m_20", action: "react", reaction: "love", emoji: "❤️" },
      })
    );

    expect(event).toMatchObject({
      instagramAccountId: ACCOUNT,
      userId: USER,
      messageId: "m_20",
      action: "react",
      reaction: "love",
      emoji: "❤️",
    });
  });

  it("reports an unreact as an unreact, never as a react", () => {
    const [event] = parseReactionEvents(
      messaging({ reaction: { mid: "m_21", action: "unreact" } })
    );
    expect(event.action).toBe("unreact");
  });

  it("drops an action Meta has not documented", () => {
    expect(
      parseReactionEvents(
        messaging({ reaction: { mid: "m_22", action: "something_new" } })
      )
    ).toHaveLength(0);
  });

  it("ignores the account reacting in its own thread", () => {
    const payload = {
      object: "instagram",
      entry: [
        {
          id: ACCOUNT,
          time: 1,
          messaging: [
            {
              sender: { id: ACCOUNT },
              recipient: { id: USER },
              reaction: { mid: "m_23", action: "react" },
            },
          ],
        },
      ],
    };
    expect(parseReactionEvents(payload)).toHaveLength(0);
  });
});

describe("parseMentionEvents: both of Meta's shapes", () => {
  it("reads a caption mention off the dedicated mentions field", () => {
    const [event] = parseMentionEvents(
      change("mentions", { media_id: "media_1" })
    );

    expect(event).toMatchObject({
      instagramAccountId: ACCOUNT,
      mediaId: "media_1",
      surface: "caption",
      deliveredOn: "mentions",
    });
    expect(event.commentId).toBeUndefined();
  });

  it("reads a comment mention off the dedicated mentions field", () => {
    const [event] = parseMentionEvents(
      change("mentions", { comment_id: "comment_1", media_id: "media_2" })
    );

    expect(event).toMatchObject({
      mediaId: "media_2",
      commentId: "comment_1",
      surface: "comment",
      deliveredOn: "mentions",
    });
  });

  it("reads the same mention when Meta folds it into a comments notification", () => {
    // Meta's two documentation pages disagree about which field an Instagram
    // Login app gets. Both shapes have to produce the same event.
    const [event] = parseMentionEvents(
      change("comments", {
        item: "mention",
        id: "comment_2",
        media: { id: "media_3" },
        from: { id: "9999", username: "someone" },
      })
    );

    expect(event).toMatchObject({
      mediaId: "media_3",
      commentId: "comment_2",
      mentionerId: "9999",
      mentionerName: "someone",
      surface: "comment",
      deliveredOn: "comments",
    });
  });

  it("also accepts the is_mention marker on a comments notification", () => {
    const [event] = parseMentionEvents(
      change("comments", {
        is_mention: true,
        comment_id: "comment_3",
        media_id: "media_4",
      })
    );
    expect(event).toMatchObject({ commentId: "comment_3", deliveredOn: "comments" });
  });

  it("leaves an ordinary comment alone", () => {
    expect(
      parseMentionEvents(
        change("comments", {
          id: "comment_4",
          text: "LINK",
          media: { id: "media_5" },
          from: { id: "9999" },
        })
      )
    ).toHaveLength(0);
  });

  it("does not process a folded mention as a comment as well", () => {
    // A mention lives on someone else's media, so the private reply the comment
    // path would queue is rejected by Meta. It must take exactly one path.
    const payload = change("comments", {
      item: "mention",
      id: "comment_5",
      media: { id: "media_6" },
      from: { id: "9999" },
    });

    expect(parseCommentEvents(payload)).toHaveLength(0);
    expect(parseMentionEvents(payload)).toHaveLength(1);
  });

  it("still parses ordinary comments after the mention guard", () => {
    const [event] = parseCommentEvents(
      change("comments", {
        id: "comment_6",
        text: "LINK",
        media: { id: "media_7" },
        from: { id: "9999", username: "someone" },
      })
    );
    expect(event).toMatchObject({ commentId: "comment_6", mediaId: "media_7" });
  });

  it("ignores the account mentioning itself", () => {
    expect(
      parseMentionEvents(
        change("mentions", { media_id: "media_8", from: { id: ACCOUNT } })
      )
    ).toHaveLength(0);
  });

  it("drops a mention with no media to point at", () => {
    expect(parseMentionEvents(change("mentions", {}))).toHaveLength(0);
  });
});
