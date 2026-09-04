"use client";

/**
 * One fetch of the portal summary, shared by the nav badges, the right rail
 * and the portal page.
 *
 * These three surfaces render at the same moment from the same numbers, so
 * they must not each fetch their own copy: three requests would cost three
 * round trips and could disagree with one another on screen.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { PortalSummary } from "@/lib/portal/types";

const REFRESH_MS = 60_000;

interface PortalContextValue {
  summary: PortalSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** "all" means every connected account, which is the default. */
  accountId: string;
  setAccountId: (accountId: string) => void;
}

const PortalContext = createContext<PortalContextValue>({
  summary: null,
  loading: true,
  error: null,
  refresh: () => {},
  accountId: "all",
  setAccountId: () => {},
});

export function usePortal(): PortalContextValue {
  return useContext(PortalContext);
}

export function PortalProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [summary, setSummary] = useState<PortalSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("all");

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        // "all" is the absence of a filter, so it is never sent. The endpoint
        // treats a named id as a workspace-scoped lookup.
        const query =
          accountId === "all"
            ? ""
            : `?instagramAccountId=${encodeURIComponent(accountId)}`;
        const response = await fetch(`/api/portal/summary${query}`, { signal });
        const body = (await response.json()) as {
          success?: boolean;
          data?: PortalSummary;
          error?: string;
        };

        if (body.success && body.data) {
          setSummary(body.data);
          setError(null);
        } else {
          setError(body.error ?? "Could not load the portal");
        }
      } catch (caught) {
        // An abort is this component moving on, not a failure. Reporting it
        // would flash an error every time the account filter changes.
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError("Could not load the portal");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [accountId]
  );

  useEffect(() => {
    // Aborting on cleanup is what stops a slow response for the previous
    // account from landing after, and overwriting, the one just requested.
    const controller = new AbortController();

    // Every setState inside load() happens after an await, so this cannot
    // cascade renders. The rule cannot see across the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);

    // Polling is paused while the tab is hidden. A backgrounded dashboard
    // refreshing every minute all day is load nobody is looking at.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(controller.signal);
    }, REFRESH_MS);

    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);

  return (
    <PortalContext.Provider
      value={{
        summary,
        loading,
        error,
        refresh: () => void load(),
        accountId,
        setAccountId,
      }}
    >
      {children}
    </PortalContext.Provider>
  );
}
