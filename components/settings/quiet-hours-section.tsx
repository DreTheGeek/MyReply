"use client";

/**
 * Quiet hours, in settings.
 *
 * The default is 9pm to 9am in UTC, which is right for almost nobody, so this
 * screen exists to make the feature real rather than theoretical. It offers the
 * browser's own detected timezone as the first option, because that is the
 * answer for the overwhelming majority of single-operator accounts and saves
 * them scrolling a list of four hundred zones.
 */

import { useEffect, useState, useSyncExternalStore } from "react";

interface Settings {
  timezone: string;
  quietHoursEnabled: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  canManage: boolean;
}

/** The zones an Instagram account is realistically run from, plus theirs. */
const COMMON_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Never changes within a session, so nothing ever needs to notify. */
function subscribeToNothing(): () => void {
  return () => {};
}

function readBrowserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/** The server has no browser timezone, and must not guess its own. */
function noTimezoneOnServer(): null {
  return null;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12am";
  if (hour === 12) return "12pm";
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

export default function QuietHoursSection(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detected = useSyncExternalStore(
    subscribeToNothing,
    readBrowserTimezone,
    noTimezoneOnServer
  );

  useEffect(() => {
    fetch("/api/workspace/messaging")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) setSettings(payload.data);
        else setError(payload.error ?? "Could not load messaging settings.");
      })
      .catch(() => setError("Could not reach the server."))
      .finally(() => setLoading(false));
  }, []);

  async function save(next: Settings) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/workspace/messaging", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timezone: next.timezone,
          quietHoursEnabled: next.quietHoursEnabled,
          quietHoursStart: next.quietHoursStart,
          quietHoursEnd: next.quietHoursEnd,
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        setError(payload?.error ?? "Could not save that.");
        return;
      }
      setSettings(payload.data);
      setNotice("Saved.");
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <section className="panel h-40 rounded p-4 sm:p-6" />;
  }

  if (!settings) {
    return (
      <section className="panel rounded p-4 sm:p-6">
        <h2 className="text-base font-semibold">Quiet hours</h2>
        <p className="mt-2 text-sm text-error">
          {error ?? "Could not load messaging settings."}
        </p>
      </section>
    );
  }

  const zones = Array.from(
    new Set([detected, settings.timezone, ...COMMON_ZONES].filter(Boolean))
  ) as string[];

  const disabled = !settings.canManage || saving;

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold">Quiet hours</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        Follow-up messages are held overnight and sent when the window opens.
        The reply someone gets for commenting is never held: they just asked for
        it, so it goes out straight away whatever the hour.
      </p>

      <div className="mt-5 space-y-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={settings.quietHoursEnabled}
            disabled={disabled}
            onChange={(e) =>
              void save({ ...settings, quietHoursEnabled: e.target.checked })
            }
            className="mt-0.5"
          />
          <span className="text-sm text-foreground">
            Hold follow-ups overnight
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label
              htmlFor="workspace-timezone"
              className="block text-sm font-medium text-foreground"
            >
              Your timezone
            </label>
            <select
              id="workspace-timezone"
              value={settings.timezone}
              disabled={disabled}
              onChange={(e) => void save({ ...settings, timezone: e.target.value })}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-50"
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                  {zone === detected ? " (detected)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="quiet-start"
              className="block text-sm font-medium text-foreground"
            >
              Quiet from
            </label>
            <select
              id="quiet-start"
              value={settings.quietHoursStart}
              disabled={disabled}
              onChange={(e) =>
                void save({
                  ...settings,
                  quietHoursStart: Number(e.target.value),
                })
              }
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-50"
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="quiet-end"
              className="block text-sm font-medium text-foreground"
            >
              Until
            </label>
            <select
              id="quiet-end"
              value={settings.quietHoursEnd}
              disabled={disabled}
              onChange={(e) =>
                void save({ ...settings, quietHoursEnd: Number(e.target.value) })
              }
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-50"
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {hourLabel(hour)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {settings.quietHoursStart === settings.quietHoursEnd && (
          <p className="text-xs text-warning">
            Those are the same hour, so nothing is held. Pick different times to
            switch quiet hours on.
          </p>
        )}

        <p className="text-xs text-muted">
          Anyone who replies STOP is opted out automatically and stops receiving
          messages from this account.
        </p>

        {!settings.canManage && (
          <p className="text-xs text-muted">
            Only owners and admins can change this.
          </p>
        )}
        {error && <p className="text-sm text-error">{error}</p>}
        {notice && <p className="text-sm text-success">{notice}</p>}
      </div>
    </section>
  );
}
