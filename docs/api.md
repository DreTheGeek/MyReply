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

A key can also be cut down to some of its role's scopes (see Scopes below).
The Settings screen makes keys with every scope their role allows. To make a
narrower one, send `scopes` to `POST /api/workspace/api-keys`. A scope the
role could never use is refused, not silently dropped.

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
| `get_campaign` | One campaign's complete settings, with its destination links in button order. A link that is not set is null. |
| `get_campaign_performance` | Sends, failures, skips and click rate for one campaign. |
| `list_dm_logs` | Recent sends and why any of them did not arrive. |

`create_campaign` needs either a `postId` or `matchAnyPost`. The `dmMessage` is
sent verbatim, so write it in the account owner's voice. Two placeholders are
substituted: `{username}` becomes the commenter's handle, and `{link}` becomes
the tracked link.

A tool failure comes back as a readable message rather than a transport error,
so the agent can correct itself and try again.

## REST, for your own code

Base path `/api/v1`. The full OpenAPI 3.1 document is at
`/api/v1/openapi.json`. Its request bodies are generated from the same
schemas the routes validate with, and a test fails if a route and the
document ever disagree.

Every response uses the same envelope:

```json
{ "success": true, "data": { } }
{ "success": false, "error": "what went wrong" }
```

An unexpected failure on our side answers `500` with a plain message. The
internal error stays in our logs.

### Scopes

A key carries scopes, and a scope only ever narrows what the key's role
allows. A key made with no scopes has everything its role allows, which is
what every key made before scopes existed keeps. A `MEMBER` key holds the
read scopes only.

| Scope | What it allows |
| --- | --- |
| `accounts:read` | See connected accounts and whether each one is working. |
| `accounts:write` | Disconnect an account. |
| `campaigns:read` | See campaigns, their settings, results and delivery log. |
| `campaigns:write` | Create, change, pause and delete campaigns. |
| `conversations:read` | Read conversations and their messages. |
| `messages:send` | Send a message to someone who wrote in the last 24 hours. |
| `contacts:read` | See contacts, with the details they chose to share. |
| `usage:read` | See messages sent, replies written and what they cost. |
| `webhooks:read` | See webhook endpoints and their delivery log. |
| `webhooks:write` | Add, change and remove webhook endpoints. |
| `workspaces:read` | Partner keys only: see the workspaces the partner created. |
| `workspaces:write` | Partner keys only: create and remove workspaces, and make links. |

MCP tools need the same scope as the matching endpoint. Over OAuth,
`mcp:read` is every read scope and `mcp:write` adds `campaigns:write`.

A key only counts through `/api/v1` and `/api/mcp`. Sent straight to a
dashboard route, it is no credential at all, so a key cut down to read
only cannot write by going around v1.

### Endpoints inside a workspace

A workspace key acts in its own workspace. A partner key acts in one of the
partner's workspaces, named in the `X-Workspace-Id` header.

| Method and path | Scope | What it does |
| --- | --- | --- |
| `GET /workspace` | any | This workspace, its accounts and how each is doing. |
| `GET /accounts` | `accounts:read` | Connected accounts. |
| `DELETE /accounts/{id}` | `accounts:write` | Disconnect one, with its campaigns and history. Audited. |
| `GET /campaigns` | `campaigns:read` | List campaigns. |
| `GET /campaigns/{id}` | `campaigns:read` | One campaign's complete settings. |
| `POST /campaigns` | `campaigns:write` | Create one. |
| `PATCH /campaigns` | `campaigns:write` | Change one, by `id` in the body. |
| `DELETE /campaigns` | `campaigns:write` | Delete one, by `id` in the body. |
| `POST /import` | `campaigns:write` | Create up to 200 campaigns at once. |
| `GET /logs` | `campaigns:read` | Delivery log, filterable and paginated. |
| `GET /stats` | `campaigns:read` | Campaign performance. |
| `GET /conversations?accountId=` | `conversations:read` | One account's conversations. |
| `GET /conversations/{id}/messages?accountId=` | `conversations:read` | Messages in one conversation. |
| `POST /messages` | `messages:send` | Send a text inside the 24 hour window. Needs an Idempotency-Key. |
| `GET /contacts` | `contacts:read` | Contacts, with a shared email or phone and the consent wording. |
| `GET /usage` | `usage:read` | Usage between two days. |
| `GET /webhooks`, `POST /webhooks` | `webhooks:read`, `webhooks:write` | This workspace's endpoints. |
| `PATCH /webhooks/{id}`, `DELETE /webhooks/{id}` | `webhooks:write` | Change or remove one. |
| `GET /webhooks/{id}/deliveries` | `webhooks:read` | Its delivery log. |

Flows are campaigns. A campaign is the step list: the trigger, then
messages with buttons, the optional follow gate, and the optional ask for
an email or phone number. The older `Flow` table has nothing that runs it,
so it is not on the API.

### Sending a message

```bash
curl -X POST https://your-domain/api/v1/messages \
  -H "Authorization: Bearer mr_live_..." \
  -H "Idempotency-Key: booking-4411-confirm" \
  -H "Content-Type: application/json" \
  -d '{ "accountId": "...", "recipientId": "...", "text": "You are booked for 3pm." }'
```

A program is automation, so it gets automation's rules:

- It may send only within 24 hours of the person's last message, button tap
  or link arrival.
- It never sends under the human agent tag.
- It never writes to someone who has no conversation with the account, or
  who said stop. Both are refused with `409`.
- It reserves the same workspace budget and hourly account slot the worker
  does.

Answers:

- `201` with `"status": "sent"`: the message went out.
- `202` with `"status": "unconfirmed"`: the platform's answer was ambiguous
  and the message may have arrived. Do not send it again. The idempotency
  record keeps this answer, so a retry with the same key gets it back
  rather than a second copy.
- `422`: the platform refused the message.

### Idempotency

Every write takes an `Idempotency-Key` header, up to 255 printable
characters. `POST /messages` requires one.

- A retry with the same key and the same request gets the first answer
  back, with `Idempotent-Replayed: true`.
- The same key on a different request is refused with `422`.
- A key whose first request is still running gets `409`.
- A `5xx` is not stored, so a retry runs again.
- Keys are per credential and kept for 24 hours.

### Usage

`GET /usage?from=2026-11-01&to=2026-11-30` returns totals for the range,
broken down by platform and by day. Days are UTC, both ends included, and
the default is the month so far. The totals are:

- messages sent;
- public replies;
- model-written replies with their cost;
- per-message platform fees, which are zero on Instagram and Facebook.

Money is in millionths of a US dollar, as integers. A model reply is
counted with what the provider said it cost, whether or not it was sent.

### Webhooks

Add an endpoint with an https URL and the events it wants. The answer
carries its signing secret, `whsec_...`, shown once.

| Event | When |
| --- | --- |
| `comment.received` | Someone commented on a connected account's post. |
| `dm.received` | Someone sent a connected account a message, a stop included. |
| `dm.sent` | A message went out, from a campaign, the inbox or the API. |
| `dm.failed` | A message failed: `reason` is `rejected` or `unconfirmed`. |
| `contact.captured` | Someone shared an email or phone, with the wording they saw. |
| `account.connected` | An account was connected or reconnected. |
| `account.disconnected` | Disconnected here, removed on the platform, or deleted at the person's request. |

Every delivery is a POST with this body:

```json
{
  "id": "evt_...",
  "type": "dm.received",
  "createdAt": "2026-11-11T15:04:05.000Z",
  "workspace": { "id": "...", "externalId": "your-own-id-or-null" },
  "data": { }
}
```

It is signed in the [Standard Webhooks](https://www.standardwebhooks.com)
format, so any of that project's libraries can verify it:

```
webhook-id:        evt_...
webhook-timestamp: 1762873445
webhook-signature: v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<body>">
```

The HMAC key is the base64 after `whsec_`, decoded. Refuse a timestamp more
than five minutes from your clock. Use `webhook-id` to drop a repeat: the
same happening always carries the same id.

Delivery rules:

- Answer with any `2xx` within ten seconds.
- Anything else is retried with backoff over about two days: nine attempts
  in all, from one minute up to a day apart.
- Redirects are never followed.
- The URL must be https and resolve to a public address. That is checked
  again at every send.
- Every attempt is in `GET /webhooks/{id}/deliveries` for 30 days.

## Partner apps

An app that embeds the engine for its own users, such as Lash Tech, holds a
partner key (`mr_partner_...`). It creates one workspace per user of its own
and can never see a workspace it did not create. Partners are set up by the
operator; see [partners.md](partners.md).

| Method and path | Scope | What it does |
| --- | --- | --- |
| `GET /workspaces` | `workspaces:read` | The partner's workspaces, a page at a time. `externalId=` finds one. |
| `POST /workspaces` | `workspaces:write` | Create one. The same `externalId` again returns the first, with 200. |
| `GET /workspaces/{id}` | `workspaces:read` | Its status: accounts (connected, needs_reconnect, events_off) and campaigns. |
| `PATCH /workspaces/{id}` | `workspaces:write` | Rename it, or change its externalId or timezone. |
| `DELETE /workspaces/{id}` | `workspaces:write` | Delete it and everything under it. Audited. |
| `POST /workspaces/{id}/connect-links` | `workspaces:write` | A link to the hosted "Connect your accounts" page. |
| `POST /workspaces/{id}/inbox-links` | `workspaces:write` | A link to the hosted inbox. |
| `GET /workspaces/usage` | `workspaces:read` | Usage for every workspace in one call. |
| `/partner/webhooks` and below | `webhooks:read`, `webhooks:write` | Endpoints that hear all of the partner's workspaces. |

Every workspace endpoint above also works with a partner key and
`X-Workspace-Id`. A workspace that is not the partner's answers `404`, the
same as one that does not exist.

### Hosted pages

A connect link (at most an hour) opens a page in the partner's brand: its
name, logo and colours, and nothing of ours unless the partner asks for a
"Powered by" line. The person picks Instagram or a Facebook Page, approves
on the platform's own screen, and lands on the partner's `returnUrl` with:

```
connect_status=connected|denied|failed|forbidden|already_connected|plan_limit|none_granted|unavailable
platform=instagram|facebook
workspace_id=...
```

`returnUrl` must be https on an origin set up for the partner in advance.
`account.connected` fires too.

An inbox link (60 minutes by default, at most 12 hours) opens the
workspace's conversations with a reply box. A reply follows the dashboard
inbox's rules. It may only go to someone who already has a conversation on
that account. Anyone holding the link can read and reply until it expires,
so mint it when the person opens it.

On both, `sendTo` emails the link from the partner's own sender address,
once that is set up.

The pages:

- can be framed only by the partner's own registered origins;
- can be served on the partner's own domain, such as
  `connect.lashtech.app`, which serves nothing else of ours;
- are server-rendered with no client script, so they work in a frame and
  on a phone.

## Rate limits

Every API key, and every OAuth connection, gets 120 requests a minute across
`/api/v1` and `/api/mcp` together. A partner key is counted separately for
each workspace it acts in, and again on its own endpoints, so one busy
studio cannot use up the others' allowance. Past that the answer is `429` with a
`Retry-After` header saying how many seconds are left in the window. The limit
is kept in Redis, and if Redis cannot be reached the answer is `503` rather
than an unlimited pass.

MCP clients may ask for protocol revision `2024-11-05`, `2025-03-26`,
`2025-06-18` or `2025-11-25`. Any other request is answered with the newest.

## Limits worth knowing

These belong to Instagram, not to MyReply.

- A comment opens a **7 day** window to message that person.
- A DM or story reply opens **24 hours**, resetting each time they reply.
- A follow opens **nothing at all**.
- Sends are rate limited per account per hour. Anything over the limit is
  requeued and retried, not dropped.
