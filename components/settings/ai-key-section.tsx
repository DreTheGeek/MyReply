"use client";

/**
 * AI Key Section
 *
 * MyReply is bring your own key. This is where a workspace owner or admin
 * pastes the provider key that Ask MyReply runs on.
 *
 * The key is write only. Once saved it is never sent back to the browser, not
 * even to the person who typed it, so the field clears on save and what remains
 * on screen is a masked hint. A MEMBER sees the same state, read only.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";

export interface AiKeyProviderOption {
  id: string;
  label: string;
  defaultModel: string;
  consoleUrl: string;
  keyPlaceholder: string;
}

export interface AiKeyStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  /** Masked head and tail, for example sk-ant-...4f2a. Never the whole key. */
  keyHint: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  canManage: boolean;
  providers: AiKeyProviderOption[];
}

export interface AiKeySectionProps {
  /**
   * Seed the panel from a server render and skip the first fetch. Omit it and
   * the component loads its own status on mount.
   */
  initialStatus?: AiKeyStatus;
  /** Fires after a successful save or remove, with the new status. */
  onChange?: (status: AiKeyStatus) => void;
  /** Extra classes on the outer section. */
  className?: string;
}

const ENDPOINT = "/api/workspace/ai-key";

function isStatus(value: unknown): value is AiKeyStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    "configured" in value &&
    "providers" in value
  );
}

function readError(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null) {
    const error = (payload as Record<string, unknown>).error;
    if (typeof error === "string" && error) return error;
  }
  return fallback;
}

export default function AiKeySection({
  initialStatus,
  onChange,
  className = "",
}: AiKeySectionProps): React.JSX.Element {
  const [status, setStatus] = useState<AiKeyStatus | null>(
    initialStatus ?? null
  );
  const [loading, setLoading] = useState(!initialStatus);
  const [provider, setProvider] = useState(initialStatus?.provider ?? "");
  const [model, setModel] = useState(initialStatus?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const applyStatus = useCallback(
    (next: AiKeyStatus): void => {
      setStatus(next);
      setProvider(next.provider ?? next.providers[0]?.id ?? "");
      setModel(next.model ?? next.providers[0]?.defaultModel ?? "");
      onChange?.(next);
    },
    [onChange]
  );

  useEffect(() => {
    if (initialStatus) return;
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch(ENDPOINT);
        const payload: unknown = await response.json();
        if (cancelled) return;
        const data =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>).data
            : null;
        if (!response.ok || !isStatus(data)) {
          setError(readError(payload, "Could not load the AI key settings."));
          return;
        }
        setStatus(data);
        setProvider(data.provider ?? data.providers[0]?.id ?? "");
        setModel(data.model ?? data.providers[0]?.defaultModel ?? "");
      } catch {
        if (!cancelled) setError("Could not load the AI key settings.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [initialStatus]);

  function handleProviderChange(nextProvider: string): void {
    setProvider(nextProvider);
    // Swap in the new provider's default model unless the user typed their own.
    const previous = status?.providers.find((p) => p.id === provider);
    const next = status?.providers.find((p) => p.id === nextProvider);
    if (next && (!model || model === previous?.defaultModel)) {
      setModel(next.defaultModel);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey, model }),
      });
      const payload: unknown = await response.json();
      const data =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).data
          : null;

      if (!response.ok || !isStatus(data)) {
        setError(
          readError(payload, "The provider rejected that key. Check it again.")
        );
        return;
      }

      // The saved key is gone from the browser from here on.
      setApiKey("");
      applyStatus(data);
      setNotice("Key saved. Ask MyReply is on.");
    } catch {
      setError("Could not save the key. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(): Promise<void> {
    setError("");
    setNotice("");
    setRemoving(true);

    try {
      const response = await fetch(ENDPOINT, { method: "DELETE" });
      const payload: unknown = await response.json();
      const data =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>).data
          : null;

      if (!response.ok || !isStatus(data)) {
        setError(readError(payload, "Could not remove the key."));
        return;
      }

      setApiKey("");
      setConfirmRemove(false);
      applyStatus(data);
      setNotice("Key removed. Ask MyReply is off.");
    } catch {
      setError("Could not remove the key. Try again.");
    } finally {
      setRemoving(false);
    }
  }

  if (loading) {
    return (
      <section className={`panel rounded p-5 ${className}`}>
        <p className="text-sm text-muted">Loading AI key settings...</p>
      </section>
    );
  }

  if (!status) {
    return (
      <section className={`panel rounded p-5 ${className}`}>
        <p className="text-sm text-error">
          {error || "Could not load the AI key settings."}
        </p>
      </section>
    );
  }

  const selected = status.providers.find((p) => p.id === provider);
  const configuredProvider = status.providers.find(
    (p) => p.id === status.provider
  );

  return (
    <section className={`panel rounded p-5 space-y-4 ${className}`}>
      <header className="space-y-1">
        <h2 className="text-base font-medium text-foreground">AI provider key</h2>
        <p className="text-sm text-muted">
          Ask MyReply runs on your own provider key, so the usage is billed to
          your account and your data never passes through a shared key of ours.
        </p>
      </header>

      <div className="rounded border border-border bg-background p-3 text-sm">
        {status.configured ? (
          <div className="space-y-1">
            <p className="text-foreground">
              {configuredProvider?.label ?? status.provider} is connected.
            </p>
            <p className="font-mono text-xs text-muted">{status.keyHint}</p>
            <p className="text-xs text-muted">Model: {status.model}</p>
          </div>
        ) : (
          <p className="text-muted">
            No key yet. Ask MyReply stays off until one is added.
          </p>
        )}
      </div>

      {!status.canManage ? (
        <p className="text-sm text-muted">
          Only workspace owners and admins can change this key.
        </p>
      ) : (
        <form onSubmit={handleSave} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="ai-provider"
              className="block text-sm text-foreground"
            >
              Provider
            </label>
            <select
              id="ai-provider"
              value={provider}
              onChange={(event) => handleProviderChange(event.target.value)}
              className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              {status.providers.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="ai-key" className="block text-sm text-foreground">
              {status.configured ? "Replace key" : "API key"}
            </label>
            <input
              id="ai-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={selected?.keyPlaceholder ?? "Paste your key"}
              className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
            />
            <p className="text-xs text-muted">
              Stored encrypted and never shown again.{" "}
              {selected ? (
                <a
                  href={selected.consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Get a {selected.label} key
                </a>
              ) : null}
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="ai-model" className="block text-sm text-foreground">
              Model
            </label>
            <input
              id="ai-model"
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              spellCheck={false}
              placeholder={selected?.defaultModel ?? ""}
              className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
            />
            <p className="text-xs text-muted">
              Leave it on {selected?.defaultModel ?? "the default"} unless you
              have a reason to change it.
            </p>
          </div>

          {error ? <p className="text-sm text-error">{error}</p> : null}
          {notice ? <p className="text-sm text-muted">{notice}</p> : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={saving || !apiKey.trim() || !provider}
              className="rounded bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-50"
            >
              {saving ? "Checking key..." : "Save key"}
            </button>

            {status.configured && !confirmRemove ? (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                className="rounded border border-border px-4 py-2 text-sm text-muted hover:text-error"
              >
                Remove
              </button>
            ) : null}

            {status.configured && confirmRemove ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-muted">Remove this key?</span>
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={removing}
                  className="rounded border border-border px-3 py-1.5 text-sm text-error disabled:opacity-50"
                >
                  {removing ? "Removing..." : "Yes, remove"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmRemove(false)}
                  className="rounded px-2 py-1.5 text-sm text-muted"
                >
                  Cancel
                </button>
              </span>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
