"use client";

/**
 * Contacts Page
 *
 * Everyone the workspace has seen, with the tags applied to them. Filterable by
 * connected account, tag, and handle. Paginated by cursor, so the list appends
 * rather than jumping between pages.
 */

import { useCallback, useEffect, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import ContactTagChip from "@/components/contact-tag-chip";
import type { ContactListItem, ContactsResponse } from "@/app/api/contacts/route";
import type { TagListItem } from "@/app/api/tags/route";

const PAGE_SIZE = 25;

// The shared envelope every dashboard route returns.
type ApiPayload<T> =
  | { success: true; data: T }
  | { success: false; error?: string };

function formatLastSeen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<ContactListItem[]>([]);
  const [tags, setTags] = useState<TagListItem[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtersActive =
    selectedAccountId !== "all" || tagFilter !== "all" || search !== "";

  const fetchContacts = useCallback(
    async (cursor: string | null) => {
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (selectedAccountId !== "all") {
          params.set("instagramAccountId", selectedAccountId);
        }
        if (tagFilter !== "all") params.set("tagId", tagFilter);
        if (search) params.set("search", search);
        if (cursor) params.set("cursor", cursor);

        const res = await fetch(`/api/contacts?${params}`);
        const payload = (await res.json()) as ApiPayload<ContactsResponse>;
        if (!payload.success) {
          setError(payload.error ?? "Failed to load contacts");
          return;
        }

        const { contacts: rows, pagination } = payload.data;
        setError(null);
        setContacts((current) => (cursor ? [...current, ...rows] : rows));
        setNextCursor(pagination.nextCursor);
      } catch {
        setError("Failed to load contacts");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [selectedAccountId, tagFilter, search]
  );

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json() as Promise<ApiPayload<{ instagramAccounts?: AccountOption[] }>>)
      .then((payload) => {
        if (payload.success) setAccounts(payload.data.instagramAccounts ?? []);
      })
      .catch(console.error);

    fetch("/api/tags")
      .then((res) => res.json() as Promise<ApiPayload<{ tags?: TagListItem[] }>>)
      .then((payload) => {
        if (payload.success) setTags(payload.data.tags ?? []);
      })
      .catch(console.error);
  }, []);

  // Typing a handle should not fire a request per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchContacts(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchContacts]);

  function handleSearchChange(value: string) {
    setLoading(true);
    setSearchInput(value);
  }

  function handleTagChange(value: string) {
    setLoading(true);
    setTagFilter(value);
  }

  function handleAccountChange(value: string) {
    setLoading(true);
    setSelectedAccountId(value);
  }

  function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    void fetchContacts(nextCursor);
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">
            Search
          </span>
          <input
            value={searchInput}
            onChange={(event) => handleSearchChange(event.target.value)}
            placeholder="Handle contains..."
            className="min-w-52 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
          />
        </label>

        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-2 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">
              Tag
            </span>
            <select
              value={tagFilter}
              onChange={(event) => handleTagChange(event.target.value)}
              className="min-w-52 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
            >
              <option value="all">All tags</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name} ({tag.contactCount})
                </option>
              ))}
            </select>
          </label>

          {accounts.length > 1 && (
            <AccountSelect
              accounts={accounts}
              value={selectedAccountId}
              onChange={handleAccountChange}
            />
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-border bg-surface px-4 py-3 text-sm text-muted">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="panel rounded overflow-hidden">
        {/* Tags and timestamps do not compress onto a phone, so the table keeps
            its width and scrolls inside the panel. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">Contact</th>
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">Tags</th>
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">DMs sent</th>
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading && (
                <>
                  {[...Array(5)].map((_, i) => (
                    <tr key={i}>
                      <td colSpan={4} className="px-4 py-4 sm:px-6">
                        <div className="h-4 bg-surface-hover rounded" />
                      </td>
                    </tr>
                  ))}
                </>
              )}
              {!loading && contacts.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center sm:px-6">
                    {filtersActive ? (
                      <p className="text-muted">
                        No contacts match these filters. Clear the search or pick
                        a different tag.
                      </p>
                    ) : (
                      <div className="space-y-1">
                        <p className="text-foreground font-medium">
                          No contacts yet
                        </p>
                        <p className="text-muted">
                          Contacts appear here once someone comments on a post or
                          messages a connected account.
                        </p>
                      </div>
                    )}
                  </td>
                </tr>
              )}
              {!loading &&
                contacts.map((contact) => (
                  <tr
                    key={contact.id}
                    className="hover:bg-surface-hover/50 transition-colors"
                  >
                    <td className="px-4 py-4 sm:px-6">
                      <span className="font-medium text-foreground">
                        @{contact.username ?? contact.externalId.slice(0, 8)}
                      </span>
                      <span className="block text-xs text-muted">
                        @{contact.instagramAccount.username}
                      </span>
                    </td>
                    <td className="px-4 py-4 sm:px-6">
                      {contact.tags.length === 0 ? (
                        <span className="text-muted">No tags</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {contact.tags.map((tag) => (
                            <ContactTagChip
                              key={tag.id}
                              name={tag.name}
                              color={tag.color}
                            />
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-4 text-muted sm:px-6">
                      {contact.dmCount}
                    </td>
                    <td className="px-4 py-4 text-muted whitespace-nowrap sm:px-6">
                      {formatLastSeen(contact.lastSeenAt)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {!loading && nextCursor && (
          <div className="flex items-center justify-center px-4 py-4 border-t border-border sm:px-6">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-border hover:text-foreground hover:border-border-hover transition-all disabled:opacity-30 disabled:pointer-events-none"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
