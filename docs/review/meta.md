# Meta App Review: Instagram and Facebook Pages

This doc is what you need to get the Meta app through App Review. It covers every permission and the feature that uses it, the screencast scripts, how a reviewer signs in and tests, and the URLs Meta asks for. The owner checklist at the end lists what only you can do.

You need review only if accounts that have no role on your Meta app will connect. Your own accounts, added as testers, work without it.

## The URLs Meta asks for

Replace `YOUR-DOMAIN` with the production domain.

| Field in the Meta dashboard | URL |
|---|---|
| Privacy policy | `https://YOUR-DOMAIN/privacy` |
| Terms of service | `https://YOUR-DOMAIN/terms` |
| User data deletion (instructions page) | `https://YOUR-DOMAIN/data-deletion` |
| Instagram business login: Deauthorize callback URL | `https://YOUR-DOMAIN/api/channels/instagram/deauthorize` |
| Instagram business login: Data deletion request URL | `https://YOUR-DOMAIN/api/channels/instagram/data-deletion` |
| Facebook Login for Business: Deauthorize callback URL | `https://YOUR-DOMAIN/api/channels/facebook/deauthorize` |
| App settings, Basic: Data deletion request URL | `https://YOUR-DOMAIN/api/channels/facebook/data-deletion` |
| Instagram OAuth redirect URI | `https://YOUR-DOMAIN/api/instagram/callback` |
| Facebook Login redirect URI | `https://YOUR-DOMAIN/api/channels/facebook/callback` |
| Webhook callback (Instagram and Page objects) | `https://YOUR-DOMAIN/api/webhook` |

What the two callbacks do:

- **Deauthorize:** the person removed the app. The engine erases the stored token and pauses every campaign on the accounts they connected. The accounts and their history stay, so reconnecting restores them.
- **Data deletion:** the person asked for their data to be deleted. Every account they connected is deleted, with its campaigns, conversations, contacts, consents and delivery history. Meta gets back `{ url, confirmation_code }`, and the URL is a status page at `/data-deletion/status?code=...`.

Both callbacks are refused unless the request is signed with that app's secret. Instagram signs with `INSTAGRAM_APP_SECRET`, Facebook with `FACEBOOK_APP_SECRET`. The person's id goes into neither the audit log nor the request record; the request keeps only a hash of it.

## Instagram permissions

Requested through Instagram business login (`lib/meta/oauth.ts`).

| Permission | Feature it powers | Why it is needed |
|---|---|---|
| `instagram_business_basic` | Connecting the account; showing its name, picture and posts in the campaign builder | Identifies the connected professional account after login, so it can be tied to the workspace. Lists its own posts and reels so the owner can pick one for a campaign. |
| `instagram_business_manage_comments` | Comment-to-DM; the optional public reply under the comment | Comments on the account's own posts arrive through the `comments` webhook. When the owner turned it on, the engine posts one public reply under a matching comment. Only the connected account's own media is acted on. |
| `instagram_business_manage_messages` | The private reply to a comment; DM keyword, story reply and story mention triggers; ice breakers; the inbox; the email or phone ask | Sends the one private reply a matching comment allows. It also answers people who write to the account, inside the 24 hour window, and lets a person on the team reply from the inbox. |
| `instagram_business_manage_insights` | Follower growth and post reach on the dashboard and the client report | Reads the account's own follower count and media insights. If you do not need those numbers, remove it from the scope list in `lib/meta/oauth.ts` before review: one fewer permission to justify. |
| Human Agent (feature) | Replying from the inbox after 24 hours, up to 7 days | Lets a person on the team answer a message after the 24 hour window closes, up to 7 days. Only a person typing in the inbox can use it, never automation. It stays off until `META_HUMAN_AGENT_APPROVED=true`, which you set only after Meta grants it. |

## Facebook Page permissions

Requested through Facebook Login for Business (`lib/meta/facebook.ts`). The Messenger use case requires `business_management`, `pages_manage_metadata`, `pages_messaging`, `pages_show_list` and `public_profile`.

| Permission | Feature it powers | Why it is needed |
|---|---|---|
| `public_profile` | Login | Granted by default with Facebook Login. Also provides the app-scoped id that the deauthorize and data deletion callbacks name. |
| `pages_show_list` | Choosing which Pages to connect | Lists the Pages the person manages so they can connect the ones they want. |
| `pages_manage_metadata` | Receiving Page events | Subscribes each connected Page to the app's webhook (`feed`, `messages`, postbacks, reads, echoes, edits, reactions, referrals). Without it no comment or message reaches the engine. |
| `pages_messaging` | The private reply to a comment; Messenger replies; the inbox; the email or phone ask | Sends the one private reply a Page comment allows. It also answers people who message the Page, inside the 24 hour window, and lets a person on the team reply from the inbox. |
| `pages_read_engagement` | Picking a post for a campaign | Reads the Page's own posts and their details for the builder. |
| `pages_read_user_content` | Comment-to-DM | Reads comments people leave on the Page's posts, so a missed webhook can be recovered and the commenter is known. |
| `pages_manage_engagement` | The optional public reply under a comment | Posts the Page's public reply under a matching comment. |
| `business_management` | Required by the Messenger use case | Meta lists it as required for Messenger. The engine reads no other business assets with it. |
| Human Agent (feature) | Replying from the inbox after 24 hours, up to 7 days | Same rules as Instagram: only a person typing in the inbox, and only once Meta has approved it. |

## Meta's rules, as the engine enforces them

Reviewers often ask. Each rule has tests in `__tests__/channel-windows.test.ts` and `__tests__/dm-worker.test.ts`.

- **One private reply per comment, within 7 days of it.** Every comment is claimed durably before the send, so a retried webhook or job never sends twice. A comment older than 7 days gets no private reply. Instagram Live comments only get one while the broadcast is running.
- **The 24 hour window.** Automated messages go only to someone who wrote, tapped a button or arrived through a link in the last 24 hours. The worker checks this on every send, including follow-ups.
- **Human Agent only where allowed.** It is only for a person replying from the inbox, only between 24 hours and 7 days, and only once `META_HUMAN_AGENT_APPROVED=true`.
- **Rate limits.** Every account has an hourly budget of 750 private replies, Meta's documented cap. Past it, a send waits 30 minutes and is retried up to three times, then is logged as rate limited. Every API key and MCP credential is limited to 120 calls a minute.
- **No double sends.** Webhook deliveries are deduplicated by event, button taps by a durable delivery claim, and comment sends by the claim above. When Meta's answer is ambiguous, the send is recorded as unconfirmed rather than sent again.
- **Consent for contact details.** When a campaign asks for an email or phone number, the consent wording sits above the one-tap buttons. The wording, the time of the tap and the message are stored with the detail (`ContactConsent`).

## How a reviewer tests it

Reviewers need four things: a way to sign in to MyReply, an account to connect, a post to comment on, and a second account to comment from.

1. **Signing in.** MyReply signs in with a magic link sent by email. A reviewer cannot open your inbox, so create a reviewer user before submitting and give the reviewer the sign-in details in the review notes (see the owner checklist).
2. **The account to connect.** Use a test Instagram professional account and a test Facebook Page you control. Never use a real customer's account. Add the reviewer's account as a tester under App roles if Meta asks for that.
3. **A post to comment on.** Publish one post on the test account and one on the test Page, each with a caption telling people to comment `LINK`.
4. **Commenting.** The reviewer comments from their own test account. Nothing is ever sent to anyone who has not commented, messaged or tapped a button.

Paste this into the review notes, filled in:

> Sign in at https://YOUR-DOMAIN/login with the reviewer details below. Open Campaigns: a campaign called "Review: LINK" is live on the test account's latest post. Comment LINK on that post from any account. Within a few seconds you get a private reply with a button. Tap it and the link arrives. Under your comment, a public reply from the account appears. Open Inbox to see the conversation and send a reply as a person on the team.

## Screencast scripts

Record on the live app with test accounts, in one take, with narration. Show the consent screen with the permissions on it. Each script is about two to three minutes.

### Instagram: comment-to-DM, DM keyword and the inbox

1. Sign in. Open Settings and click Connect Instagram. Pause on the consent screen so every permission is readable, then allow.
2. Open Campaigns and create one on a recent post: keyword `LINK`, a message with a link, a public reply turned on, and "also reply when someone DMs these words" turned on. Save.
3. On a second phone signed in to a test account, comment `LINK` on that post.
4. Show the private reply arriving, then the public reply under the comment. (`instagram_business_manage_comments` and `instagram_business_manage_messages`.)
5. From the second account, send the account a DM saying `LINK`, and show the reply. (DM keyword trigger, inside the 24 hour window.)
6. Back in MyReply, open Inbox, open that conversation and send a reply by hand. Show it arriving on the second phone.
7. Open Logs and show the sent rows. Open Settings and show Disconnect.

### Instagram: asking for an email, with consent

1. Edit the campaign and turn on "ask for their email or phone number". Choose Email. Show the consent wording.
2. From the second account, DM `LINK` again. Show the campaign's message, then the ask with the consent wording and the email button.
3. Tap the email button. Back in MyReply, open Settings, export Contacts, and show the email with the time it was shared and the wording agreed to.

### Facebook Page: comment-to-DM and Messenger

1. In Settings, click Connect a Facebook Page. Show the consent screen and the Page picker, and choose the test Page.
2. Create a campaign on the Page's post with keyword `LINK` and a public reply.
3. From a second Facebook test account, comment `LINK` on the post. Show the private reply in Messenger and the public reply under the comment. (`pages_read_user_content`, `pages_messaging`, `pages_manage_engagement`.)
4. From that account, message the Page and show the reply in Messenger. Open Inbox in MyReply and reply by hand. (`pages_messaging`.)
5. Show that only the chosen Page is connected. (`pages_show_list`, `pages_manage_metadata`.)

### Human Agent (only if you request it)

1. Show a conversation in Inbox whose last message from the person is more than 24 hours old and less than 7 days old.
2. Type a reply by hand and send it. Explain that only a person replying in the inbox can do this, and automation never can.

## Owner checklist

Only you can do these. Nothing here costs money unless noted.

- [ ] **Business verification** in Meta Business Settings: a registration, tax or bank document for Kaldr Tech. Advanced Access needs it.
- [ ] **Decide on `instagram_business_manage_insights`.** Keep it if you want follower growth on the dashboard and report. Otherwise ask me to remove it before you submit.
- [ ] **Set every URL in the table above** in the Meta dashboard, on the production domain.
- [ ] **Create the test assets:** an Instagram professional account and a Facebook Page you control, each with one post asking people to comment `LINK`, plus a second account on each platform to comment from.
- [ ] **Create the reviewer's sign-in.** Magic links need an inbox. Either give Meta a mailbox they can open, or ask me for a review-only sign-in before submitting. Without one the reviewer cannot get in, and the review fails.
- [ ] **Create the "Review: LINK" campaigns** on both test accounts and leave them live during review.
- [ ] **Record the screencasts** above, one per permission group, and upload them with the request.
- [ ] **Paste the justifications** from the tables above into each permission's request, in your words.
- [ ] **Request Human Agent** only if you want late replies from the inbox. After Meta approves it, set `META_HUMAN_AGENT_APPROVED=true` in the web app's environment.
- [ ] **After approval**, switch the app to Live and connect one real account of your own first, before anyone else connects.

## What could not be checked from code

- **Permission names and requirements** were checked against Meta's developer docs on 2026-11-10 (Graph API v27.0). The Human Agent permission's exact name was not on Meta's current pages; request it as the "Human Agent" feature in App Review.
- **Which id the callbacks carry.** The data deletion and deauthorize requests are matched on the id the login returned and, for Instagram, on the account's own id. Confirm the match with one test removal before going live: remove the app from the test account, and check that its campaigns show as paused.
- **Rate limits.** The 750 private replies an hour figure is Meta's. Figures like "200 DMs an hour" appear only in vendor blogs and are unverified.
