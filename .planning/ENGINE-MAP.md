# ENGINE MAP: MyReply as of 2026-11-09

Phase 0 of the engine build. Nothing in the code changed to produce this. Every
claim below was checked against the repo on `main` at `fbcdea2`, and against
`upstream/main` at `c78b2d2`.

---

## 1. The short version

- **Prisma is the source of truth for the data.** Supabase is only the Postgres
  host, plus pg_cron, Vault and one edge function (`embed`). There are no
  Supabase migrations and no RLS policies on app tables.
- **Tenancy is enforced in application code, not in the database.** Every
  route resolves a `workspaceId` from the session or API key and filters on
  it. The pattern holds wherever I spot-checked, but no test proves isolation
  across the board.
- **Instagram is wired directly into roughly 70 files.** About 40 Graph
  functions live in `lib/meta/client.ts` and are called from 16 places. The
  data model is Instagram-shaped too: `InstagramAccount`, `commenterId` and
  `commentId`.
- **Upstream already started a provider seam.** `lib/instagram/*` switches
  between `META` and `ZERNIO`, a paid third-party Instagram API. It is a useful
  starting point for the Phase 2 adapter, but it is Instagram-only.
- **The merge is large.** 38 files conflict, including add/add on
  `app/api/mcp/route.ts` and `app/api/v1/campaigns/route.ts`. Both sides built
  an MCP server and a v1 API independently, with two different key tables.
- **`feat/workspace-switching` is already merged.** Every commit on it is an
  ancestor of `main` (it landed as `7e63fee`). There is nothing left to merge.
- **The fork already has more than the brief lists.** It has DM keyword,
  story reply, story mention, Live comment, referral and default-reply
  triggers, ice breakers, a persistent menu, quick replies (including email
  and phone capture), contacts and tags, opt-out (STOP), quiet hours, a
  knowledge base with hybrid retrieval, AI answering with a human review loop,
  bring-your-own-key AI (Anthropic or OpenRouter), and OAuth-connected MCP.

---

## 2. What is upstream and what is mine

| | Count | Notes |
| --- | --- | --- |
| Merge base | `dac7de3` (2026-08-09) | Upstream README fix #11 |
| Commits on `main` not upstream | **83** | Matches the brief |
| Commits on upstream not in `main` | **71** | Matches the brief |
| Files changed since merge base, mine | 305 | +50,217 / -1,438 |
| Files changed since merge base, upstream | 177 | +12,602 / -1,875 |
| Files that conflict on a dry-run merge | **38** | `git merge-tree`, no working tree touched |

### What is mine (83 commits, 2026-09-01 to 2026-09-05)

Grouped by theme:

- **Deploy and infra.** `DATABASE_SCHEMA` support, split runtime and migration
  URLs, `railway.json` for the worker, Vercel framework pin, all crons moved to
  Supabase pg_cron with the secret in Vault, boot-time env validation for both
  processes.
- **Workspaces and keys.** Workspace switching, workspace-scoped API keys
  (`ApiKey`, SHA-256 at rest, a role from the same ladder as members), and
  invite fixes.
- **Triggers.** Story replies, story mentions, Live comments, referral refs,
  default reply, and DM keyword triggers.
- **Messaging.** Quick replies, persistent menu, conversation starters (ice
  breakers), attachments, echoes, edits, reactions, mentions, opt-out (STOP and
  START), and quiet hours for follow-ups.
- **People.** `Contact`, `Tag` and `ContactTag`, plus a contacts page and API.
- **AI.** Bring your own key (Anthropic or OpenRouter), an "Ask MyReply"
  assistant, a knowledge base (crawl, document, manual) with SSRF guards,
  hybrid BM25 plus pgvector retrieval, and inbound answering with a confidence
  gate and a human review loop.
- **API and MCP.** REST v1 (`/api/v1/*`) and an MCP server with write tools,
  using OAuth 2.1 with PKCE, dynamic client registration and RFC 8707 audience
  binding.
- **Compliance.** Audit log (on `OperationalEvent`), consent capture
  (`termsAcceptedAt`, `termsVersion`), retention pruning in pg_cron, data
  export, and the operator fleet view.
- **Hardening.** Security headers, error boundaries, magic-link rate limit,
  health endpoint leak fix, cron secret split, cross-tenant diagnostics fix,
  read-only key could send DMs (fixed), and around 30 UI and UX fixes.
- **Brand.** Renamed OpenReply to MyReply in the app UI.

### What upstream has that I do not (71 commits)

Everything the brief requires is present on `upstream/main`:

| Brief item | Upstream commit |
| --- | --- |
| Stop resending comments after ambiguous delivery | `257e38d` (#68), `a4b1d4d`, `b0a19f3` |
| Meta code 1 is delivery-unconfirmed | `086c155` (#70), `cb37f7b` |
| Rate limiter hands back the slot on failure | `9b06fd7` (#55) |
| Follow gate re-checks a failed follow | `94b5c8f` (#73) |
| Follow gate needs a confirmed follow for the read fallback | `d40f81f` (#74) |
| `{username}` on DM and button-tap sends | `e8219fe` (#96) |
| Editing a campaign keeps the account change | `dcfc020` (#97) |
| Keep Meta error subcodes | `ff9f143` (#92) |
| Cap the pg pool | `1047ec0` (#71) |
| Health degraded when the queue backs up | `acb3b50` (#72) |
| Unique clicks per recipient | `3b550c9` (#81) |
| Validate the OAuth state timestamp | `ff4f9a5` (#82) |
| Whole-word or partial matching in the builder | `b73dd17` (#91) |
| Workspace-scoped read-only API and MCP | `c78b2d2` (#84) |
| New interface languages | `5760181` zh-TW, `dca8713` pt-BR, `7578a86` ru |

Also on upstream, not named in the brief but worth having:

- The OAuth authorize host moved from `api.instagram.com` to
  `www.instagram.com` (`03bfc51`, `601fcc4`). **Mine still uses the old host.**
- Keyword matching for non-Latin scripts, Arabic script, Latin diacritics, and
  O folded to 0 for numeric keywords.
- Ad comments mapped back to their source post, and polling that sees boosted
  ads.
- DM button order stored so links stop swapping.
- Campaign duplicate copies every setting.
- Durable postback delivery claims (`PostbackDelivery`).
- Inbox recovery when one conversation's detail fails.
- `ALLOWED_EMAILS` sign-in allowlist, SMTP magic links, and an installable PWA.
- Dockerfile and a self-host cron script.
- **Zernio provider** (`59a31ce` and the following commits): a second way to
  reach Instagram through a paid third-party API, with its own connection
  table, webhook and origin checks.
- Landing changes: a "Buy me a coffee" link, a demo banner, and a Zernio
  referral link. These are upstream's marketing and should not ship on a
  partner-facing product.

### What the merge will collide on

38 files conflict. The ones that need real decisions:

- `app/api/mcp/route.ts` and `app/api/v1/campaigns/route.ts` (add/add). Mine
  has OAuth, `ApiKey` and write tools. Upstream's (#84) is read-only, on a new
  `ServiceKey` table with string scopes, through `lib/integrations/*`.
- `prisma/schema.prisma`. Upstream adds `ServiceKey`, `ZernioConnection`,
  `PostbackDelivery`, `InstagramAccount.provider` and `zernioAccountId`,
  `DmLog.dmDeliveryUnconfirmed` and `publicReplyDeliveryUnconfirmed`,
  `TrackedLink.position`, and `LinkClick.recipientHash`. My `LinkClick`
  already has `contactId` and `clickToken` for the same per-recipient purpose.
- `lib/queue/dm-worker.ts`, `app/api/webhook/route.ts` and
  `lib/polling/comment-reconciler.ts`. Upstream moved the comment send into
  `lib/queue/comment-delivery.ts` and the webhook body into
  `lib/queue/process-webhook.ts`, while I added several triggers and the
  opt-out, contacts and echo handling in the old locations.
- About 20 UI files, from the i18n wrapping on upstream against the MyReply
  rebrand and portal shell on mine.

### Should `feat/workspace-switching` be merged?

No, because there is nothing left in it. `git merge-base --is-ancestor
origin/feat/workspace-switching main` is true, and the branch has 0 commits
that `main` lacks. Its tip `e5c8dce` landed as part of `7e63fee`. The remote
branch is stale and can be deleted. I have not deleted it.

---

## 3. Runtime and sources of truth

| Piece | Where | Notes |
| --- | --- | --- |
| Web app | Vercel, Next.js 16.2, React 19.2 | Dashboard, OAuth callback, Meta webhook, API, MCP |
| Worker | Railway, `tsx worker/dm-worker.ts` | BullMQ consumer, concurrency 5, heartbeat every 30s, comment reconciler every 5 min |
| Database | Supabase Postgres, schema `openreply` | Prisma 7 with `@prisma/adapter-pg`; `DATABASE_SCHEMA` picks the schema |
| Queue | Railway Redis over TCP | BullMQ queue `dm-processing`, plus the rate limiter's Lua script |
| Scheduling | Supabase pg_cron and pg_net | Calls back into `/api/cron/*`; secret in Vault (`docs/cron.md`) |
| Embeddings | Supabase edge function `embed` | gte-small, 384 dims, no per-call cost |
| Login email | Resend | Magic links via Auth.js 5 beta |

**`prisma/` versus `supabase/`.** `prisma/schema.prisma` and its 36 migrations
are the real source of truth for every application table. `supabase/` holds
only `config.toml` (it registers the `embed` function), the function itself, a
backfill script, and `.temp/linked-project.json`. That file is tracked in git
and names the linked Supabase project ref; it is harmless but should not be
tracked. Two migrations reach outside Prisma's models: the pg_cron one creates
the `myreply_cron` schema, and the retention one adds `myreply_cron.prune`.

**On the global stack in CLAUDE.md.** This repo does not use Supabase Auth,
`@supabase/ssr`, Deno edge functions for app logic, Stripe or Twilio. It is
Auth.js, Prisma and BullMQ. I am working inside that and not proposing a
switch.

---

## 4. Data model

36 Prisma migrations, 35 models. Grouped:

**Identity and tenancy.** `User` (with `activeWorkspaceId`, `termsAcceptedAt`
and `termsVersion`), `Account`, `Session` and `VerificationToken` (Auth.js),
`Workspace` (plan, tone, timezone, quiet hours and the monthly DM counter),
`WorkspaceMember` (OWNER, ADMIN or MEMBER), `WorkspaceInvitation`, and
`ApiKey`.

**The channel, all Instagram-shaped.** `InstagramAccount` has a globally unique
`instagramId` and an AES-256-GCM `accessToken`. `FollowerSnapshot`.

**Campaigns.** `Automation` is the campaign: about 45 columns covering the
triggers, keywords, messages, opening DM, follow gate, follow-up, public reply,
quick replies and attachment. `TrackedLink` and `LinkClick` hang off it.

**Delivery ledger.** `DmLog` is unique on `(automationId, commentId)`. An
inbound DM is stored with `commentId = "dm:<mid>"`, so "comment" really means
"trigger event". `OutboundMessage` holds echoes and is unique on Meta's
`messageId`.

**People.** `Contact` is unique on `(instagramAccountId, externalId)`, so it is
per connected account, not per workspace. It carries `optedOutAt`. `Tag` and
`ContactTag`.

**Inbound record.** `WebhookEvent` holds the raw payload with a status.
`OperationalEvent` is the shared table for worker failures, warnings **and the
audit log**: an audit row is told apart by its `message` being one of the
`AUDIT_ACTIONS`.

**AI.** `WorkspaceAiCredential` (an encrypted key), `KnowledgeSource`,
`KnowledgeChunk` (with a `vector(384)` column) and `AssistantAnswer`.

**MCP OAuth.** `OAuthClient`, `OAuthAuthorizationCode` and `OAuthToken`, all
hashed at rest.

**Defined but not used.** No code reads or writes these:

- `Flow`, `FlowRun` and `FlowStepLog`: a versioned JSON flow graph;
- `Conversion` (Square, webhook or manual);
- `ProcessedComment`, which the schema comment calls "the shared dedup set".

Comment dedupe actually relies on BullMQ job ids plus the `DmLog` unique key.

**What makes it hard to go multi-platform.** `Automation.instagramAccountId`,
`DmLog.instagramAccountId`, `Contact.instagramAccountId` and
`OutboundMessage.instagramAccountId` are all required foreign keys to
`InstagramAccount`. `InstagramAccount.instagramId` is unique across the whole
platform. As a result, one Instagram business account can only ever belong to
one workspace, so two partner apps cannot both connect the same studio. Phase 2
needs a platform-neutral connected-account table, or a `platform` column on a
renamed one.

---

## 5. How a comment becomes a DM

1. **Meta POSTs** to `app/api/webhook/route.ts`. The handler checks
   `X-Hub-Signature-256` against `FACEBOOK_APP_SECRET`, in constant time
   (`lib/meta/webhook.ts:3`). A bad signature returns 401 and is logged to
   `OperationalEvent`.
2. **The raw payload is stored** as `WebhookEvent` with status PENDING.
3. **The payload is parsed** into ten event types: comment, live comment,
   referral, postback, message (dm, story_reply or story_mention), read,
   message edit, echo, reaction and mention. Each parser lives in
   `lib/meta/webhook.ts`.
4. **Opt-out is handled inline.** An inbound message whose text means STOP sets
   `Contact.optedOutAt` and is never queued.
5. **Each trigger becomes a BullMQ job** with a deterministic id, such as
   `comment_<igId>_<commentId>` or `message_<igId>_<base64url(mid)>`. A
   redelivered webhook re-adds the same id, and BullMQ ignores it while the
   original job is still retained (the last 1000 completed jobs, or failed ones
   for 5 minutes).
6. **Echoes, reactions and mentions are recorded only**, never acted on. The
   webhook row is marked PROCESSED, and Meta gets a 200.
7. **The worker** (`lib/queue/dm-worker.ts`) picks up `process-comment`. In
   `processComment` (line 268), it:
   - loads active campaigns for the account, matching the post, any post, or
     Live;
   - runs `matchKeywords` for each one (`lib/utils/keyword-matcher.ts`);
   - loads or creates the `DmLog` row and skips it when it is already SENT;
   - posts the public reply first, which is idempotent through
     `publicReplySentAt`;
   - enforces one private reply per comment across all campaigns, by checking
     for any SENT `DmLog` on the same `commentId`;
   - checks opt-out;
   - reserves the monthly plan budget with `reserveWorkspaceDMSend`;
   - reserves the hourly per-account slot with `reserveDMSlot`
     (`lib/utils/rate-limiter.ts`: a Redis Lua script with a cap of 750 an
     hour, requeued after 30 minutes, up to 3 times);
   - sends one of four shapes: the opening DM button, the follow-gate prompt,
     link buttons with an inline fallback, or plain text;
   - marks the row SENT, or FAILED and rethrows.
8. **BullMQ retries on a throw**, 3 attempts with a 5, 15 and 45 minute
   backoff. **This is the bug upstream #68 and #70 fix.** A send that reached
   Meta but threw afterwards, or returned Meta's ambiguous code 1, gets retried
   and can deliver twice. The rate-limit slot is also not handed back on
   failure (upstream #55).
9. **Button taps** (`process-postback`) deliver the reveal, or run the follow
   check (`followcheck:`), in `processPostback` (line 849). A read receipt on
   an opening DM schedules a fallback reveal after 5 minutes.
10. **Inbound DMs** (`process-message`, line 1184) select campaigns by surface
    opt-in (DM, story reply, story mention or default) and dedupe on
    `dm:<mid>`. When nothing matches, `tryAssistantAnswer` (line 1504) runs the
    knowledge-base answer if the workspace enabled it, then the default-reply
    campaign.
11. **Follow-ups** (`process-followup`) are delayed jobs that respect quiet
    hours.
12. **The safety net.** `lib/polling/comment-reconciler.ts` sweeps recent
    comments on campaign posts every 5 minutes, and enqueues the ones that
    match and have no owner reply, through the same `processComment`.

**Hardcoded end-user copy problem.** The default follow-gate prompt in
`lib/queue/dm-worker.ts:702` and `:932`, and
`app/(dashboard)/campaigns/[id]/page.tsx:283`, tells strangers to "star the
repo on github". A partner's customers would receive that. It has to go before
any partner goes live.

---

## 6. Where tenancy is enforced

- **Sessions.** `getCurrentWorkspaceContext()` (`lib/workspace-access.ts`)
  resolves the user's active workspace and re-checks `WorkspaceMember` on
  every call (`lib/workspace.ts:getWorkspaceMembership`). A stale
  `activeWorkspaceId` falls back to the oldest membership and grants nothing.
- **API keys.** `Authorization: Bearer mr_live_...` is SHA-256 hashed, looked
  up, and checked for revocation and expiry (`lib/api-keys.ts`). The key
  carries its own workspace and role. `/api/v1/*` refuses session cookies
  (`lib/api/v1.ts:requireApiKey`), then delegates to the same handlers the
  dashboard uses, so scoping cannot drift.
- **MCP over OAuth.** Tokens are bound to one workspace at consent time, and
  membership is re-checked on every call (`lib/oauth/membership.ts`).
- **Roles.** `lib/roles.ts`: MEMBER, then ADMIN, then OWNER. Writes need ADMIN.
  Keys stop at ADMIN.
- **Inbound events.** The workspace comes from
  `InstagramAccount.instagramId`, the account the event was delivered for.
  Nothing in the payload can pick a workspace.
- **Query pattern.** Each route checks `findFirst({ where: { id, workspaceId }
  })` before it mutates by id. I spot-checked the campaign delete and the
  member remove; both follow it.
- **The database.** There is no RLS on any application table. Prisma connects
  as a role that owns the tables, which would bypass RLS anyway unless it is
  forced. Per `VERIFICATION.md`, the `openreply` schema has no grants to `anon`
  or `authenticated`, so PostgREST cannot reach it. The only RLS in the repo
  is on `myreply_cron.http_request`.

**What tests prove today:** workspace switching, agency workspaces, API key
routes and roles, MCP roles, and OAuth for MCP. **What they do not:** a
systematic test that workspace A can read nothing of workspace B's data on
every route. Phase 4 has to add that, and add a partner layer above the
workspace, which does not exist yet.

---

## 7. Every place the code talks to Instagram (the first adapter)

**Hosts.**

- `graph.instagram.com/{v}` (`lib/meta/client.ts:10`);
- `graph.facebook.com/{v}` (`lib/meta/client.ts:14`);
- `api.instagram.com/oauth/authorize` and `/oauth/access_token`
  (`lib/meta/oauth.ts:10-11`).

The version comes from `META_GRAPH_API_VERSION`, v25.0 in production.

**Token handling.** Send calls put the token in an `Authorization: Bearer`
header. Read calls put it in an `access_token` query parameter (17 places in
`lib/meta/client.ts`). Tokens are AES-256-GCM encrypted at rest
(`lib/meta/oauth.ts:121`, `encryptToken` and `decryptToken`), and that key also
encrypts the AI credential.

**Callers and the functions they use:**

| Caller | Graph functions |
| --- | --- |
| `lib/queue/dm-worker.ts` | `sendPrivateReply`, `sendPrivateReplyWithButton`, `sendPrivateReplyWithLinkButton`, `sendDirectMessage`, `sendDirectMessageWithButton`, `sendDirectMessageWithLinkButton`, `sendDirectMessageWithQuickReplies`, `sendAttachment`, `inferAttachmentType`, `sendCommentReply`, `getUserFollowStatus` |
| `lib/polling/comment-reconciler.ts` | `getUserMedia`, `getRecentMediaComments` |
| `app/api/instagram/callback/route.ts` | `getLongLivedToken`, `getUserInfo`, `subscribeInstagramAccountToWebhooks`; and OAuth via `exchangeCodeForToken` and `verifyOAuthState` |
| `app/api/instagram/connect/route.ts` | `createOAuthState`, `getAuthorizationUrl` |
| `app/api/cron/refresh-tokens/route.ts` | `refreshLongLivedToken`, `subscribeInstagramAccountToWebhooks` |
| `app/api/cron/snapshot-followers/route.ts` | `getUserInfo` |
| `app/api/cron/attach-next-reel/route.ts` | `getUserMedia` |
| `app/api/instagram/conversations/route.ts` | `getConversations`, `sendDirectMessage` (the inbox reply) |
| `app/api/instagram/conversations/[id]/route.ts` | `getConversationMessages` |
| `app/api/instagram/conversation-starters/route.ts` | `setConversationStarters`, `clearConversationStarters`, **plus its own raw `fetch` to `/messenger_profile`** (line 118), the only Graph call outside `lib/meta` |
| `app/api/instagram/persistent-menu/route.ts` | `getPersistentMenu`, `setPersistentMenu`, `clearPersistentMenu` (`lib/meta/persistent-menu.ts`) |
| `app/api/instagram/overview/route.ts` | `getAllUserMedia`, `getMediaInsights` |
| `app/api/instagram/posts/route.ts` | `getUserMedia`, `getAllUserMedia` |
| `app/api/instagram/profile/route.ts` | `getUserInfo` |
| `app/api/onboarding/test/route.ts` | `sendDirectMessage`, `sendDirectMessageWithLinkButton` |
| `lib/onboarding/suggest.ts` | `getUserMedia` |
| `lib/reports/follower-history.ts` | `getUserInfo`, `getFollowerCountSeries` |

Instagram-specific code that is not a Graph call but belongs in the adapter:

- webhook parsing and signature verification (`lib/meta/webhook.ts`);
- the quick reply shape (`lib/meta/quick-replies.ts`);
- the 750-an-hour cap (`lib/utils/rate-limiter.ts`);
- the 7-day and 24-hour window rules, which today live only in docs and in
  `lib/ai/answering.ts`;
- the webhook field list (`WEBHOOK_FIELDS`).

**Callers of the account model.** About 70 files reference `InstagramAccount`
or `instagramId`, and the UI mentions "Instagram" about 290 times. The UI side
of Phase 2 ("show only what the platform supports") will be most of the work.

Upstream's `lib/instagram/*` already wraps the send and read calls behind an
`InstagramContext` (`META` or `ZERNIO`). If the merge keeps it, the adapter in
Phase 2 starts from those call sites instead of from `lib/meta/client.ts`.

---

## 8. Security posture against the brief

| Requirement | Today |
| --- | --- |
| Tokens AES-256-GCM, key from env | Yes (`ENCRYPTION_KEY`) |
| Tokens never logged | Mostly. No log line prints a token, but read calls put tokens in URL query strings, which proxies and APM can capture. Moving them to the header is cheap. |
| Inbound webhook signature | Yes, for Meta `X-Hub-Signature-256`, constant time |
| RLS on every table | **No.** App-level only (see section 6) |
| Zod on every route | Not audited route by route. Many routes use it, and `lib/env.ts` uses it for boot. Phase 4 audit. |
| Security headers | Yes, globally in `next.config.ts`: CSP, `frame-ancestors 'none'`, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, HSTS. Hosted partner pages will need per-route `frame-ancestors`. |
| SSRF guard | Yes for knowledge crawls (`lib/knowledge/ssrf.ts`). No resolver or outbound webhook URLs exist yet. |
| Rate limits | Auth, OAuth, the assistant, `/r/[slug]` and the inbox. **Not** on `/api/v1/*`, `/api/mcp` key calls, or the webhook. |
| Data deletion callback | **Page only** (`/data-deletion`, instructions). There is no Meta data-deletion callback endpoint and no deauthorize callback. |
| Retention | Yes, `myreply_cron.prune`: DmLog and LinkClick 90 days, WebhookEvent 30 days, resolved events 90 days |
| Audit log on destructive actions | Yes for 9 actions (`lib/audit.ts`) |
| OAuth state | HMAC signed, timing safe. The timestamp check `Date.now() - ts > max` passes a non-numeric `ts` (NaN compares false). That is the bug upstream #82 fixes. |
| Idempotency keys on writes | None on v1. `/api/v1/import` dedupes on `postId` only. |
| Error sanitizing | The pattern is generic messages to the client. The webhook returns `"Webhook processing failed"`. Not audited everywhere. |

---

## 9. What is tested and what is not

64 test files under `__tests__/`, with Vitest and the node environment. The
counts are in section 10.

**Covered well:**

- keyword matching;
- webhook parsing per field, and the webhook route's field handling;
- trigger selection;
- the DM worker (comment, postback, message and follow-up paths, with Prisma
  and Meta mocked);
- the rate limiter;
- reconciler bounds;
- OAuth state;
- MCP OAuth (PKCE, codes, refresh rotation and reuse);
- MCP tools and roles;
- API key generation and routes;
- workspace switching and agency workspaces;
- opt-out and quiet hours;
- quick replies and the persistent menu;
- knowledge chunking, crawl and SSRF;
- hybrid retrieval and embeddings;
- the answering confidence gate;
- tracking and redirects;
- usage and plans;
- the cron auth and schedule;
- env contracts;
- CSV export.

**Routes no test imports** (37 of 57). Some of these are exercised through a
mocked dependency rather than imported, so treat this as an upper bound:

- every `/api/v1/*` route;
- the Instagram OAuth `connect` and `callback`;
- the inbox routes;
- `health`;
- the three Meta crons;
- `export` and `audit`;
- `members`, `switch`, `messaging` and `invitations/accept`;
- `automations/import`;
- `templates/[slug]/install`;
- `portal/summary`;
- `logs`;
- `r/[slug]`.

**Not tested at all:**

- cross-tenant isolation as a sweep;
- the retention SQL;
- the pg_cron migration;
- the live Meta contract.

There are no integration tests against a real Postgres or Redis. Upstream adds
two `*.db.test.ts` files that do run against a database.

**Brief rules with no test today:**

- the 7-day private reply window;
- the 24-hour window outside the answering module;
- the human-agent tag (no code exists);
- "a webhook retry never sends twice" end to end, beyond BullMQ job-id dedupe.

---

## 10. Baseline

Run on 2026-11-09, Windows 11, Node 25.6.0, npm 11.8.0, after a fresh `npm
ci`. It uses the same steps and dummy env as `.github/workflows/ci.yml`. CI
itself pins Node 20.

| Step | Result |
| --- | --- |
| `npm ci` | Pass |
| `prisma generate` | Pass |
| `tsc --noEmit` | **Pass, 0 errors** |
| `eslint` | **Fail: 1 error, 17 warnings** |
| `vitest run` | **Pass: 64 of 64 files, 1067 of 1067 tests**, about 10s |
| `next build` | **Pass**: compiled in 21.3s, 61 static pages generated |
| `npm audit --omit=dev` | **19 production vulnerabilities: 4 critical, 11 high, 4 moderate** (34 including dev) |

**The lint error means CI is red on `main` today.** It is
`react-hooks/set-state-in-effect` at `app/(dashboard)/settings/page.tsx:130`
(`setStarterError(null)` called synchronously inside an effect). The 17
warnings are unused `_`-prefixed parameters in `__tests__/answering.test.ts`
(16) and `__tests__/env-contracts.test.ts` (1). It is not fixed here, because
Phase 0 changes no code. It is a one-commit fix at the start of Phase 1.

**The critical advisories are direct dependencies:** `next`, `next-auth`, and
`@auth/prisma-adapter` with its `@auth/core`. The high ones include `prisma`,
`zod`, `sharp` and `postcss`. All of them report a fix through `npm audit
fix`, and upstream's lockfile may already move some. I plan a dependency bump
as its own commit after the merge, with a full re-run of the suite and the
build.

This is the "before" count. Every later phase reports against **1067 tests in
64 files**.

---

## 11. Where the brief's facts were off

- **"There's an unmerged branch `feat/workspace-switching`."** It is fully
  merged into `main`.
- **"It already has the inbox, DM logs and the per-account rate limiter."**
  True, and it also has everything in the last bullet of section 1. Several
  Phase 3 items already exist: story replies and mentions as triggers, DM
  keyword triggers, ice breakers, and email or phone capture through quick
  replies.
- **"Both use Postgres and Redis."** True. The Postgres is Supabase, and
  scheduling is in Supabase pg_cron, not Vercel or Railway.
- **"Workspace-scoped API keys" are mine.** They are, and upstream separately
  built `ServiceKey` with scopes for #84. The merge has to pick one model.
- **The AI provider.** BYOK already supports OpenRouter. The default model is
  a Claude model, not Gemini Flash, and no per-reply cost is logged.

---

## 12. Decisions needed before or during Phase 1

1. **Zernio.** It comes in with upstream and the delivery-unconfirmed fixes are
   entangled with it. My recommendation: take it in the merge so the fixes land
   cleanly, keep it off by default and out of the UI, and decide in Phase 2
   whether to delete it. It is a paid intermediary, which is against the "own
   it, official APIs only" goal.
2. **Two key systems.** My recommendation: keep `ApiKey` (it is hashed, has
   roles, and is already used by v1 and MCP) and add upstream's scope strings to
   it, porting #84's read-only tools onto my MCP route. The other option is to
   carry both tables and unify later, which means two auth paths in the
   meantime.
3. **Upstream landing copy.** Drop "Buy me a coffee", the demo banner and the
   Zernio referral link from my landing in the merge.
4. **Em dashes.** `main` has 81 in 33 files, and upstream brings 203 in 51. I
   will remove them in a separate cleanup commit after the merge, not mixed into
   conflict resolution.
5. **Stale branch.** Should I delete `origin/feat/workspace-switching`? It is a
   push to the remote, so I am asking first.
6. **Red CI and advisories.** I plan to fix the lint error first on
   `engine/upstream-sync`, so the merge is judged against a green baseline. The
   dependency bump for the critical advisories comes last, as its own commit.
