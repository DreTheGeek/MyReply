/**
 * The first screen after signing up.
 *
 * A workspace with no Instagram account connected used to land on the portal:
 * five KPI cards reading zero and three empty lanes, whose most prominent
 * button led to a campaign builder that cannot save without an account. The
 * one action that mattered sat in the third panel of the bottom row, below the
 * fold, and was hidden entirely on a phone.
 *
 * So this screen does one thing and says what happens next. There is nothing
 * to configure here and nothing to read: the whole job is one button, because
 * every other decision is made for them on the screen after it.
 */

export default function ConnectStep(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-xl py-6 sm:py-12">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Step 1 of 2
      </p>
      <h1 className="mt-2 text-2xl font-semibold text-foreground">
        Connect your Instagram account
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        MyReply reads your recent posts and writes you a set of finished
        automations. Nothing sends until you turn one on.
      </p>

      <a
        href="/api/instagram/connect"
        className="mt-6 inline-block rounded bg-accent px-5 py-3 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
      >
        Connect Instagram
      </a>

      <div className="panel mt-8 rounded p-5">
        <h2 className="text-sm font-semibold text-foreground">
          What happens when you tap it
        </h2>
        <ol className="mt-3 space-y-2 text-sm text-muted">
          <li>
            Instagram asks you to approve MyReply. You stay signed in to
            Instagram the whole time.
          </li>
          <li>
            We read your last few posts and their captions to work out what
            people ask you about.
          </li>
          <li>
            You get five ready-made automations. Tap one to turn it on, or edit
            it first.
          </li>
        </ol>
      </div>

      <p className="mt-6 text-xs leading-relaxed text-muted">
        You need an Instagram professional account, which is the free Business
        or Creator setting inside the Instagram app. A personal account cannot
        receive the messages this sends.
      </p>
    </div>
  );
}
