"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type WorkspaceRoleName = "OWNER" | "ADMIN" | "MEMBER";

type SourceKind = "WEBSITE" | "DOCUMENT" | "MANUAL";
type SourceStatus = "PENDING" | "READY" | "FAILED";

/** One row as GET /api/knowledge reports it. */
interface KnowledgeSourceRow {
  id: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  crawlDepth: number;
  status: SourceStatus;
  errorMessage: string | null;
  lastSyncedAt: string | null;
  syncEveryHours: number | null;
  createdAt: string;
  chunkCount: number;
}

export interface KnowledgeSectionProps {
  /**
   * The signed-in user's role in this workspace, or null while it is still
   * loading. Owners and admins can add, re-sync and remove; members read only,
   * which mirrors the gate the API itself applies.
   */
  currentUserRole: WorkspaceRoleName | null;
}

type Tab = "website" | "file" | "qa";

const DEPTH_OPTIONS: Array<{ value: number; label: string; hint: string }> = [
  { value: 1, label: "This page only", hint: "Reads the one address you gave" },
  { value: 2, label: "One level deep", hint: "Plus every page it links to" },
  { value: 3, label: "Two levels deep", hint: "Best for a full small site" },
];

const REFRESH_OPTIONS: Array<{ label: string; hours: number | null }> = [
  { label: "Never", hours: null },
  { label: "Daily", hours: 24 },
  { label: "Weekly", hours: 168 },
  { label: "Monthly", hours: 720 },
];

const ACCEPTED_FILES = ".pdf,.docx,.txt,.md,.csv";

const KIND_LABELS: Record<SourceKind, string> = {
  WEBSITE: "Website",
  DOCUMENT: "File",
  MANUAL: "Q and A",
};

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function statusOf(source: KnowledgeSourceRow): {
  label: string;
  className: string;
} {
  if (source.status === "FAILED") {
    return { label: "Failed", className: "border-error/30 text-error" };
  }
  if (source.status === "PENDING") {
    return { label: "Reading...", className: "border-border text-muted" };
  }
  return { label: "Ready", className: "border-accent/40 text-accent" };
}

export default function KnowledgeSection({
  currentUserRole,
}: KnowledgeSectionProps): React.JSX.Element {
  const [sources, setSources] = useState<KnowledgeSourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("website");

  const [url, setUrl] = useState("");
  const [crawlDepth, setCrawlDepth] = useState(2);
  const [refreshHours, setRefreshHours] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canManage = currentUserRole === "OWNER" || currentUserRole === "ADMIN";

  const load = useCallback(async (): Promise<KnowledgeSourceRow[] | null> => {
    try {
      const res = await fetch("/api/knowledge");
      const payload: {
        success: boolean;
        data?: { sources: KnowledgeSourceRow[] };
      } = await res.json();

      if (!payload.success || !payload.data) return null;
      return payload.data.sources;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void load().then((rows) => {
      if (cancelled) return;
      if (!rows) setError("Could not load your knowledge sources");
      else setSources(rows);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [load]);

  // Ingest runs after the response is sent, so a row that says "Reading..."
  // will change on its own. Poll only while at least one is in flight, and
  // stop as soon as the last one settles, so an idle panel makes no requests.
  const pendingCount = sources.filter(
    (source) => source.status === "PENDING"
  ).length;

  useEffect(() => {
    if (pendingCount === 0) return;

    let cancelled = false;
    const timer = setInterval(() => {
      void load().then((rows) => {
        if (!cancelled && rows) setSources(rows);
      });
    }, 5_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingCount, load]);

  function resetForm(): void {
    setUrl("");
    setCrawlDepth(2);
    setRefreshHours(null);
    setQuestion("");
    setAnswer("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function afterCreate(res: Response): Promise<boolean> {
    const payload: { success: boolean; error?: string } = await res
      .json()
      .catch(() => ({ success: false }));

    if (!payload.success) {
      setError(payload.error ?? "Could not add that source");
      return false;
    }

    const rows = await load();
    if (rows) setSources(rows);
    resetForm();
    setFormOpen(false);
    return true;
  }

  async function addWebsite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy("create");

    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "WEBSITE",
          url: url.trim(),
          crawlDepth,
          syncEveryHours: refreshHours,
        }),
      });
      await afterCreate(res);
    } catch {
      setError("Could not add that website");
    } finally {
      setBusy(null);
    }
  }

  async function addFile(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setError("Choose a file first");
      return;
    }

    setError(null);
    setBusy("create");

    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/knowledge", { method: "POST", body: form });
      await afterCreate(res);
    } catch {
      setError("Could not upload that file");
    } finally {
      setBusy(null);
    }
  }

  async function addPair(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy("create");

    try {
      const res = await fetch("/api/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "MANUAL",
          question: question.trim(),
          answer: answer.trim(),
        }),
      });
      await afterCreate(res);
    } catch {
      setError("Could not save that answer");
    } finally {
      setBusy(null);
    }
  }

  async function resync(source: KnowledgeSourceRow): Promise<void> {
    setError(null);
    setBusy(`resync:${source.id}`);

    try {
      const res = await fetch(`/api/knowledge/${source.id}/resync`, {
        method: "POST",
      });
      const payload: { success: boolean; error?: string } = await res.json();

      if (!payload.success) {
        setError(payload.error ?? "Could not re-sync that source");
        return;
      }

      setSources((existing) =>
        existing.map((row) =>
          row.id === source.id
            ? { ...row, status: "PENDING", errorMessage: null }
            : row
        )
      );
    } catch {
      setError("Could not re-sync that source");
    } finally {
      setBusy(null);
    }
  }

  async function remove(source: KnowledgeSourceRow): Promise<void> {
    if (
      !confirm(
        `Remove "${source.title}"? Its ${source.chunkCount} passages are deleted and the assistant stops answering from it. This cannot be undone.`
      )
    ) {
      return;
    }

    setError(null);
    setBusy(`delete:${source.id}`);

    try {
      const res = await fetch("/api/knowledge", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: source.id }),
      });
      const payload: { success: boolean; error?: string } = await res.json();

      if (!payload.success) {
        setError(payload.error ?? "Could not remove that source");
        return;
      }

      setSources((existing) => existing.filter((row) => row.id !== source.id));
    } catch {
      setError("Could not remove that source");
    } finally {
      setBusy(null);
    }
  }

  const tabButtonClass = (value: Tab): string =>
    `rounded px-3 py-1.5 text-xs font-medium transition-colors ${
      tab === value
        ? "bg-accent text-on-accent"
        : "border border-border text-muted hover:border-border-hover hover:text-foreground"
    }`;

  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold mb-2">Knowledge base</h2>
      <p className="text-xs text-muted mb-6">
        What the assistant is allowed to answer from. Point it at your site and
        it reads every page it can reach, up to two levels deep and 100 pages.
        Upload a PDF, Word document, spreadsheet or text file and it reads that
        too. Every answer can cite the page or file it came from.
      </p>

      {loading ? (
        <div className="h-24 rounded border border-border bg-surface/70" />
      ) : (
        <div className="space-y-4">
          {sources.length === 0 ? (
            <div className="rounded border border-border bg-surface/70 p-4">
              <p className="text-sm font-medium text-foreground">
                No sources yet
              </p>
              <p className="mt-1 text-xs text-muted">
                Until you add one, the assistant answers from your campaign
                templates alone. Start with your website: one address, and it
                walks the links itself.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Source
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Kind
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Passages
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Last synced
                    </th>
                    <th className="pb-2 pr-3 text-xs font-semibold text-muted">
                      Status
                    </th>
                    {canManage && <th className="pb-2" />}
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => {
                    const status = statusOf(source);
                    return (
                      <tr
                        key={source.id}
                        className="border-b border-border last:border-0 align-top"
                      >
                        <td className="py-3 pr-3">
                          <span className="font-medium text-foreground">
                            {source.title}
                          </span>
                          {source.url && (
                            <span className="mt-0.5 block break-all font-mono text-xs text-muted">
                              {source.url}
                            </span>
                          )}
                          {source.status === "FAILED" && source.errorMessage && (
                            <span className="mt-1 block text-xs text-error">
                              {source.errorMessage}
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-xs text-muted">
                          {KIND_LABELS[source.kind]}
                          {source.kind === "WEBSITE" && (
                            <span className="block">
                              depth {source.crawlDepth}
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-3 text-xs text-muted">
                          {source.chunkCount}
                        </td>
                        <td className="py-3 pr-3 text-xs text-muted">
                          {formatDate(source.lastSyncedAt)}
                        </td>
                        <td className="py-3 pr-3">
                          <span
                            className={`rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}
                          >
                            {status.label}
                          </span>
                        </td>
                        {canManage && (
                          <td className="py-3 text-right whitespace-nowrap">
                            {source.kind === "WEBSITE" && (
                              <button
                                type="button"
                                onClick={() => void resync(source)}
                                disabled={busy === `resync:${source.id}`}
                                className="mr-2 rounded border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground disabled:opacity-50"
                              >
                                {busy === `resync:${source.id}`
                                  ? "Starting..."
                                  : "Re-sync"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void remove(source)}
                              disabled={busy === `delete:${source.id}`}
                              className="rounded border border-error/20 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:border-error/40 hover:bg-error/10 disabled:opacity-50"
                            >
                              {busy === `delete:${source.id}`
                                ? "Removing..."
                                : "Remove"}
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {canManage ? (
            formOpen ? (
              <div className="space-y-3 rounded border border-border bg-surface/70 p-4">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setTab("website")}
                    className={tabButtonClass("website")}
                  >
                    Website
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("file")}
                    className={tabButtonClass("file")}
                  >
                    File
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("qa")}
                    className={tabButtonClass("qa")}
                  >
                    Question and answer
                  </button>
                </div>

                {tab === "website" && (
                  <form onSubmit={addWebsite} className="space-y-3">
                    <div>
                      <label
                        htmlFor="knowledge-url"
                        className="mb-1.5 block text-xs font-medium text-muted"
                      >
                        Address
                      </label>
                      <input
                        id="knowledge-url"
                        type="url"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        required
                        placeholder="https://example.com"
                        className="w-full rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                      />
                      <p className="mt-1 text-xs text-muted">
                        Only pages on this same site are read, and robots.txt is
                        honoured.
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label
                          htmlFor="knowledge-depth"
                          className="mb-1.5 block text-xs font-medium text-muted"
                        >
                          How deep
                        </label>
                        <select
                          id="knowledge-depth"
                          value={String(crawlDepth)}
                          onChange={(event) =>
                            setCrawlDepth(Number(event.target.value))
                          }
                          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                        >
                          {DEPTH_OPTIONS.map((option) => (
                            <option
                              key={option.value}
                              value={String(option.value)}
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-muted">
                          {
                            DEPTH_OPTIONS.find(
                              (option) => option.value === crawlDepth
                            )?.hint
                          }
                        </p>
                      </div>

                      <div>
                        <label
                          htmlFor="knowledge-refresh"
                          className="mb-1.5 block text-xs font-medium text-muted"
                        >
                          Re-read automatically
                        </label>
                        <select
                          id="knowledge-refresh"
                          value={refreshHours === null ? "" : String(refreshHours)}
                          onChange={(event) =>
                            setRefreshHours(
                              event.target.value === ""
                                ? null
                                : Number(event.target.value)
                            )
                          }
                          className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                        >
                          {REFRESH_OPTIONS.map((option) => (
                            <option
                              key={option.label}
                              value={
                                option.hours === null ? "" : String(option.hours)
                              }
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-muted">
                          Keeps prices and hours current without you re-adding
                          the site.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                      <button
                        type="submit"
                        disabled={busy === "create"}
                        className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                      >
                        {busy === "create" ? "Adding..." : "Add website"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormOpen(false)}
                        className="rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {tab === "file" && (
                  <form onSubmit={addFile} className="space-y-3">
                    <div>
                      <label
                        htmlFor="knowledge-file"
                        className="mb-1.5 block text-xs font-medium text-muted"
                      >
                        File
                      </label>
                      <input
                        id="knowledge-file"
                        ref={fileInputRef}
                        type="file"
                        accept={ACCEPTED_FILES}
                        required
                        className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors file:mr-3 file:rounded file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-on-accent focus:border-accent/40"
                      />
                      <p className="mt-1 text-xs text-muted">
                        PDF, Word (.docx), spreadsheet (.csv), Markdown or plain
                        text, up to 15 MB. A scanned PDF with no selectable text
                        needs OCR first.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                      <button
                        type="submit"
                        disabled={busy === "create"}
                        className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                      >
                        {busy === "create" ? "Uploading..." : "Upload file"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormOpen(false)}
                        className="rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {tab === "qa" && (
                  <form onSubmit={addPair} className="space-y-3">
                    <div>
                      <label
                        htmlFor="knowledge-question"
                        className="mb-1.5 block text-xs font-medium text-muted"
                      >
                        Question
                      </label>
                      <input
                        id="knowledge-question"
                        type="text"
                        value={question}
                        onChange={(event) => setQuestion(event.target.value)}
                        maxLength={500}
                        required
                        placeholder="Do you ship outside the US?"
                        className="w-full rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="knowledge-answer"
                        className="mb-1.5 block text-xs font-medium text-muted"
                      >
                        Answer
                      </label>
                      <textarea
                        id="knowledge-answer"
                        value={answer}
                        onChange={(event) => setAnswer(event.target.value)}
                        maxLength={10000}
                        required
                        rows={4}
                        placeholder="Yes. Canada and the UK ship in 5 to 7 days, everywhere else 10 to 14."
                        className="w-full rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
                      />
                      <p className="mt-1 text-xs text-muted">
                        Kept together as one passage, so the answer is never
                        separated from its question.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                      <button
                        type="submit"
                        disabled={busy === "create"}
                        className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
                      >
                        {busy === "create" ? "Saving..." : "Save answer"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormOpen(false)}
                        className="rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>
            ) : (
              <div className="border-t border-border pt-4">
                <button
                  type="button"
                  onClick={() => setFormOpen(true)}
                  className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
                >
                  Add a source
                </button>
              </div>
            )
          ) : (
            <p className="border-t border-border pt-4 text-xs text-muted">
              Only owners and admins can add or remove knowledge sources.
            </p>
          )}

          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      )}
    </section>
  );
}
