"use client";

/**
 * Persistent Menu Section
 *
 * The persistent menu is the menu Instagram shows inside a DM thread with the
 * account. It is how a business answers its most common questions without an
 * AI guessing: every item is a button the person taps, and a payload item hands
 * that payload to the same automation plumbing an opening DM button uses.
 *
 * Account-level, not per-campaign, and every save replaces the whole menu, so
 * this editor always sends the full list. Two Instagram behaviours worth
 * knowing before editing: the menu does not update inside conversations that
 * are already open, and it cannot vary per person.
 */

import { useEffect, useState } from "react";

export interface PersistentMenuAccountOption {
  id: string;
  username: string;
}

export interface PersistentMenuSectionProps {
  /** The workspace's connected Instagram accounts. */
  accounts: PersistentMenuAccountOption[];
  /** Null while the caller is still loading the membership. */
  currentUserRole: "OWNER" | "ADMIN" | "MEMBER" | null;
  /** Extra classes on the outer section. */
  className?: string;
}

const ENDPOINT = "/api/instagram/persistent-menu";

// Meta's recommended ceiling, mirrored by the API route.
const MAX_MENU_ITEMS = 5;
const MAX_MENU_ITEM_TITLE = 30;
const MAX_MENU_ITEM_PAYLOAD = 1000;

type MenuItemType = "postback" | "web_url";

/**
 * One editable row. The id is local to this editor: Meta stores the menu
 * positionally, so rows need a stable key of our own to keep inputs from
 * remounting when a row above them is removed.
 */
interface MenuRow {
  id: string;
  title: string;
  type: MenuItemType;
  /** The payload for a postback row, the link for a web_url row. */
  target: string;
}

let menuRowCounter = 0;

function newMenuRow(
  title = "",
  type: MenuItemType = "postback",
  target = ""
): MenuRow {
  menuRowCounter += 1;
  return { id: `menu_${menuRowCounter}`, title, type, target };
}

interface ApiMenuItem {
  type: MenuItemType;
  title: string;
  payload?: string;
  url?: string;
}

function toRow(item: ApiMenuItem): MenuRow {
  return item.type === "web_url"
    ? newMenuRow(item.title, "web_url", item.url ?? "")
    : newMenuRow(item.title, "postback", item.payload ?? "");
}

function toApiItem(row: MenuRow): ApiMenuItem {
  return row.type === "web_url"
    ? { type: "web_url", title: row.title, url: row.target }
    : { type: "postback", title: row.title, payload: row.target };
}

export default function PersistentMenuSection({
  accounts,
  currentUserRole,
  className = "",
}: PersistentMenuSectionProps): React.JSX.Element {
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
    null
  );
  const [rows, setRows] = useState<MenuRow[]>([]);
  const [readable, setReadable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Derived rather than synced, because the caller's account list can arrive
  // after the first render and a state copy of it would need an effect to keep
  // in step.
  const menuAccountId = selectedAccountId ?? accounts[0]?.id ?? null;

  // The menu lives on the Instagram profile, not in our database, so it is
  // loaded per account rather than coming down with the dashboard stats.
  useEffect(() => {
    if (!menuAccountId) return;

    let cancelled = false;

    fetch(`${ENDPOINT}?instagramAccountId=${encodeURIComponent(menuAccountId)}`)
      .then((res) => res.json())
      .then((payload) => {
        if (cancelled) return;
        setNotice(null);
        if (!payload.success) {
          setError(payload.error ?? "Could not load the persistent menu");
          return;
        }
        setError(null);
        setRows(
          (payload.data.items as ApiMenuItem[])
            .slice(0, MAX_MENU_ITEMS)
            .map(toRow)
        );
        setReadable(Boolean(payload.data.readable));
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the persistent menu");
      });

    return () => {
      cancelled = true;
    };
  }, [menuAccountId]);

  function updateRow(
    id: string,
    field: "title" | "type" | "target",
    value: string
  ): void {
    setRows((current) =>
      current.map((row) =>
        row.id === id
          ? {
              ...row,
              [field]: field === "type" ? (value as MenuItemType) : value,
            }
          : row
      )
    );
  }

  async function saveMenu(): Promise<void> {
    if (!menuAccountId) return;

    const cleaned = rows
      .map((row) => ({ ...row, title: row.title.trim(), target: row.target.trim() }))
      .filter((row) => row.title.length > 0 || row.target.length > 0);

    if (cleaned.length === 0) {
      setError("Add at least one item, or clear the menu.");
      return;
    }
    if (cleaned.some((row) => !row.title || !row.target)) {
      setError("Every item needs a label and either a link or a payload.");
      return;
    }

    setError(null);
    setNotice(null);
    setBusy("menu:save");

    // setBusy(null) as the last statement rather than a finally meant a
    // network rejection skipped it and left the button stuck on "Saving..."
    // until a reload, with no message.
    try {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: menuAccountId,
          items: cleaned.map(toApiItem),
        }),
      });
      const payload = await res.json();

      if (payload.success) {
        setRows(
          cleaned.map((row) => newMenuRow(row.title, row.type, row.target))
        );
        setReadable(true);
        setNotice(
          "Saved. New conversations show the menu; threads already open keep the old one."
        );
      } else {
        setError(payload.error ?? "Could not save the persistent menu");
      }
    } catch {
      setError("We could not reach the server. Nothing was saved.");
    } finally {
      setBusy(null);
    }
  }

  async function clearMenu(): Promise<void> {
    if (!menuAccountId) return;
    if (
      !confirm("Remove the persistent menu? DM threads will show no menu at all.")
    ) {
      return;
    }

    setError(null);
    setNotice(null);
    setBusy("menu:clear");

    try {
      const res = await fetch(ENDPOINT, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instagramAccountId: menuAccountId }),
      });
      const payload = await res.json();

      if (payload.success) {
        setRows([]);
        setNotice("Cleared. DM threads show no menu.");
      } else {
        setError(payload.error ?? "Could not clear the persistent menu");
      }
    } catch {
      setError("We could not reach the server. Nothing was cleared.");
    } finally {
      setBusy(null);
    }
  }

  // The API applies the same owner-or-admin gate, so the editor is read-only
  // for members rather than failing on save.
  const canManage =
    currentUserRole === "OWNER" || currentUserRole === "ADMIN";

  return (
    <section className={`panel rounded p-4 sm:p-6 ${className}`}>
      <h2 className="text-base font-semibold mb-2">Persistent menu</h2>
      <p className="text-xs text-muted mb-6">
        The menu Instagram shows inside a DM thread with you. Meta recommends at
        most {MAX_MENU_ITEMS} items, and saving replaces the whole menu. A
        payload item hands its payload to your automations on tap, exactly like
        a conversation starter; a link item opens an https link instead. The
        menu does not change inside conversations that are already open, and it
        is the same for everyone.
      </p>

      {accounts.length === 0 ? (
        <p className="text-sm text-muted">
          Connect an Instagram professional account to set a persistent menu.
        </p>
      ) : (
        <div className="space-y-4">
          {accounts.length > 1 && (
            <div>
              <label
                htmlFor="menu-account"
                className="mb-1.5 block text-xs font-medium text-muted"
              >
                Account
              </label>
              <select
                id="menu-account"
                value={menuAccountId ?? ""}
                onChange={(event) => setSelectedAccountId(event.target.value)}
                className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40"
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    @{account.username}
                  </option>
                ))}
              </select>
            </div>
          )}

          {!readable && (
            <p className="rounded border border-border bg-surface/70 p-3 text-xs text-muted">
              Instagram does not report the menu already live on this account, so
              this list starts empty. Saving still replaces whatever is there.
            </p>
          )}

          {rows.length === 0 && (
            <p className="text-sm text-muted">No menu items set up yet.</p>
          )}

          {rows.map((row, index) => (
            <div
              key={row.id}
              className="space-y-3 rounded border border-border bg-surface/70 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-semibold text-muted">
                  Item {index + 1}
                </span>
                {canManage && (
                  <button
                    type="button"
                    onClick={() =>
                      setRows((current) =>
                        current.filter((existing) => existing.id !== row.id)
                      )
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
                  >
                    Remove
                  </button>
                )}
              </div>

              <div>
                <input
                  type="text"
                  value={row.title}
                  onChange={(event) =>
                    updateRow(row.id, "title", event.target.value)
                  }
                  disabled={!canManage}
                  maxLength={MAX_MENU_ITEM_TITLE}
                  placeholder="Pricing"
                  className="w-full rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-muted">
                  What the person taps. {row.title.length} of{" "}
                  {MAX_MENU_ITEM_TITLE} characters.
                </p>
              </div>

              <div>
                <select
                  value={row.type}
                  onChange={(event) =>
                    updateRow(row.id, "type", event.target.value)
                  }
                  disabled={!canManage}
                  className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40 disabled:opacity-50"
                >
                  <option value="postback">Send a payload to automations</option>
                  <option value="web_url">Open a link</option>
                </select>
              </div>

              <div>
                <input
                  type="text"
                  value={row.target}
                  onChange={(event) =>
                    updateRow(row.id, "target", event.target.value)
                  }
                  disabled={!canManage}
                  maxLength={
                    row.type === "web_url" ? 1000 : MAX_MENU_ITEM_PAYLOAD
                  }
                  placeholder={
                    row.type === "web_url"
                      ? "https://example.com/pricing"
                      : "PRICING"
                  }
                  className="w-full rounded border border-border bg-surface px-4 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent/40 disabled:opacity-50"
                />
                <p className="mt-1 text-xs text-muted">
                  {row.type === "web_url"
                    ? "The https link Instagram opens on tap."
                    : "Payload sent back to your automations on tap."}
                </p>
              </div>
            </div>
          ))}

          {canManage ? (
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => setRows((current) => [...current, newMenuRow()])}
                disabled={rows.length >= MAX_MENU_ITEMS}
                className="rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground disabled:opacity-50"
              >
                {rows.length >= MAX_MENU_ITEMS
                  ? `${MAX_MENU_ITEMS} is the recommended limit`
                  : "Add item"}
              </button>
              <button
                type="button"
                onClick={saveMenu}
                disabled={busy === "menu:save"}
                className="rounded bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {busy === "menu:save" ? "Saving..." : "Save menu"}
              </button>
              <button
                type="button"
                onClick={clearMenu}
                disabled={busy === "menu:clear"}
                className="rounded border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground disabled:opacity-50"
              >
                {busy === "menu:clear" ? "Clearing..." : "Clear menu"}
              </button>
            </div>
          ) : (
            <p className="border-t border-border pt-4 text-xs text-muted">
              Only owners and admins can change the persistent menu.
            </p>
          )}

          {error && <p className="text-sm text-error">{error}</p>}
          {notice && <p className="text-sm text-muted">{notice}</p>}
        </div>
      )}
    </section>
  );
}
