# API and MCP

Two ways for a program to drive MyReply: an MCP server so an AI agent can
create and manage campaigns on your behalf, and a REST API for your own code.

Everything is scoped to one workspace. Neither surface accepts a workspace id
as an argument, so a credential can never reach another tenant's data.

## Connect an AI agent, no keys

Paste this URL into any MCP client that supports OAuth and click Connect:

```
https://your-domain/api/mcp
```

In Claude Code that is one line, then one command:

```bash
claude mcp add --transport http myreply https://your-domain/api/mcp
```

```
/mcp
```

Pick `myreply`, choose Authenticate, and a browser opens. In Claude on the web
or the desktop app it is Settings, Connectors, Add custom connector, and the
same URL. ChatGPT is Settings, Connectors, and the same URL again.

You sign in to MyReply with your usual email link, pick which workspace the
connection is for, and approve. There is no key to copy, store or rotate.

What you are approving is spelled out on that screen: which app is asking,
which host it sends you back to, which workspace it gets, and in plain words
what it will be able to do. Two permissions exist:

| Scope | What it allows |
| --- | --- |
| `mcp:read` | See connected accounts, campaigns, DM logs and click numbers. |
| `mcp:write` | Create and change campaigns, edit their message, pause and resume them. |

Your own role still applies on top. If you are a member rather than an admin of
the workspace you pick, the connection stays read only whatever the app asked
for. A scope can only ever take access away, never add it.

Access tokens last an hour and refresh silently. Membership is re-checked on
every call, so removing somebody from a workspace ends their connections with
it immediately rather than whenever a token happens to lapse.

### How the discovery works, if you are hosting this yourself

Nothing needs configuring beyond `NEXTAUTH_URL`, which you already set for
sign-in links. MyReply is its own authorization server and publishes:

| Document | Path |
| --- | --- |
| Protected resource metadata, RFC 9728 | `/.well-known/oauth-protected-resource/api/mcp` |
| Authorization server metadata, RFC 8414 | `/.well-known/oauth-authorization-server` |
| Authorization endpoint, the consent screen | `/oauth/authorize` |
| Token endpoint | `/api/oauth/token` |
| Dynamic client registration, RFC 7591 | `/api/oauth/register` |
| Token revocation, RFC 7009 | `/api/oauth/revoke` |

A call to `/api/mcp` without a credential answers `401` with a
`WWW-Authenticate` header pointing at the first of those. That header is what
lets a client find everything else on its own.

The flow is OAuth 2.1 authorization code with PKCE, `S256` only. There is no
implicit grant, no password grant, and no client secret anywhere: every client
is a public client. Tokens are audience-bound with RFC 8707 resource
indicators, so a token minted for a different MCP server is refused here.
Clients may register dynamically, which is what Claude and ChatGPT do today, or
present an https URL as their `client_id` and let MyReply read the metadata
document at it.

## Getting a key, for scripts and headless clients

An API key is still the right answer for a cron job, a server-to-server
integration, or an MCP client with no browser to open. It is also what the REST
API uses.

Settings, API keys, Create key. Name it after whatever will hold it, so you
know what breaks when you revoke it, and optionally give it an expiry and a
role. The key is shown once, in a panel you dismiss, and never again: only its
SHA-256 hash is stored, so nobody can show it to you a second time. If you lose
it, revoke it and make another.

Only an owner or an admin can create or revoke a key. A member sees the same
list read-only.

A key carries a role from the same ladder as a human member, and can never be
given more access than the person who created it. Keys stop at admin; there is
no owner key. Over REST, an `ADMIN` key can create, update, delete and import
campaigns, while a `MEMBER` key is refused those writes with a 403 and can only
read.

The MCP surface applies the same ladder: a `MEMBER` key is not offered the
write tools and is refused them if it calls one anyway.

Keys look like `mr_live_...` and can be revoked at any time. Revoking stamps the
key rather than deleting it, so the record of what existed and when it was last
used survives. Revocation takes effect on the next request, as does an expiry
passing.

```
Authorization: Bearer mr_live_xxxxxxxxxxxxxxxxxxxx
```

## MCP with a key instead of OAuth

For a client that cannot open a browser, send the key as a header:

```
url:     https://your-domain/api/mcp
header:  Authorization: Bearer mr_live_...
```

In Claude Code:

```bash
claude mcp add --transport http myreply https://your-domain/api/mcp \
  --header "Authorization: Bearer mr_live_..."
```

## Using the tools

Ask for what you want in plain language. A campaign in your own voice
looks like this:

> Make me a campaign on my latest reel. Keyword GUIDE. DM people my lead
> magnet at example.com/guide, written the way I talk, and reply publicly so
> other people comment too.

The agent will call `list_instagram_accounts`, then `create_campaign`, and tell
you what it made.

### Tools

| Tool | What it does |
| --- | --- |
| `list_instagram_accounts` | The accounts this workspace has connected. Call first, a campaign needs an account id. |
| `list_recent_posts` | Posts already referenced by a campaign, for picking a target. |
| `list_campaigns` | Existing campaigns with keywords, triggers and live state. |
| `create_campaign` | Create a comment-to-DM campaign, optionally with a tracked link. |
| `update_campaign` | Change a campaign. Send only the fields you want changed. |
| `get_campaign_performance` | Sends, failures, skips and click rate for one campaign. |
| `list_dm_logs` | Recent sends and why any of them did not arrive. |

`create_campaign` needs either a `postId` or `matchAnyPost`. The `dmMessage` is
sent verbatim, so write it in the account owner's voice. Two placeholders are
substituted: `{username}` becomes the commenter's handle, and `{link}` becomes
the tracked link.

A tool failure comes back as a readable message rather than a transport error,
so the agent can correct itself and try again.

## REST, for your own code

Base path `/api/v1`. Every response uses the same envelope:

```json
{ "success": true, "data": { } }
{ "success": false, "error": "what went wrong" }
```

| Method and path | What it does |
| --- | --- |
| `GET /api/v1/accounts` | Connected Instagram accounts. |
| `GET /api/v1/campaigns` | List campaigns. |
| `POST /api/v1/campaigns` | Create one. |
| `PATCH /api/v1/campaigns` | Update one, by `id` in the body. |
| `DELETE /api/v1/campaigns` | Delete one, by `id` in the body. |
| `POST /api/v1/import` | Batch-create up to 200 campaigns in one call. |
| `GET /api/v1/logs` | DM delivery log, filterable and paginated. |
| `GET /api/v1/stats` | Aggregate performance, optionally per account. |

Creating a campaign:

```bash
curl -X POST https://your-domain/api/v1/campaigns \
  -H "Authorization: Bearer mr_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Lead magnet",
    "instagramAccountId": "...",
    "matchAnyPost": true,
    "keywords": ["GUIDE"],
    "dmMessage": "Here you go {username}: {link}",
    "publicReplyEnabled": true
  }'
```

`/api/v1/import` is the endpoint to provision a client from another product.
It is idempotent on `postId`, so a repeated call reports the duplicates as
skipped rather than creating them twice.

### Sessions are refused on purpose

v1 requires an API key and rejects a browser session, even a valid one. Cookies
travel automatically, so a logged-in user visiting a hostile page could
otherwise have their browser make authenticated calls on their behalf. A key is
sent deliberately by a program, which is the entire audience for this surface.

## Limits worth knowing

These belong to Instagram, not to MyReply.

- A comment opens a **7 day** window to message that person.
- A DM or story reply opens **24 hours**, resetting each time they reply.
- A follow opens **nothing at all**.
- Sends are rate limited per account per hour. Anything over the limit is
  requeued and retried, not dropped.
