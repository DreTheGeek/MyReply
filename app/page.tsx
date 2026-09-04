import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata: Metadata = {
  title: "MyReply: Instagram comment-to-DM for agencies",
  description:
    "Keyword comments become instant DMs on the official Instagram API. Unlimited automations, unlimited contacts, and a flat price that does not move when a campaign works.",
};

const heroStats = [
  { value: "None", label: "Per-contact fees" },
  { value: "Unlimited", label: "Automations and contacts" },
  { value: "Official", label: "Meta API, never scraping" },
];

const flowSteps = [
  {
    eyebrow: "Connect",
    title: "Link a client's professional account",
    description:
      "Sign in by email, connect Instagram once. No password sharing and no browser automation, so nothing breaks when Instagram ships a redesign.",
  },
  {
    eyebrow: "Build",
    title: "Pick the post, the keyword, and the DM",
    description:
      "Choose one reel, every reel, or the next one you publish. Set the keywords, the public reply, and what lands in their inbox.",
  },
  {
    eyebrow: "Deliver",
    title: "Replies go out through the official API",
    description:
      "Webhooks catch comments in seconds and a sweep every five minutes catches the ones Instagram silently drops. Every send is queued, rate limited, and logged.",
  },
];

const features = [
  {
    title: "Triggers beyond the comment",
    body: "Story replies, story mentions, Live comments, inbound DM keywords, referral links and QR codes. One campaign can carry several.",
  },
  {
    title: "Sequences, not single replies",
    body: "Open with a teaser and a button, gate the link behind a follow, then follow up minutes or hours later inside the window their reply reopened.",
  },
  {
    title: "Public replies that vary",
    body: "Rotate at random between wordings so your comment thread does not read as a bot answering itself.",
  },
  {
    title: "Every client in one place",
    body: "Separate workspaces per client, an all-accounts view across them, and team members with owner, admin or member roles.",
  },
  {
    title: "Reports clients can open",
    body: "A share link with no login, showing sends, clicks and keyword breakdown. Follower history kept past Instagram's own thirty-day window.",
  },
  {
    title: "Tracked links on everything",
    body: "Each link is wrapped and every click attributed to the campaign, the account and the workspace it came from.",
  },
];

const pricingCompare: Array<[string, string, string]> = [
  ["250", "$17", "$16"],
  ["1,000", "$92", "$16"],
  ["10,000", "$161", "$16"],
  ["25,000", "$199", "$16"],
];

const faqs = [
  {
    q: "Is this against Instagram's rules?",
    a: "No. MyReply uses the official Instagram API with your own authorised connection. It never asks for a password, never automates a browser, and only replies to people who commented on your own post, which is the flow Meta built the private reply endpoint for.",
  },
  {
    q: "What happens when Instagram drops a webhook?",
    a: "It happens more than you would like. A sweep runs every five minutes over recent comments and picks up anything the webhook missed, then sends it through the same queue. Job identifiers come from the comment itself, so a comment can only ever produce one DM.",
  },
  {
    q: "Why is there no per-contact pricing?",
    a: "Because charging more when a campaign succeeds is a strange way to treat a customer. Your bill is the same at 250 contacts and at 25,000.",
  },
  {
    q: "Can I run this for clients?",
    a: "That is what Pro is for. Each client gets their own workspace with its own campaigns, logs and members, and you switch between them without signing out.",
  },
  {
    q: "What about TikTok, or DMing new followers?",
    a: "Neither is possible outside a direct partnership with the platform. TikTok has no public API for automating DMs from comments, and Meta launched follow-triggered DMs with a single exclusive partner. Anyone promising you those two is worth a second look.",
  },
];

function AppWindow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background shadow-2xl shadow-black/20">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-border-hover" />
        <span className="h-2.5 w-2.5 rounded-full bg-border-hover" />
        <span className="h-2.5 w-2.5 rounded-full bg-border-hover" />
        <span className="ml-2 font-mono text-xs text-muted">{label}</span>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border bg-surface p-3">
      <p className="font-mono text-lg font-semibold tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-0.5 text-xs leading-tight text-muted">{label}</p>
    </div>
  );
}

const overviewStats: Array<[string, string]> = [
  ["Followers", "48,210"],
  ["Reach", "212K"],
  ["Engagement", "6.1%"],
  ["Campaigns", "8"],
  ["DMs sent", "1,284"],
  ["Click rate", "27.7%"],
];

const overviewPosts: Array<[string, string, string, string]> = [
  ["Studio tour reel", "84.1K", "5.2K", "Mar 28"],
  ["Founder Q and A", "62.7K", "4.1K", "Mar 24"],
  ["Behind the studio", "51.3K", "3.4K", "Mar 21"],
];

function OverviewPreview() {
  return (
    <AppWindow label="app / overview">
      <div className="flex items-end justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Overview</h3>
          <p className="mt-1 text-xs text-muted">
            Recent, 24 posts from @studio.store
          </p>
        </div>
        <span className="rounded border border-border px-2 py-1 text-xs text-muted">
          Last 50
        </span>
      </div>

      {/* Two across on a phone. Three tiles at 390px force the window wider
          than the viewport and push the whole page sideways. */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {overviewStats.map(([label, value]) => (
          <Stat key={label} label={label} value={value} />
        ))}
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold text-foreground">
            Followers over time
          </p>
          <p className="font-mono text-xs tabular-nums text-muted">
            48,210 <span className="text-success">+1,240</span> · 30d
          </p>
        </div>
        <svg
          viewBox="0 0 300 64"
          preserveAspectRatio="none"
          className="mt-3 h-16 w-full"
          aria-hidden="true"
        >
          <polyline
            points="0,54 43,49 86,51 129,40 171,36 214,26 257,20 300,9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            className="text-accent"
          />
        </svg>
      </div>

      <div className="mt-4 rounded border border-border bg-surface p-4">
        <p className="text-sm font-semibold text-foreground">Posts</p>
        {/* The table scrolls inside its own box rather than widening the page. */}
        <div className="-mx-1 mt-3 overflow-x-auto px-1">
        <table className="w-full min-w-[19rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
              <th className="pb-2 pr-3 font-medium">Post</th>
              <th className="pb-2 px-3 text-right font-medium">Views</th>
              <th className="pb-2 px-3 text-right font-medium">Likes</th>
              <th className="pb-2 pl-3 text-right font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {overviewPosts.map(([post, views, likes, date]) => (
              <tr key={post} className="border-b border-border last:border-0">
                <td className="py-2 pr-3 text-foreground">{post}</td>
                <td className="py-2 px-3 text-right font-mono tabular-nums text-muted">
                  {views}
                </td>
                <td className="py-2 px-3 text-right font-mono tabular-nums text-muted">
                  {likes}
                </td>
                <td className="py-2 pl-3 text-right text-muted">{date}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </AppWindow>
  );
}

function MatchedCommentCard() {
  return (
    <div className="w-64 rounded-lg border border-border bg-surface p-4 shadow-2xl shadow-black/50">
      <p className="text-xs text-muted">New comment</p>
      <p className="mt-1 text-sm font-semibold text-foreground">@maya.co</p>
      <p className="mt-1 text-sm text-muted">LINK please</p>
      <div className="mt-3 border-t border-border pt-3">
        <p className="text-xs text-muted">
          Matched <span className="font-mono text-accent">GUIDE</span>
        </p>
        <p className="mt-1 text-sm font-medium text-success">
          Queued private reply
        </p>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="font-display text-lg font-bold tracking-tight"
            aria-label="MyReply home"
          >
            MyReply
          </Link>

          <nav
            aria-label="Main"
            className="hidden items-center gap-7 text-sm md:flex"
          >
            <a href="#how" className="text-muted transition hover:text-foreground">
              How it works
            </a>
            <a
              href="#pricing"
              className="text-muted transition hover:text-foreground"
            >
              Pricing
            </a>
            <a
              href="#security"
              className="text-muted transition hover:text-foreground"
            >
              Security
            </a>
          </nav>

          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="hidden px-3 py-2 text-sm font-medium text-muted transition hover:text-foreground sm:inline-flex"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition hover:bg-accent-hover"
            >
              Start free
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      {/* grid-cols-1 is not redundant. Without it the implicit column is sized
          to min-content, so the product mock sets a floor the page cannot
          shrink below and the whole layout scrolls sideways on a phone. */}
      <section className="mx-auto grid w-full max-w-6xl grid-cols-1 items-center gap-12 px-5 pb-16 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-[0.95fr_1.05fr] lg:px-8 lg:pb-24">
        <div className="min-w-0">
          <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 font-mono text-xs text-muted">
            Official Instagram API
          </p>

          <h1 className="mt-6 text-balance font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
            Comment to DM for every client you run.
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
            Keyword comments become instant DMs on the official Instagram API.
            Unlimited automations, unlimited contacts, and a flat price that does
            not move when a campaign finally works.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-md bg-accent px-6 py-3 text-sm font-semibold text-on-accent transition hover:bg-accent-hover"
            >
              Start free
            </Link>
            <a
              href="#how"
              className="inline-flex items-center justify-center rounded-md border border-border px-6 py-3 text-sm font-semibold transition hover:border-border-hover hover:bg-surface"
            >
              See how it works
            </a>
          </div>

          <dl className="mt-10 grid grid-cols-3 gap-4 border-t border-border pt-6">
            {heroStats.map((stat) => (
              <div key={stat.label}>
                <dt className="sr-only">{stat.label}</dt>
                <dd className="font-display text-xl font-bold text-foreground">
                  {stat.value}
                </dd>
                <p className="mt-1 text-xs leading-tight text-muted">
                  {stat.label}
                </p>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative min-w-0">
          <OverviewPreview />
          {/* Hangs off the window's corner rather than sitting on top of the
              posts table, which it was covering at desktop widths. */}
          <div className="pointer-events-none absolute -bottom-10 -left-20 hidden xl:block">
            <MatchedCommentCard />
          </div>
        </div>
      </section>

      {/* Proof, immediately under the hero */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-5 py-12 sm:px-6 md:grid-cols-3 lg:px-8">
          <div>
            <p className="font-display text-2xl font-bold text-foreground">
              Two delivery paths
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Webhooks catch comments in seconds. A sweep every five minutes
              catches the ones Instagram never sends.
            </p>
          </div>
          <div>
            <p className="font-display text-2xl font-bold text-foreground">
              One DM per comment
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Job identifiers come from the comment itself, so a duplicate
              delivery is discarded instead of sent twice.
            </p>
          </div>
          <div>
            <p className="font-display text-2xl font-bold text-foreground">
              Nothing fails silently
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Every attempt is logged with an outcome, including the ones
              skipped for rate limits and why.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto w-full max-w-6xl scroll-mt-20 px-5 py-20 sm:px-6 lg:px-8">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">
          How it works
        </p>
        <h2 className="mt-3 max-w-2xl text-balance font-display text-3xl font-bold leading-tight sm:text-4xl">
          A comment in, a DM out, in about a second.
        </h2>

        <ol className="mt-10 grid gap-4 md:grid-cols-3">
          {flowSteps.map((step, index) => (
            <li
              key={step.title}
              className="rounded-lg border border-border bg-surface p-6"
            >
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-accent">
                {index + 1}. {step.eyebrow}
              </p>
              <h3 className="mt-3 font-display text-lg font-semibold">
                {step.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {step.description}
              </p>
            </li>
          ))}
        </ol>
      </section>

      {/* Feature depth */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 lg:px-8">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">
            What you get
          </p>
          <h2 className="mt-3 max-w-2xl text-balance font-display text-3xl font-bold leading-tight sm:text-4xl">
            Built for someone running this on more than one account.
          </h2>

          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg border border-border bg-background p-6"
              >
                <h3 className="font-display text-base font-semibold">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section
        id="pricing"
        className="mx-auto w-full max-w-6xl scroll-mt-20 px-5 py-20 sm:px-6 lg:px-8"
      >
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">
          Pricing
        </p>
        <h2 className="mt-3 max-w-2xl text-balance font-display text-3xl font-bold leading-tight sm:text-4xl">
          Your bill does not grow when your campaign does.
        </h2>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface p-7">
            <h3 className="font-display text-xl font-bold">Free</h3>
            <p className="mt-1 text-sm text-muted">
              For one account, forever.
            </p>
            <p className="mt-6 font-display text-4xl font-bold tabular-nums">
              $0
            </p>
            <ul className="mt-6 space-y-2.5 text-sm text-muted">
              <li>One connected Instagram account</li>
              <li>Unlimited automations</li>
              <li>Unlimited contacts and DMs</li>
              <li>Tracked links and full DM logs</li>
              <li>No branding on your messages</li>
            </ul>
            <Link
              href="/login"
              className="mt-7 inline-flex w-full items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm font-semibold transition hover:border-border-hover hover:bg-surface-hover"
            >
              Start free
            </Link>
          </div>

          <div className="rounded-lg border border-accent bg-surface p-7">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-xl font-bold">Pro</h3>
              <span className="rounded-full bg-accent px-2.5 py-1 font-mono text-[11px] font-semibold uppercase tracking-wide text-on-accent">
                For agencies
              </span>
            </div>
            <p className="mt-1 text-sm text-muted">
              For running more than one account.
            </p>
            <p className="mt-6 font-display text-4xl font-bold tabular-nums">
              $16
              <span className="ml-1 text-base font-medium text-muted">
                /month
              </span>
            </p>
            <p className="mt-1 text-sm text-muted">
              Or $13 a month billed annually, which is two months free.
            </p>
            <ul className="mt-6 space-y-2.5 text-sm text-muted">
              <li>Everything in Free</li>
              <li>Unlimited connected accounts</li>
              <li>A separate workspace per client</li>
              <li>Team members with roles</li>
              <li>Client reports under your own brand</li>
            </ul>
            <Link
              href="/login"
              className="mt-7 inline-flex w-full items-center justify-center rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent transition hover:bg-accent-hover"
            >
              Start free
            </Link>
          </div>
        </div>

        <div className="mt-10 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[34rem] text-sm">
            <caption className="border-b border-border bg-surface px-5 py-3 text-left text-sm text-muted">
              What the same month costs elsewhere, once a campaign works.
            </caption>
            <thead>
              <tr className="border-b border-border bg-surface text-left">
                <th className="px-5 py-3 font-mono text-xs font-medium uppercase tracking-wide text-muted">
                  People reached
                </th>
                <th className="px-5 py-3 font-mono text-xs font-medium uppercase tracking-wide text-muted">
                  Per-contact pricing
                </th>
                <th className="px-5 py-3 font-mono text-xs font-medium uppercase tracking-wide text-muted">
                  MyReply Pro
                </th>
              </tr>
            </thead>
            <tbody>
              {pricingCompare.map(([contacts, them, us]) => (
                <tr key={contacts} className="border-b border-border last:border-0">
                  <td className="px-5 py-3 font-mono tabular-nums text-foreground">
                    {contacts}
                  </td>
                  <td className="px-5 py-3 font-mono tabular-nums text-muted">
                    {them}
                  </td>
                  <td className="px-5 py-3 font-mono font-semibold tabular-nums text-accent">
                    {us}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Security */}
      <section
        id="security"
        className="scroll-mt-20 border-y border-border bg-surface"
      >
        <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-6 lg:px-8">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">
            Security
          </p>
          <h2 className="mt-3 max-w-2xl text-balance font-display text-3xl font-bold leading-tight sm:text-4xl">
            Your clients' accounts, handled properly.
          </h2>

          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-background p-6">
              <h3 className="font-display text-base font-semibold">
                No passwords, ever
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Accounts connect through Instagram's own authorisation screen.
                MyReply never sees a password and never drives a browser.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-6">
              <h3 className="font-display text-base font-semibold">
                Tokens encrypted at rest
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Access tokens are encrypted with AES-256-GCM and refreshed
                before they expire. Disconnect removes them.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-6">
              <h3 className="font-display text-base font-semibold">
                Signed webhooks only
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Every incoming event is verified against your app secret.
                Unsigned and forged requests are rejected and recorded.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-background p-6">
              <h3 className="font-display text-base font-semibold">
                One client cannot see another
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Every record is scoped to its workspace, enforced on every
                query rather than assumed at the edge.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto w-full max-w-3xl px-5 py-20 sm:px-6 lg:px-8">
        <h2 className="text-balance font-display text-3xl font-bold leading-tight sm:text-4xl">
          Questions worth asking
        </h2>

        <div className="mt-8 divide-y divide-border border-y border-border">
          {faqs.map((faq) => (
            <details key={faq.q} name="faq" className="group py-4">
              <summary className="cursor-pointer list-none font-display text-base font-semibold marker:content-none">
                <span className="flex items-start justify-between gap-4">
                  {faq.q}
                  <span
                    aria-hidden="true"
                    className="mt-1 shrink-0 font-mono text-muted transition group-open:rotate-45"
                  >
                    +
                  </span>
                </span>
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted">{faq.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Final CTA, same action and label as the hero */}
      <section className="mx-auto w-full max-w-6xl px-5 pb-24 sm:px-6 lg:px-8">
        <div className="rounded-xl border border-border bg-surface px-6 py-12 text-center sm:px-12">
          <h2 className="text-balance font-display text-3xl font-bold leading-tight sm:text-4xl">
            Start with one account. Add clients when you need to.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted">
            Free forever on a single account, with no cap on automations,
            contacts or DMs.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href="/login"
              className="inline-flex items-center justify-center rounded-md bg-accent px-6 py-3 text-sm font-semibold text-on-accent transition hover:bg-accent-hover"
            >
              Start free
            </Link>
            <a
              href="#pricing"
              className="inline-flex items-center justify-center rounded-md border border-border px-6 py-3 text-sm font-semibold transition hover:border-border-hover hover:bg-surface-hover"
            >
              See pricing
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p className="font-display text-base font-bold">MyReply</p>
          <nav
            aria-label="Footer"
            className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted"
          >
            <Link href="/templates" className="transition hover:text-foreground">
              Templates
            </Link>
            <Link href="/privacy" className="transition hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="transition hover:text-foreground">
              Terms
            </Link>
            <Link
              href="/data-deletion"
              className="transition hover:text-foreground"
            >
              Data deletion
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
