"use client";

/**
 * Day and night toggle.
 *
 * Both modes are first class. Light is the default, and dark is only ever
 * turned on by an explicit choice stored here, never by the OS setting. The
 * matching pre-paint script lives in app/layout.tsx.
 *
 * The current mode is read straight off the root element rather than mirrored
 * into React state. That class is set before hydration by the pre-paint
 * script, so a useState plus useEffect pair would render the wrong icon on the
 * first paint and then correct itself. useSyncExternalStore is the API built
 * for exactly this: a server snapshot, a client snapshot, and a subscription.
 */

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "myreply-theme";

type Theme = "light" | "dark";

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** The server always renders light, which is the default for a first visit. */
function getServerSnapshot(): Theme {
  return "light";
}

function apply(next: Theme): void {
  document.documentElement.classList.toggle("dark", next === "dark");
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private mode or blocked storage. The toggle still works for this page
    // view, it just will not be remembered.
  }
  for (const listener of listeners) listener();
}

export default function ThemeToggle(): React.JSX.Element {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const nextTheme: Theme = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={() => apply(nextTheme)}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
      className="inline-flex h-8 w-8 items-center justify-center rounded border border-border text-muted transition-colors hover:border-border-hover hover:text-foreground"
    >
      <span aria-hidden="true" className="text-sm leading-none">
        {theme === "dark" ? "☀" : "☽"}
      </span>
    </button>
  );
}
