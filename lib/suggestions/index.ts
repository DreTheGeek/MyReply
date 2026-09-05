/**
 * The suggestion library.
 *
 * One law: never show a blank input. Every choice in this product is a pick,
 * not a think, and this module is where the things people pick from live.
 *
 * Everything re-exported here is pure. The only file in lib/suggestions that
 * touches the database is lib/suggestions/workspace-tone.ts, and it is
 * deliberately not re-exported, so importing this barrel from a client
 * component stays safe.
 */

export type {
  Goal,
  KnownPlaceholder,
  Tone,
} from "./types";
export {
  DEFAULT_TONE,
  GOAL_IDS,
  KNOWN_PLACEHOLDERS,
  TONE_IDS,
  extractPlaceholders,
  findUnknownPlaceholders,
  goalSchema,
  isGoal,
  isTone,
  toneSchema,
} from "./types";

export type { ToneOption } from "./messages";
export {
  DM_MESSAGES,
  PUBLIC_REPLY_MESSAGES,
  TONE_OPTIONS,
  getToneOption,
  listMessageGoals,
  listMessageTones,
  suggestMessage,
  suggestMessages,
  suggestPublicReplies,
} from "./messages";

export {
  GOAL_KEYWORDS,
  KEYWORD_BLOCKLIST,
  MAX_KEYWORD_SUGGESTIONS,
  MIN_KEYWORD_SUGGESTIONS,
  isBlockedKeyword,
  suggestKeywords,
} from "./keywords";

export type {
  BusinessHoursId,
  BusinessHoursPreset,
  BusinessHoursWindow,
  ConditionField,
  ConditionId,
  ConditionOperator,
  ConditionPreset,
  ConditionRule,
  DayOfWeek,
  FollowUpTimingId,
  FollowUpTimingPreset,
} from "./presets";
export {
  ALL_DAYS,
  BUSINESS_HOURS_PRESETS,
  CONDITION_PRESETS,
  FOLLOW_UP_TIMING_PRESETS,
  MAX_FOLLOW_UP_DELAY_MINUTES,
  WEEKDAYS,
  clampFollowUpDelayMinutes,
  getBusinessHoursPreset,
  getConditionPreset,
  getFollowUpTimingPreset,
  isWithinBusinessHours,
} from "./presets";

export type {
  AutomationDraft,
  AutomationDraftInput,
  GoalAutomationPresets,
  GoalCard,
} from "./goals";
export {
  GOAL_CARDS,
  buildAutomationDraft,
  getGoalCard,
  listGoalCards,
} from "./goals";

export type { WorkspaceToneValue } from "./tone";
export {
  WORKSPACE_TONE_VALUES,
  getWorkspaceTone,
  resolveTone,
  toneToWorkspaceTone,
} from "./tone";
