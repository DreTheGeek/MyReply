"use client";

/**
 * Campaigns List Page
 *
 * Shows all campaigns as cards with toggle and delete.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { readCache, writeCache } from "@/lib/client-cache";
import {
  SURFACES,
  describeTrigger,
  summarizeTrigger,
} from "@/lib/campaigns/describe-trigger";

interface Campaign {
  id: string;
  name: string;
  goal: string | null;
  postId: string | null;
  postUrl: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  dmTriggerEnabled: boolean;
  storyReplyEnabled: boolean;
  storyMentionEnabled: boolean;
  liveCommentEnabled: boolean;
  defaultReplyEnabled: boolean;
  referralRef: string | null;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  publicReplyEnabled: boolean;
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
  requireFollow: boolean;
  followPromptMessage: string | null;
  followPromptButtonLabel: string | null;
  isActive: boolean;
  wholeWordMatch: boolean;
  instagramAccountId: string;
  instagramAccount: {
    username: string;
    instagramId: string;
  };
  reportShareSlug: string | null;
  reportShareEnabled: boolean;
  reportUrl: string | null;
  createdAt: string;
  _count: { dmLogs: number };
  trackedLinks: Array<{
    id: string;
    slug: string;
    label: string | null;
    destinationUrl: string;
    trackedUrl: string;
    _count: { clicks: number };
  }>;
  analytics: {
    sent: number;
    skipped: number;
    failed: number;
    clicks: number;
    ctr: number;
    topKeywords: { keyword: string; count: number }[];
  };
}

/**
 * What this campaign has actually done, in as few numbers as tell the story.
 *
 * The row used to print runs, CTR, sent, skipped, failed and clicks on every
 * campaign, which is six numbers to read before you know whether one of them
 * matters. Failures are the only one worth surfacing unprompted, so they show
 * only when there are some. The rest live on the campaign's own page.
 */
function describeResults(
  analytics: Campaign["analytics"],
  runs: number,
): string {
  if (runs === 0) return "No runs yet";
  const parts = [`${analytics.sent} sent`];
  if (analytics.clicks > 0) {
    parts.push(`${analytics.clicks} clicks`, `${analytics.ctr}% CTR`);
  }
  if (analytics.failed > 0) parts.push(`${analytics.failed} failed`);
  return parts.join(" \u00b7 ");
}

export default function CampaignsPage() {
  const router = useRouter();
  const [automations, setAutomations] = useState<Campaign[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [loading, setLoading] = useState(true);
  // Without this a failed fetch left the list empty and the page told a
  // workspace with twelve live campaigns that it had none, with a button to
  // create its first. That reads as data loss.
  const [loadError, setLoadError] = useState<string | null>(null);
  // postId -> current thumbnail URL, fetched live (Instagram URLs expire, so
  // they are never stored on the campaign).
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  // postId -> video URL for reels, so a campaign thumbnail can play on click.
  const [videos, setVideos] = useState<Record<string, string>>({});
  // The reel currently playing in the lightbox (null when closed).
  const [playingVideo, setPlayingVideo] = useState<{
    url: string;
    postUrl: string | null;
  } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">(
    "all",
  );

  const fetchAutomations = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedAccountId !== "all") {
        params.set("instagramAccountId", selectedAccountId);
      }
      const res = await fetch(
        `/api/automations${params.size ? `?${params}` : ""}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (data.success) {
        setAutomations(data.data);
        setLoadError(null);
      } else {
        setLoadError(
          data.error ?? "We could not load your campaigns just now."
        );
      }
    } catch (err) {
      console.error("Failed to fetch campaigns:", err);
      setLoadError("We could not reach the server. Check your connection.");
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) setAccounts(payload.data.instagramAccounts ?? []);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchAutomations();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchAutomations]);

  // Fetch fresh post thumbnails (and reel video URLs) for the accounts in view
  // and map them by postId. Cache-first so they show instantly on a return
  // visit. Instagram URLs expire, so they are never stored on the campaign.
  useEffect(() => {
    if (automations.length === 0) return;
    let cancelled = false;
    const accountIds = Array.from(
      new Set(automations.map((a) => a.instagramAccountId)),
    ).sort();
    const cacheKey = `ig-media:${accountIds.join(",")}`;

    const cached = readCache<{
      thumbs: Record<string, string>;
      videos: Record<string, string>;
    }>(cacheKey, 15 * 60 * 1000);
    // Hydrating state from cache is a legitimate effect use here.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (cached.data) {
      setThumbnails(cached.data.thumbs);
      setVideos(cached.data.videos);
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    Promise.all(
      accountIds.map((accountId) =>
        fetch(`/api/instagram/posts?instagramAccountId=${accountId}&limit=50`)
          .then((res) => res.json())
          .then((payload) =>
            payload.success
              ? (payload.data as {
                  id: string;
                  media_type?: string;
                  media_url?: string;
                  thumbnail_url?: string;
                }[])
              : [],
          )
          .catch(() => []),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const thumbs: Record<string, string> = {};
      const vids: Record<string, string> = {};
      for (const list of lists) {
        for (const media of list) {
          const url = media.thumbnail_url ?? media.media_url;
          if (url) thumbs[media.id] = url;
          if (media.media_type === "VIDEO" && media.media_url) {
            vids[media.id] = media.media_url;
          }
        }
      }
      setThumbnails(thumbs);
      setVideos(vids);
      writeCache(cacheKey, { thumbs, videos: vids });
    });

    return () => {
      cancelled = true;
    };
  }, [automations]);

  // Close the reel lightbox on Escape.
  useEffect(() => {
    if (!playingVideo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlayingVideo(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playingVideo]);

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
  }

  async function toggleActive(id: string, isActive: boolean) {
    try {
      await fetch(`/api/automations?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !isActive }),
      });
      setAutomations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, isActive: !isActive } : a)),
      );
    } catch (err) {
      console.error("Failed to toggle:", err);
    }
  }

  async function copyReelUrl(auto: Campaign) {
    setMenuOpenId(null);
    if (!auto.postUrl) return;
    try {
      await navigator.clipboard.writeText(auto.postUrl);
      setCopiedId(auto.id);
      window.setTimeout(
        () => setCopiedId((cur) => (cur === auto.id ? null : cur)),
        1500,
      );
    } catch (err) {
      console.error("Failed to copy reel URL:", err);
    }
  }

  async function deleteAutomation(id: string) {
    if (!confirm("Delete this campaign? This cannot be undone.")) return;
    try {
      await fetch(`/api/automations?id=${id}`, { method: "DELETE" });
      setAutomations((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error("Failed to delete:", err);
    }
  }

  async function duplicateAutomation(auto: Campaign) {
    setMenuOpenId(null);
    const specific = !auto.matchAnyPost && !auto.pendingNextReel;
    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${auto.name} copy`,
          instagramAccountId: auto.instagramAccountId,
          postId: specific ? auto.postId : null,
          postUrl: specific ? auto.postUrl : null,
          matchAnyPost: auto.matchAnyPost,
          pendingNextReel: auto.pendingNextReel,
          matchAnyWord: auto.matchAnyWord,
          keywords: auto.keywords,
          dmMessage: auto.dmMessage,
          openingDmEnabled: auto.openingDmEnabled,
          openingDmMessage: auto.openingDmMessage,
          openingDmButtonLabel: auto.openingDmButtonLabel,
          publicReplyEnabled: auto.publicReplyEnabled,
          publicReplyMessages: auto.publicReplyMessages,
          trackedDestinationUrl: auto.trackedLinks[0]?.destinationUrl ?? "",
          secondaryDestinationUrl: auto.trackedLinks[1]?.destinationUrl ?? "",
          secondaryButtonLabel: auto.trackedLinks[1]?.label ?? "Open link",
          requireFollow: auto.requireFollow,
          followPromptMessage: auto.followPromptMessage,
          followPromptButtonLabel: auto.followPromptButtonLabel,
          wholeWordMatch: auto.wholeWordMatch,
          isActive: false,
        }),
      });
      const data = await res.json();
      if (data.success) void fetchAutomations();
      else console.error("Duplicate failed:", data.error);
    } catch (err) {
      console.error("Failed to duplicate:", err);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="panel rounded p-6 h-36" />
        ))}
      </div>
    );
  }

  const query = search.trim().toLowerCase();
  const filtered = automations.filter((a) => {
    if (statusFilter === "active" && !a.isActive) return false;
    if (statusFilter === "paused" && a.isActive) return false;
    if (!query) return true;
    return (
      a.name.toLowerCase().includes(query) ||
      a.keywords.some((k) => k.toLowerCase().includes(query)) ||
      a.dmMessage.toLowerCase().includes(query) ||
      summarizeTrigger(a).toLowerCase().includes(query)
    );
  });

  // One flat list gave no way to see that two campaigns were competing for the
  // same comment, or that the only thing watching the inbox was switched off.
  // Grouping by the surface a campaign listens on fixes both, and the groups
  // are mutually exclusive so nothing appears twice.
  const groups = SURFACES.map((surface) => ({
    surface,
    campaigns: filtered.filter(
      (a) => describeTrigger(a).surface === surface.id,
    ),
  })).filter((group) => group.campaigns.length > 0);

  // Campaigns that report themselves as live but have nothing that can set them
  // off. This is the state that reads as working and is not.
  const stuck = filtered.filter(
    (a) => a.isActive && describeTrigger(a).warning !== null,
  );

  const showAccountPill = accounts.length > 1;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-muted">
            {filtered.length}
            {filtered.length !== automations.length
              ? ` of ${automations.length}`
              : ""}{" "}
            campaign{automations.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {accounts.length > 1 && (
            <AccountSelect
              accounts={accounts}
              value={selectedAccountId}
              onChange={handleAccountChange}
            />
          )}
          <Link
            href="/campaigns/import"
            className="flex-1 rounded border border-border px-4 py-2 text-center text-sm font-medium text-muted hover:text-foreground sm:flex-none"
          >
            Import
          </Link>
          <Link
            href="/campaigns/new"
            className="flex-1 rounded bg-accent px-4 py-2 text-center text-sm font-medium text-on-accent hover:bg-accent-hover sm:flex-none"
          >
            New Campaign
          </Link>
        </div>
      </div>

      {/* Campaigns that look live and are not */}
      {stuck.length > 0 && (
        <div className="rounded border border-warning/40 bg-warning/5 p-4 text-sm">
          <p className="font-medium text-warning">
            {stuck.length === 1
              ? "One campaign is switched on but nothing can set it off"
              : `${stuck.length} campaigns are switched on but nothing can set them off`}
          </p>
          <ul className="mt-2 space-y-1">
            {stuck.map((auto) => (
              <li key={auto.id}>
                <Link
                  href={`/campaigns/${auto.id}`}
                  className="text-muted underline decoration-warning/40 underline-offset-2 hover:text-foreground"
                >
                  {auto.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Search + status filter */}
      {automations.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns by name, keyword, or message"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
          />
          <div className="inline-flex shrink-0 rounded-lg bg-surface p-1">
            {(["all", "active", "paused"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${
                  statusFilter === s
                    ? "bg-background font-medium text-foreground ring-1 ring-accent/40"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The list could not be loaded. Never fall through to the empty
          state here: "no campaigns" and "we could not ask" are different
          facts and only one of them is the customer's problem. */}
      {loadError && (
        <div className="rounded border border-error/30 bg-error/5 p-4 text-sm">
          <p className="font-medium text-error">Could not load campaigns</p>
          <p className="mt-1 text-muted">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void fetchAutomations();
            }}
            className="mt-3 rounded border border-border px-3 py-1.5 text-sm text-muted hover:text-foreground"
          >
            Try again
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loadError && automations.length === 0 && (
        <div className="panel rounded p-8 text-center sm:p-12">
          <h3 className="mb-2 text-lg font-semibold">No campaigns yet</h3>
          <p className="mx-auto mb-6 max-w-sm text-sm text-muted">
            Create your first comment-to-DM campaign to turn a post or reel into
            a measurable conversation flow.
          </p>
          <Link
            href="/campaigns/new"
            className="inline-flex items-center gap-2 rounded bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
          >
            Create Campaign
          </Link>
        </div>
      )}

      {/* No matches for the current filter */}
      {!loadError && automations.length > 0 && filtered.length === 0 && (
        <div className="panel rounded p-8 text-center text-sm text-muted">
          No campaigns match your search.
        </div>
      )}

      {/* Campaigns, grouped by what sets them off */}
      <div className="space-y-8">
        {groups.map(({ surface, campaigns }) => (
          <section key={surface.id} className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold text-foreground">
                {surface.label}
              </h2>
              <span className="text-xs text-zinc-500">{campaigns.length}</span>
              <p className="w-full text-xs text-muted sm:w-auto">
                {surface.blurb}
              </p>
            </div>

            {campaigns.map((auto) => {
              const trigger = describeTrigger(auto);
              const videoUrl = auto.postId ? videos[auto.postId] : undefined;
              const thumb = auto.postId ? thumbnails[auto.postId] : undefined;

              return (
                <div
                  key={auto.id}
                  onClick={() => router.push(`/campaigns/${auto.id}`)}
                  className="panel cursor-pointer rounded p-4 transition-all hover:border-border-hover"
                >
                  <div className="flex items-start gap-3">
                    {trigger.showsPost &&
                      thumb &&
                      (videoUrl ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPlayingVideo({
                              url: videoUrl,
                              postUrl: auto.postUrl,
                            });
                          }}
                          aria-label="Play reel preview"
                          className="shrink-0"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={thumb}
                            alt="Campaign reel"
                            className="h-10 w-10 rounded border border-border object-cover hover:border-border-hover"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        </button>
                      ) : (
                        <a
                          href={auto.postUrl ?? "#"}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="shrink-0"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={thumb}
                            alt="Campaign post"
                            className="h-10 w-10 rounded border border-border object-cover"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        </a>
                      ))}

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-sm font-semibold">
                          {auto.name}
                        </h3>
                        {trigger.warning && (
                          <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                            Cannot fire
                          </span>
                        )}
                        {showAccountPill && (
                          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                            @{auto.instagramAccount.username}
                          </span>
                        )}
                      </div>

                      {/* One sentence, in place of a post chip, a keyword chip
                          row and three badges all saying the same thing. */}
                      <p className="mt-1 truncate text-sm text-muted">
                        {summarizeTrigger(auto)}
                      </p>

                      <p className="mt-2 text-xs text-zinc-500">
                        {describeResults(auto.analytics, auto._count.dmLogs)}
                      </p>
                    </div>

                    <div
                      className="ml-auto flex shrink-0 items-center gap-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => toggleActive(auto.id, auto.isActive)}
                        aria-label={
                          auto.isActive ? "Pause campaign" : "Start campaign"
                        }
                        aria-pressed={auto.isActive}
                        className={`relative h-6 w-11 rounded-full transition-colors ${
                          auto.isActive ? "bg-accent" : "bg-zinc-300"
                        }`}
                      >
                        <span
                          className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                            auto.isActive ? "left-6" : "left-1"
                          }`}
                        />
                      </button>

                      <div className="relative">
                        <button
                          onClick={() =>
                            setMenuOpenId((cur) =>
                              cur === auto.id ? null : auto.id,
                            )
                          }
                          aria-label="More actions"
                          className="rounded px-2 py-1 text-lg leading-none text-muted hover:text-foreground"
                        >
                          &#8943;
                        </button>
                        {menuOpenId === auto.id && (
                          <>
                            <div
                              className="fixed inset-0 z-10"
                              onClick={() => setMenuOpenId(null)}
                            />
                            <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-surface shadow-lg">
                              {auto.postUrl && (
                                <button
                                  onClick={() => void copyReelUrl(auto)}
                                  className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-surface-hover"
                                >
                                  {copiedId === auto.id
                                    ? "Copied"
                                    : "Copy post link"}
                                </button>
                              )}
                              <button
                                onClick={() => void duplicateAutomation(auto)}
                                className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-surface-hover"
                              >
                                Duplicate
                              </button>
                              <button
                                onClick={() => {
                                  setMenuOpenId(null);
                                  void deleteAutomation(auto.id);
                                }}
                                className="block w-full px-3 py-2 text-left text-sm text-error hover:bg-surface-hover"
                              >
                                Delete
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>

      {/* Reel lightbox */}
      {playingVideo && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setPlayingVideo(null)}
        >
          <div
            className="relative flex max-w-full flex-col items-end gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-4 text-sm">
              {playingVideo.postUrl && (
                <a
                  href={playingVideo.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-zinc-300 hover:text-white"
                >
                  Open on Instagram
                </a>
              )}
              <button
                type="button"
                onClick={() => setPlayingVideo(null)}
                className="text-zinc-300 hover:text-white"
              >
                Close
              </button>
            </div>
            <video
              src={playingVideo.url}
              controls
              autoPlay
              loop
              playsInline
              className="max-h-[80vh] max-w-full rounded-lg"
            />
          </div>
        </div>
      )}
    </div>
  );
}
