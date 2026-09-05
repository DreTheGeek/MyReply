"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { GallerySection } from "@/lib/templates/gallery";

export interface GalleryAccount {
  id: string;
  username: string;
}

export interface TemplateGalleryProps {
  sections: GallerySection[];
  accounts: GalleryAccount[];
  /** Owners and admins install; members read. Mirrors the API's own gate. */
  canManage: boolean;
  /**
   * A slug carried over from a public template page through sign in. The card
   * is highlighted and scrolled to, but nothing installs until it is tapped:
   * a link someone else sends must never create a campaign on its own.
   */
  pendingSlug: string | null;
}

interface InstallResponse {
  success: boolean;
  error?: string;
  data?: { redirectTo: string };
}

export default function TemplateGallery({
  sections,
  accounts,
  canManage,
  pendingSlug,
}: TemplateGalleryProps): React.JSX.Element {
  const router = useRouter();
  const [accountId, setAccountId] = useState<string>(accounts[0]?.id ?? "");
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<HTMLDivElement | null>(null);

  const hasAccount = accounts.length > 0;

  useEffect(() => {
    pendingRef.current?.scrollIntoView({ block: "center" });
  }, [pendingSlug]);

  async function install(slug: string): Promise<void> {
    setError(null);
    setBusySlug(slug);

    try {
      const res = await fetch(`/api/templates/${slug}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accountId ? { instagramAccountId: accountId } : {}),
      });
      const payload: InstallResponse = await res.json();

      if (!payload.success || !payload.data) {
        setError(payload.error ?? "Could not install this template");
        return;
      }

      router.push(payload.data.redirectTo);
    } catch {
      setError("Could not install this template");
    } finally {
      setBusySlug(null);
    }
  }

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold mb-2">Campaign templates</h2>
      <p className="text-xs text-muted mb-6">
        Each one is a finished campaign, not a starting point: the keywords, the
        DM and the public reply are already written. Pick the job you want done
        and it is built on your account in one tap. You can change every word
        afterwards.
      </p>

      {!hasAccount && (
        <div className="mb-6 rounded border border-border bg-surface/70 p-4">
          <p className="text-sm font-medium text-foreground">
            Connect Instagram first
          </p>
          <p className="mt-1 text-xs text-muted">
            A template needs an account to run on. Connect a professional
            account in settings and every template here becomes one tap.
          </p>
        </div>
      )}

      {hasAccount && accounts.length > 1 && (
        <div className="mb-6">
          <label
            htmlFor="template-account"
            className="mb-1.5 block text-xs font-medium text-muted"
          >
            Install on
          </label>
          <select
            id="template-account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="w-full max-w-xs rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                @{account.username}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <p className="mb-4 text-sm text-error">{error}</p>}

      <div className="space-y-8">
        {sections.map((section) => (
          <div key={section.id}>
            <h3 className="text-sm font-semibold text-foreground">
              {section.label}
            </h3>
            <p className="mt-1 text-xs text-muted">{section.description}</p>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {section.templates.map((template) => {
                const isPending = template.slug === pendingSlug;
                const busy = busySlug === template.slug;

                return (
                  <div
                    key={template.slug}
                    ref={isPending ? pendingRef : undefined}
                    className={`flex flex-col rounded border bg-surface/70 p-4 ${
                      isPending ? "border-accent/40" : "border-border"
                    }`}
                  >
                    <p className="text-sm font-semibold text-foreground">
                      {template.name}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {template.description}
                    </p>

                    <dl className="mt-3 space-y-1.5">
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-xs text-muted">Fires on</dt>
                        <dd className="text-xs font-medium text-foreground">
                          {template.triggerLabel}
                        </dd>
                      </div>
                      <div className="flex gap-2">
                        <dt className="shrink-0 text-xs text-muted">Keywords</dt>
                        <dd className="font-mono text-xs text-foreground">
                          {template.keywordLabel}
                        </dd>
                      </div>
                    </dl>

                    <p className="mt-3 rounded border border-border bg-background p-3 text-xs leading-relaxed text-muted">
                      {template.dmMessage}
                    </p>

                    {template.needsLink && (
                      <p className="mt-2 text-xs text-muted">
                        Add your link on the campaign and switch it on. It
                        installs paused so it cannot promise a button that is
                        not there yet.
                      </p>
                    )}

                    <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => void install(template.slug)}
                          disabled={busy || !hasAccount}
                          className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                        >
                          {busy
                            ? "Building..."
                            : isPending
                              ? "Finish installing"
                              : "Use this"}
                        </button>
                      ) : (
                        <p className="text-xs text-muted">
                          Only owners and admins can install a template.
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
