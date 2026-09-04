/**
 * The portal summary contract.
 *
 * This file is the single source of truth for the shape. The nav badges, the
 * right rail and the portal page all render from one fetch of it, so the types
 * live here rather than being redeclared in each component.
 */

export type BoardTone = "neutral" | "good" | "risk" | "pending";
export type AlertLevel = "INFO" | "WARNING" | "ERROR";
export type TaskSeverity = "info" | "warning" | "error";

export interface PortalKpi {
  label: string;
  /** Already formatted for display, including any percent sign. */
  value: string;
  /** One line against the previous equal period. Null when there is no prior period. */
  comparison: string | null;
  /** Fourteen daily points, oldest first. */
  series: number[];
}

export interface PortalKpis {
  dmsDelivered: PortalKpi;
  needsAttention: PortalKpi;
  capacityUsed: PortalKpi;
  systemHealth: PortalKpi;
  clickRate: PortalKpi;
}

export interface BoardRow {
  id: string;
  primary: string;
  secondary: string;
  status: string;
  tone: BoardTone;
}

export interface BoardLaneData {
  /** True total, which can exceed rows.length. */
  count: number;
  rows: BoardRow[];
}

export interface PortalBoard {
  live: BoardLaneData;
  inFlight: BoardLaneData;
  needsAttention: BoardLaneData;
}

export interface ActivityRow {
  id: string;
  commenterName: string | null;
  campaignName: string;
  status: string;
  createdAt: string;
}

export interface PerformancePanel {
  sent: number;
  failed: number;
  skipped: number;
  clicks: number;
  clickRate: number;
  topKeywords: Array<{ keyword: string; count: number }>;
}

export interface AccountPanelRow {
  id: string;
  username: string;
  /** Carried so this row can feed the shared account selector directly. */
  instagramId: string;
  tokenExpiresAt: string | null;
  webhookSubscribed: boolean;
  dmsLast7Days: number;
}

export interface PortalPanels {
  recentActivity: ActivityRow[];
  performance: PerformancePanel;
  accounts: AccountPanelRow[];
}

export interface RailAlert {
  id: string;
  level: AlertLevel;
  message: string;
  createdAt: string;
  source: string;
}

export interface RailTask {
  id: string;
  label: string;
  detail: string;
  href: string;
  severity: TaskSeverity;
}

export interface RailUsage {
  dmsThisPeriod: number;
  periodStart: string;
  limit: number | null;
}

export interface PortalGreeting {
  userName: string | null;
  /** One sentence about the last twelve hours. Never a static string. */
  overnight: string;
  needsYouCount: number;
}

export interface PortalSummary {
  greeting: PortalGreeting;
  kpis: PortalKpis;
  board: PortalBoard;
  panels: PortalPanels;
  alerts: { items: RailAlert[]; total: number };
  tasks: RailTask[];
  usage: RailUsage;
}
