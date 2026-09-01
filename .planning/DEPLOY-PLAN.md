# DEPLOY PLAN: OpenReply live for LaSean's own socials

Goal: comment-to-DM automation running on Boss's own Instagram professional account(s). Personal-use mode: per META_APP_REVIEW.md, NO Meta App Review needed when only accounts with roles on the app connect. Advanced Access + business verification come later, only when tenants connect (platform-service phase).

Stack verified on main: Next.js 16, Prisma 7 + Postgres, Redis + BullMQ worker (worker/dm-worker.ts is a persistent process), NextAuth magic links via Resend, Meta Graph v25.0. MIT license (embed allowed). Crons: refresh-tokens, snapshot-followers, attach-next-reel.

## Phase 0: Boss does these (about 30 to 45 minutes, accounts only)

1. Instagram: confirm the account(s) are PROFESSIONAL (business or creator). Personal accounts cannot use the API.
2. Meta app: developers.facebook.com -> Create App -> Business type -> add the Instagram product (Instagram API with Instagram business login). Collect INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, FACEBOOK_APP_SECRET. Keep the app in Development Mode.
3. App roles: add your IG-linked account under App Roles so it can connect without review.
4. Resend: account + verified sending domain (login@kaldrbusiness.com works) for magic-link login. Grab RESEND_API_KEY.
5. Railway account (recommended host: one project runs web + worker + Postgres + Redis; Vercel cannot run the persistent BullMQ worker). Alternative topology if preferred: Vercel web + Upstash Redis + Railway worker, but one Railway project is fewer moving parts.
6. Hand the five secrets to the Claude Code session through env vars, never through chat or files that get committed.

## Phase 1: Claude Code session (about 1 to 2 hours)

1. Railway project: Postgres plugin, Redis plugin, service WEB (build: npm run build with prisma migrate deploy, start: npm start), service WORKER (start: npm run worker). Shared env from .env.example: NEXTAUTH_URL (the Railway domain or custom domain), NEXTAUTH_SECRET, CRON_SECRET, ENCRYPTION_KEY (32-byte hex, generated fresh), DATABASE_URL, REDIS_URL, RESEND_API_KEY, EMAIL_FROM, META_GRAPH_API_VERSION=v25.0, the three Meta secrets, WEBHOOK_VERIFY_TOKEN (generated fresh).
2. Crons: schedule the three cron routes (refresh-tokens, snapshot-followers, attach-next-reel) with CRON_SECRET, per docs/setup.md cadence.
3. Meta webhook: in the app dashboard, set the callback to https://<domain>/api/webhook with WEBHOOK_VERIFY_TOKEN, subscribe to comments and messages fields. Verify handshake passes.
4. Connect the IG account through Settings -> Connect Instagram; confirm token stored encrypted.
5. Run the test suite; fix nothing blind, per the build system.

## Phase 2: live verification (the gate, verified not reported)

1. Create a campaign: keyword LINK on a recent reel, DM with one tracked link button, public reply on.
2. From a second account, comment LINK. Confirm: DM arrives within seconds, public reply posts, DM Logs shows SENT, tracked-link click registers.
3. Confirm rate-limit queueing intact and the webhook signature check rejects an unsigned POST.
4. Record results in VERIFICATION.md (screenshots, no tokens).

## Later phases (not now)
- Platform-service integration per kaldr-build-system INTEGRATIONS PLATFORM SERVICES: internal API + tenant context so Best Lash Tech and the other verticals ride this instance. Requires Advanced Access + business verification (Kaldr entity docs) + the App Review screencast from META_APP_REVIEW.md.
- Per-tenant abuse caps + kill switches before any tenant connects.
