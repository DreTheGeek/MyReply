# Channels

How the engine talks to messaging platforms, and how to add one.

Every platform is one **channel adapter** behind one interface
(`lib/channels/adapter.ts`). The worker, the webhook, the inbox, the crons,
the API and metering call only that interface. None of them import a
platform's client. `__tests__/channel-boundary.test.ts` fails the build if
anything outside an adapter does.

Instagram is the first adapter (`lib/channels/instagram/`).

## The pieces

| File | What it is |
| --- | --- |
| `lib/channels/platforms.ts` | The platform list. Client safe. Mirrors the `ChannelPlatform` Prisma enum. |
| `lib/channels/capabilities.ts` | What each platform can do, its messaging windows and its rate limits. Client safe, so the dashboard hides what a platform cannot do. |
| `lib/channels/events.ts` | The one inbound event shape every adapter produces. |
| `lib/channels/content.ts` | Neutral outbound messages and targets, and neutral read shapes. |
| `lib/channels/errors.ts` | The delivery-unconfirmed rule: only an explicit refusal proves nothing was sent, and an unconfirmed send is never retried automatically. |
| `lib/channels/adapter.ts` | The interface. |
| `lib/channels/registry.ts` | Platform to adapter. `openChannel(account)` returns the adapter and a decrypted context. |

## Adding a platform

1. **Research first.** Write down the official API's permissions, review
   steps, messaging window, rate limits and pricing, with links, before any
   code. Official APIs only: no scraping, no browser automation, never a
   password.
2. **Add the platform** to `CHANNEL_PLATFORMS` and to the `ChannelPlatform`
   enum, with a migration. The registry will not compile until it has an
   adapter for it.
3. **Declare its capabilities** in `capabilities.ts`. Say no to anything the
   platform does not do. The dashboard and the worker both read this.
4. **Write the adapter** in `lib/channels/<platform>/`:
   - `auth`: connect (OAuth), the code exchange, refresh, subscribing the
     account to events. The callback stores the token with
     `lib/security/token-crypto.ts` and checks the signed state from
     `lib/security/oauth-state.ts`.
   - `webhook`: its endpoint name, `accepts`, the handshake, signature
     verification (constant time), `parse` into channel events in handling
     order, and `scopePayload` so a stored payload carries only known
     accounts.
   - `messaging.send`: map each neutral content and target onto one platform
     call, and throw `UnsupportedContentError` for anything it cannot carry,
     before any request.
   - `content`, `inbox`, `profileSettings` where the platform has them.
   - `errors`: what counts as a confirmed refusal, when a rich message may
     fall back to text, the platform's own user-safe refusal text, and a
     missing-permission check.
5. **Register it** in `registry.ts`.
6. **Webhook route.** A platform that shares Meta's callback URL uses the
   `"meta"` endpoint and needs no new route. Any other platform gets its own
   route that verifies with its adapter and calls `processChannelWebhook`.
7. **Tests.** Copy `__tests__/channel-instagram-adapter.test.ts`: every
   send mapping, every refusal, event parsing and order, signature and
   handshake, and the error rules.
8. **App review prep** in `docs/review/<platform>.md`: the exact permission
   for each feature and why, the screencast script, test-user steps, and the
   privacy and data deletion URLs.

## Naming that has not caught up yet

The connected-account table is still `InstagramAccount`, with the platform's
own account id in `instagramId`, and queue jobs still carry
`instagramAccountId`. Both now hold any platform's ids; `platform` says which.
They are renamed once a second platform's rows exist, so the migration can be
written against real data rather than guessed at.
