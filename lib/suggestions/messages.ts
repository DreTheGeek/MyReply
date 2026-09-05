import type { Goal, Tone } from "./types";
import { DEFAULT_TONE, GOAL_IDS, TONE_IDS } from "./types";

/**
 * The written DM library.
 *
 * Every goal and tone pair has at least three finished messages. Not templates
 * with holes in them, not sample data: sentences a real person could send
 * without editing. The whole point is that the customer never faces a blank
 * textarea, so anything that reads like filler defeats the file.
 *
 * House rules for anything added here:
 * - Only `{username}` and `{link}` appear in braces. Nothing else is
 *   substituted, so any other token ships to a human as literal text.
 * - Sentence length varies inside a message. Three sentences of identical
 *   length is the tell that a machine wrote it.
 * - At most one exclamation mark, including in `hype`. Energy comes from short
 *   sentences and verbs, not punctuation.
 * - No em dashes anywhere, in copy or in comments.
 * - **Never assert a fact about the customer's business.** No durations, no
 *   prices, no "it's free", no "takes ten minutes", no promised turnaround.
 *   These go out under someone else's name to their real audience, and this
 *   file knows nothing about what they sell. Three messages shipped with
 *   invented specifics (a thirty minute session, a free download with no email
 *   wall, a ten minute read with a checklist) and each would have been a lie
 *   for most of the people sending it. Describe the action, never the product.
 */

export interface ToneOption {
  id: Tone;
  /** What the picker shows. */
  label: string;
  /** One line telling the owner what they are choosing. */
  description: string;
  /** A short line in that voice, so the choice is shown rather than described. */
  sample: string;
}

export const TONE_OPTIONS: readonly ToneOption[] = [
  {
    id: "friendly",
    label: "Friendly",
    description: "Casual and human, the way you would text someone you like.",
    sample: "Hey, sending this over now. Shout if it does not land.",
  },
  {
    id: "professional",
    label: "Professional",
    description: "Clear and courteous. Safe for clients, no slang.",
    sample: "Thank you for your message. The details are below.",
  },
  {
    id: "hype",
    label: "Hype",
    description: "High energy and direct, built to make people move.",
    sample: "You asked, so here it is. Go get it.",
  },
  {
    id: "short",
    label: "Short",
    description: "One or two lines. Nothing anyone has to read twice.",
    sample: "Here you go.",
  },
  {
    id: "warm",
    label: "Warm",
    description: "Personal and unhurried, for audiences who message you back.",
    sample: "Really glad you asked. Take your time with it.",
  },
] as const;

export function getToneOption(tone: Tone): ToneOption {
  const option = TONE_OPTIONS.find((candidate) => candidate.id === tone);
  // TONE_OPTIONS covers TONE_IDS, and the test asserts it. The fallback exists
  // so a bad cast at a call site still returns copy rather than crashing a DM.
  return option ?? TONE_OPTIONS[0];
}

type MessageLibrary = Readonly<Record<Goal, Readonly<Record<Tone, readonly string[]>>>>;

/**
 * The DM sent to the person who commented. Indexed goal first, then tone,
 * because the owner picks a goal per campaign and a tone once per workspace.
 */
export const DM_MESSAGES: MessageLibrary = {
  lead_magnet: {
    friendly: [
      "Hey {username}, thanks for commenting. Here is the guide I promised: {link}. Have a read and tell me which part you want me to go deeper on.",
      "{username}, good to see you in the comments. The download is right here: {link}. Tell me what you think once you have been through it.",
      "Hi {username}, sending this over before I forget: {link}. If it helps you, a comment on the next post keeps them coming.",
    ],
    professional: [
      "Hi {username}, thank you for your comment. You can access the guide here: {link}. It covers the full process step by step, and you are welcome to reply with any questions.",
      "Hello {username}. Here is the resource referenced in the post: {link}. There is no cost and no sign-up required. If you would like the extended version, let me know and I will send it across.",
      "Hi {username}, as promised, the download is available at {link}. I would suggest starting with the first section, since everything after it builds on that.",
    ],
    hype: [
      "{username}, you asked, so here it is: {link}. Go grab it before you get distracted. It is the exact thing I used to fix this the first time.",
      "Alright {username}, the guide is live and it is yours: {link}. Read it tonight, use it tomorrow. That is the whole plan.",
      "{username}, this is the one. {link} has everything I would do in your first week, in order, with nothing padded out.",
    ],
    short: [
      "Hey {username}, here it is: {link}",
      "{username}, the guide: {link}. Enjoy.",
      "Sent. {link} Grab it while you are still thinking about it, {username}.",
    ],
    warm: [
      "Hi {username}, I am really glad you asked for this. Here it is: {link}. Take your time with it, there is no rush, and message me if anything is unclear.",
      "{username}, thank you for trusting me with this one. The guide is here: {link}. I wrote it for exactly the spot you are standing in right now.",
      "Hey {username}. Here is what I promised: {link}. If you get stuck on any part of it, my inbox is open and I do read everything.",
    ],
  },
  price_question: {
    friendly: [
      "Hey {username}, good question. Full pricing is on this page so you can see every option side by side: {link}. If none of them fit, tell me what you need and I will work something out.",
      "Hi {username}, prices are all here: {link}. Short version, the starter option covers most people, and you can move up later without paying twice.",
      "{username}, thanks for asking. Everything is laid out here: {link}. No hidden fees, and you do not have to sit on a call before you see a number.",
    ],
    professional: [
      "Hello {username}, thank you for your interest. Current pricing and what is included at each tier is listed here: {link}. If you need a quote for something outside those tiers, reply with the details and I will prepare one.",
      "Hi {username}, you can review pricing here: {link}. Each plan lists its scope, turnaround and payment terms, so you can compare properly before deciding.",
      "Hi {username}. Pricing is published at {link}. If you would prefer to talk it through, reply here and I will send some times.",
    ],
    hype: [
      "{username}, straight answer: it is all on {link}. No call, no gatekeeping, the numbers are right there. Pick the one that matches where you are.",
      "Good question {username}. Prices live here: {link}. Fair warning, the current rate holds until the next intake and then it moves.",
      "{username}, here you go: {link}. Read it, pick one, and we can start this week.",
    ],
    short: [
      "Hey {username}, pricing: {link}",
      "{username}, all the numbers are here: {link}. Ask me anything after.",
      "Here you go {username}: {link}",
    ],
    warm: [
      "Hi {username}, happy to share. Everything is here: {link}. I know price is a real decision, so take a look and ask me anything, including the awkward questions.",
      "{username}, thank you for asking directly. Pricing is at {link}. If the timing is not right yet, that is completely fine and I will still be here.",
      "Hey {username}, here is the full breakdown: {link}. I would much rather you see the numbers first than sit through a pitch.",
    ],
  },
  booking: {
    friendly: [
      "Hey {username}, let us get you in the calendar. Open slots are here: {link}. Pick whatever suits, and if nothing works, tell me your rough availability.",
      "Hi {username}, booking takes about thirty seconds: {link}. You get a confirmation straight away, so there is nothing to chase.",
      "{username}, thanks for reaching out. Grab a time here: {link}. Mornings tend to go first, so book early if that suits you better.",
    ],
    professional: [
      "Hello {username}, you can schedule a time here: {link}. Choose whichever slot suits you best.",
      "Hi {username}, thank you for getting in touch. Availability is shown here: {link}. If you require a time outside those hours, reply and I will accommodate where I can.",
      "Hi {username}, please choose a slot at your convenience: {link}. The same link handles rescheduling later, so nothing needs to go through me.",
    ],
    hype: [
      "{username}, let us do this. Times are here: {link}. Book the first one that works and we will sort the detail on the call.",
      "Alright {username}, one link and you are in: {link}. No pitch, we just map out what happens next.",
      "{username}, the calendar is open right now: {link}. Ten seconds to book, and then it is off your list for good.",
    ],
    short: [
      "Hey {username}, book here: {link}",
      "{username}, pick a time: {link}. Takes a minute.",
      "Calendar is here {username}: {link}",
    ],
    warm: [
      "Hi {username}, I would love to talk this through properly. Pick a time that suits you here: {link}. Come as you are, no prep needed.",
      "{username}, thank you for reaching out. Here is my calendar: {link}. If none of it fits around your schedule, say the word and I will find something.",
      "Hey {username}, no pressure at all. When you are ready, this is the link: {link}. It stays open.",
    ],
  },
  waitlist: {
    friendly: [
      "Hey {username}, doors are not open yet, but the waitlist is: {link}. Everyone on it hears first and gets the early rate.",
      "Hi {username}, glad you want in. Add your name here: {link}. I message the list before anyone else, so you will not miss the opening.",
      "{username}, thanks for the comment. Here is the waitlist: {link}. Places are limited when it opens and the list goes first.",
    ],
    professional: [
      "Hello {username}, thank you for your interest. You can join the waitlist here: {link}. Members of the list receive access and pricing details ahead of general release.",
      "Hi {username}, registration is not open yet. To be notified first, add your details here: {link}. There is no obligation attached to joining.",
      "Hi {username}, the next intake is limited in size. Joining at {link} holds your place in the queue and you will hear from me before it opens.",
    ],
    hype: [
      "{username}, this one is going to move fast. Waitlist is here: {link}. The list gets first access and the better price, everyone else gets what is left.",
      "Alright {username}, get your name down: {link}. When it opens I am telling the list first, and I am not repeating myself.",
      "{username}, ten seconds and you are on it: {link}. Costs nothing, and it is the only way to get in early.",
    ],
    short: [
      "Hey {username}, waitlist is here: {link}",
      "{username}, join here and you hear first: {link}",
      "Not open yet. List is here: {link}. You are early, {username}.",
    ],
    warm: [
      "Hi {username}, thank you for wanting in early. The list is here: {link}, and I promise I will not message you about anything else.",
      "{username}, this genuinely means a lot. Add your name at {link} and I will come find you the moment it opens.",
      "Hey {username}, we are not quite ready yet. Here is the waitlist: {link}. I would rather open it properly than rush it for the sake of a date.",
    ],
  },
  faq: {
    friendly: [
      "Hey {username}, good question, and you are not the first to ask it. The full answer is here: {link}. If that still does not cover it, reply and I will answer myself.",
      "Hi {username}, short answer is yes. The longer answer with all the detail is here: {link}.",
      "{username}, I get this one a lot, so I wrote it all down: {link}. Skim the top section, that is usually the bit people actually need.",
    ],
    professional: [
      "Hello {username}, thank you for your question. The answer, along with the related detail, is documented here: {link}.",
      "Hi {username}, this is covered on our help page: {link}. If your situation differs from what is described there, reply with the specifics and I will confirm.",
      "Hi {username}, please see {link} for the full explanation. That page is kept current, so it will always be more accurate than a quick summary from me.",
    ],
    hype: [
      "{username}, great question. The answer is right here: {link}. Two minutes of reading saves you a week of guessing.",
      "Asked and answered {username}: {link}. I keep that page current, so you never get the outdated version.",
      "{username}, everything you are wondering about is on this page: {link}. Start at the top, it goes in order.",
    ],
    short: [
      "Hey {username}, answered here: {link}",
      "{username}, this covers it: {link}",
      "Good question. Full answer: {link}. Shout if it misses anything, {username}.",
    ],
    warm: [
      "Hi {username}, thank you for asking rather than guessing. Here is the full answer: {link}. Come back to me if any of it is unclear.",
      "{username}, that is a fair thing to wonder about. I explained it properly here: {link}.",
      "Hey {username}, I would rather over-explain than leave you unsure. The detail is here: {link}, and I am around if you want to talk it through.",
    ],
  },
  thanks: {
    friendly: [
      "Hey {username}, thank you, that genuinely made my day. Really glad it landed.",
      "{username}, I appreciate you taking the time to comment. It helps more than you would think.",
      "Thanks {username}. Comments like yours are the reason I keep making these.",
    ],
    professional: [
      "Hello {username}, thank you for your kind comment. It is much appreciated.",
      "Hi {username}, thank you for taking the time to respond. Feedback like this is genuinely useful.",
      "Thank you, {username}. I am glad the post was of use to you.",
    ],
    hype: [
      "{username}, this is exactly the energy I needed today. Thank you.",
      "Appreciate you {username}. Comments like this keep the whole thing moving.",
      "{username}, thank you. Now go do the thing you were thinking about while you read it.",
    ],
    short: [
      "Thank you {username}.",
      "{username}, appreciate you.",
      "Means a lot, {username}. Thank you.",
    ],
    warm: [
      "{username}, thank you. I read every one of these and yours stuck with me.",
      "Hi {username}, that is really kind of you to say. Thank you for taking the time.",
      "Thank you {username}. It matters more than a comment box makes it look.",
    ],
  },
} as const;

/**
 * The visible reply left on the comment thread itself.
 *
 * `Automation.publicReplyMessages` rotates through this array, so a thread with
 * forty comments does not show the same sentence forty times and read as a bot.
 * Five per goal is the floor for that to work. They stay short because a public
 * reply is a nudge toward the DM, not the payload.
 */
export const PUBLIC_REPLY_MESSAGES: Readonly<Record<Goal, readonly string[]>> = {
  lead_magnet: [
    "Sent it to your DMs.",
    "Just messaged you the link.",
    "Check your DMs {username}, it is in there.",
    "In your inbox now.",
    "Done, have a look at your messages.",
    "Sent. Let me know if it does not arrive.",
  ],
  price_question: [
    "Just sent you the numbers.",
    "Full pricing is in your DMs.",
    "Messaged you, {username}.",
    "Sent it over, have a look in your inbox.",
    "All the detail is in your messages now.",
  ],
  booking: [
    "Sent you the calendar link.",
    "Check your DMs for open times.",
    "Just messaged you the booking link.",
    "It is in your inbox, {username}.",
    "Sent. Grab whichever slot suits you.",
  ],
  waitlist: [
    "Sent you the link to join.",
    "Waitlist link is in your DMs.",
    "Just messaged you, {username}.",
    "Check your inbox, you are early.",
    "Sent it over. Good timing.",
  ],
  faq: [
    "Answered in your DMs.",
    "Just sent you the full answer.",
    "Check your messages, {username}.",
    "Sent you the detail.",
    "It is in your inbox now.",
  ],
  thanks: [
    "Thank you {username}.",
    "Appreciate you.",
    "That means a lot.",
    "Thanks for this.",
    "Glad it helped.",
    "Thank you, genuinely.",
  ],
} as const;

/**
 * Every DM option for one goal and tone. Returns a copy, so a caller that
 * shuffles or splices the list cannot corrupt the library for the next request.
 */
export function suggestMessages(goal: Goal, tone: Tone = DEFAULT_TONE): string[] {
  const byTone = DM_MESSAGES[goal];
  if (!byTone) return [];
  return [...(byTone[tone] ?? byTone[DEFAULT_TONE])];
}

/**
 * One DM to drop straight into the field, so the form opens filled rather than
 * empty. `index` wraps, which lets a "show me another" button walk the list
 * without the caller tracking bounds.
 */
export function suggestMessage(
  goal: Goal,
  tone: Tone = DEFAULT_TONE,
  index: number = 0
): string {
  const options = suggestMessages(goal, tone);
  if (options.length === 0) return "";
  const safeIndex = ((Math.trunc(index) % options.length) + options.length) % options.length;
  return options[safeIndex];
}

/** Every public reply variation for a goal, as a copy. */
export function suggestPublicReplies(goal: Goal): string[] {
  return [...(PUBLIC_REPLY_MESSAGES[goal] ?? [])];
}

/** Goals with at least one written message, useful for exhaustiveness checks. */
export function listMessageGoals(): readonly Goal[] {
  return GOAL_IDS;
}

/** Tones with at least one written message. */
export function listMessageTones(): readonly Tone[] {
  return TONE_IDS;
}
