/**
 * Named choices that replace configuration.
 *
 * Nothing in here asks for a number. "VIP" instead of a follower threshold, "in
 * an hour" instead of a minute count, "9 to 5 weekdays" instead of a schedule
 * grid. The machine shape rides along on each option so the UI never has to
 * translate a label back into settings.
 *
 * Pure data and pure functions. No Prisma, no Zod, no imports at all, so a
 * client component can pull the labels without dragging a server module in.
 */

/* ------------------------------------------------------------------ *
 * Conditions
 * ------------------------------------------------------------------ */

export type ConditionId =
  | "vip"
  | "verified"
  | "already_follows"
  | "first_time"
  | "clicked_before";

/**
 * The commenter facts a condition can read. These are properties of the person
 * who triggered the campaign, resolved at send time, not columns on Automation.
 */
export type ConditionField =
  | "followerCount"
  | "isVerified"
  | "followsAccount"
  | "priorDmCount"
  | "priorLinkClickCount";

export type ConditionOperator = "gt" | "gte" | "lt" | "lte" | "eq";

export interface ConditionRule {
  field: ConditionField;
  operator: ConditionOperator;
  value: number | boolean;
}

export interface ConditionPreset {
  id: ConditionId;
  /** What the chip says. */
  label: string;
  /** One line, plain language, so nobody has to infer what the rule does. */
  explanation: string;
  /** The machine shape the evaluator reads. */
  rule: ConditionRule;
  /**
   * The Automation column this condition can be stored on today, if any.
   * Only the follow check has one. The rest have no column yet, so a caller
   * that wants to persist them needs somewhere to put them first.
   */
  automationField: "requireFollow" | null;
}

export const CONDITION_PRESETS: readonly ConditionPreset[] = [
  {
    id: "vip",
    label: "VIP",
    explanation: "Someone with more than 10,000 followers. Worth a different reply.",
    rule: { field: "followerCount", operator: "gt", value: 10_000 },
    automationField: null,
  },
  {
    id: "verified",
    label: "Verified",
    explanation: "Their account carries the blue check.",
    rule: { field: "isVerified", operator: "eq", value: true },
    automationField: null,
  },
  {
    id: "already_follows",
    label: "Already follows me",
    explanation: "They followed before they commented, so do not ask them again.",
    rule: { field: "followsAccount", operator: "eq", value: true },
    automationField: "requireFollow",
  },
  {
    id: "first_time",
    label: "First time",
    explanation: "You have never sent this person a DM before.",
    rule: { field: "priorDmCount", operator: "eq", value: 0 },
    automationField: null,
  },
  {
    id: "clicked_before",
    label: "Clicked before",
    explanation: "They have opened one of your links already, so they are warm.",
    rule: { field: "priorLinkClickCount", operator: "gt", value: 0 },
    automationField: null,
  },
] as const;

export function getConditionPreset(id: ConditionId): ConditionPreset | null {
  return CONDITION_PRESETS.find((preset) => preset.id === id) ?? null;
}

/* ------------------------------------------------------------------ *
 * Follow-up timing
 * ------------------------------------------------------------------ */

export type FollowUpTimingId = "right_away" | "in_an_hour" | "tomorrow_morning";

/**
 * 23 hours, not 24.
 *
 * Instagram's messaging window is 24 hours from the person's last interaction.
 * The Zod schema on app/api/automations/route.ts caps followUpDelayMinutes at
 * exactly 1440, which is the boundary itself: a follow-up scheduled there is
 * racing the window close and arrives after it as often as not. An hour of
 * headroom means the send lands inside the window even after queue delay.
 */
export const MAX_FOLLOW_UP_DELAY_MINUTES = 23 * 60;

export interface FollowUpTimingPreset {
  id: FollowUpTimingId;
  label: string;
  explanation: string;
  /** The Automation.followUpDelayMinutes value this option writes. */
  delayMinutes: number;
}

export const FOLLOW_UP_TIMING_PRESETS: readonly FollowUpTimingPreset[] = [
  {
    id: "right_away",
    label: "Right away",
    explanation: "Sends the moment the first message goes out.",
    delayMinutes: 0,
  },
  {
    id: "in_an_hour",
    label: "In an hour",
    explanation: "Long enough that it does not read as automated.",
    delayMinutes: 60,
  },
  {
    id: "tomorrow_morning",
    label: "Tomorrow morning",
    explanation:
      "About 16 hours later, still inside Instagram's 24 hour messaging window.",
    delayMinutes: 16 * 60,
  },
] as const;

export function getFollowUpTimingPreset(
  id: FollowUpTimingId
): FollowUpTimingPreset | null {
  return FOLLOW_UP_TIMING_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Force any delay into the range the sender can actually honour. Negative
 * values become 0, anything past 23 hours is pulled back to it, and a fraction
 * is truncated because the column is an integer.
 */
export function clampFollowUpDelayMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  const truncated = Math.trunc(minutes);
  if (truncated < 0) return 0;
  if (truncated > MAX_FOLLOW_UP_DELAY_MINUTES) return MAX_FOLLOW_UP_DELAY_MINUTES;
  return truncated;
}

/* ------------------------------------------------------------------ *
 * Business hours
 * ------------------------------------------------------------------ */

export type BusinessHoursId =
  | "always_on"
  | "weekdays_9_5"
  | "weekends_too"
  | "my_timezone";

/** 0 is Sunday, matching Date.prototype.getDay. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const ALL_DAYS: readonly DayOfWeek[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS: readonly DayOfWeek[] = [1, 2, 3, 4, 5];

export interface BusinessHoursWindow {
  /** True means send at any hour and ignore every other field here. */
  alwaysOn: boolean;
  days: readonly DayOfWeek[];
  /** Inclusive, 0 to 23. */
  startHour: number;
  /** Exclusive, 1 to 24. */
  endHour: number;
  /**
   * True reads the hours in the owner's own timezone. False reads them in UTC,
   * which is only ever right for the always-on option, where hours do not
   * matter at all.
   */
  useLocalTimezone: boolean;
}

export interface BusinessHoursPreset {
  id: BusinessHoursId;
  label: string;
  explanation: string;
  window: BusinessHoursWindow;
}

export const BUSINESS_HOURS_PRESETS: readonly BusinessHoursPreset[] = [
  {
    id: "always_on",
    label: "Always on",
    explanation: "Replies go out the second a comment lands, day or night.",
    window: {
      alwaysOn: true,
      days: ALL_DAYS,
      startHour: 0,
      endHour: 24,
      useLocalTimezone: false,
    },
  },
  {
    id: "weekdays_9_5",
    label: "9 to 5 weekdays",
    explanation: "Monday to Friday, office hours. Weekend comments wait until Monday.",
    window: {
      alwaysOn: false,
      days: WEEKDAYS,
      startHour: 9,
      endHour: 17,
      useLocalTimezone: true,
    },
  },
  {
    id: "weekends_too",
    label: "Weekends too",
    explanation: "Same 9 to 5, seven days a week. Good for anything people buy on a Sunday.",
    window: {
      alwaysOn: false,
      days: ALL_DAYS,
      startHour: 9,
      endHour: 17,
      useLocalTimezone: true,
    },
  },
  {
    id: "my_timezone",
    label: "My timezone",
    explanation:
      "Waking hours only, 8am to 8pm every day, read in your timezone rather than UTC.",
    window: {
      alwaysOn: false,
      days: ALL_DAYS,
      startHour: 8,
      endHour: 20,
      useLocalTimezone: true,
    },
  },
] as const;

export function getBusinessHoursPreset(
  id: BusinessHoursId
): BusinessHoursPreset | null {
  return BUSINESS_HOURS_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * Whether a window allows sending at a given local time. Callers pass a Date
 * already shifted into the owner's timezone when useLocalTimezone is true,
 * because this module has no timezone database and should not grow one.
 */
export function isWithinBusinessHours(
  window: BusinessHoursWindow,
  at: Date
): boolean {
  if (window.alwaysOn) return true;
  const day = at.getDay() as DayOfWeek;
  if (!window.days.includes(day)) return false;
  const hour = at.getHours();
  return hour >= window.startHour && hour < window.endHour;
}
