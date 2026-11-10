# Partner apps: setting one up

A partner app embeds the engine for its own users. Lash Tech is the first:
every lash studio on Lash Tech gets a workspace, and Lash Tech drives it
through the API. This page is for the operator setting a partner up. The
developer reference is [api.md](api.md), and the OpenAPI document is at
`/api/v1/openapi.json`.

## What a partner can and cannot do

- It creates one workspace per user of its own, keyed on its own id for that
  user (`externalId`).
- With its key and `X-Workspace-Id` it acts inside one of its workspaces
  through every v1 endpoint.
- It never sees a workspace it did not create. One it does not own answers
  exactly like one that does not exist.
- Its key stops at admin inside a workspace. Billing and deleting the whole
  workspace from the dashboard stay out of reach. Its own
  `DELETE /v1/workspaces/{id}` is the one way it removes one, and that is
  audited.
- Its users never see this product's name: the hosted pages, the emails
  and the OpenAPI document carry only the partner's.

## Setting up a partner

Partners and partner keys are made with `scripts/partner.ts`, run by you
against the production database. There is deliberately no web endpoint for
either.

```bash
# 1. The partner, with where its users may be sent back to and who may frame the pages.
npx tsx --env-file=.env scripts/partner.ts create \
  --name "Lash Tech" --brand "Lash Tech" \
  --logo https://lashtech.app/logo.png --primary "#111111" --accent "#C026D3" \
  --return-origin https://lashtech.app --frame-origin https://lashtech.app \
  --plan PRO

# 2. A key for it. Printed once: hand it over through a password manager, never chat or email.
npx tsx --env-file=.env scripts/partner.ts key --partner <partnerId> --name "Lash Tech production"

# Later: its own domain and email sender, once both are set up (below).
npx tsx --env-file=.env scripts/partner.ts update --partner <partnerId> \
  --domain connect.lashtech.app \
  --email-name "Lash Tech" --email-address hello@lashtech.app

# Revoke a key, or switch the whole partner off.
npx tsx --env-file=.env scripts/partner.ts revoke --key <keyId>
npx tsx --env-file=.env scripts/partner.ts update --partner <partnerId> --disable
npx tsx --env-file=.env scripts/partner.ts list
```

`--plan` is the plan the partner's workspaces are created on. Free allows
one connected account per workspace, so a studio connecting Instagram and a
Facebook Page needs PRO. PRO also unlocks managed AI, but only if
`MANAGED_AI_API_KEY` is set. It is not, so PRO here spends nothing.

`--scopes` on `key` cuts a key down, for example
`--scopes workspaces:read,usage:read` for a reporting job. Left out, the key
has every scope.

## The partner's own domain

The hosted pages can be served from a domain of the partner's, such as
`connect.lashtech.app`, so the address bar shows the partner too.

1. The partner adds a CNAME from that name to the Vercel project.
2. You add the domain to the Vercel project (Settings, Domains).
3. You run `update --domain connect.lashtech.app`.

From then on, links are minted on that domain. Requests to it reach the
hosted pages only; anything else, the dashboard and sign-in included, is a
404. The platforms' approval screens and their redirect back still use our
own domain, which is the one registered with Meta. The person passes
through it for a moment on the way back to the partner's app.

## The partner's email sender

`sendTo` on a connect or inbox link emails the link from the partner's own
address.

1. The partner's sending domain has to be verified with the mail provider
   (Resend, or your SMTP server) before it can be used.
2. Then run `update --email-address`.

Until then, asking for `sendTo` is refused, and nothing is sent from our
address.

## What runs where, and what it costs

Nothing new to host. Webhook deliveries run on their own queue in the
existing worker on Railway, with the existing Redis, and the new tables
live in the existing Postgres. The worker picks the queue up when it is
redeployed from this branch.

## Owner checklist

- [ ] Apply the migrations to Supabase, in order: first Phase 3's five, if
      they are still waiting, then this phase's five:
  1. `api_key_scopes`
  2. `partners`
  3. `idempotency`
  4. `usage_daily`
  5. `outbound_webhooks`, which also schedules `myreply_prune_platform` at 04:00
- [ ] Redeploy the web app and the worker from this branch, once you say so.
      The worker must be redeployed or webhooks queue up undelivered.
- [ ] Create the Lash Tech partner and its key with `scripts/partner.ts`,
      and hand the key over safely.
- [ ] Give me, or set, Lash Tech's return and frame origins. They decide
      where people may be sent back to and who may embed the pages.
- [ ] Optional: `connect.lashtech.app` in Vercel and Lash Tech's DNS.
- [ ] Optional: verify Lash Tech's sending domain with Resend, then set its
      email sender.
