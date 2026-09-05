/**
 * Taking your data out.
 *
 * A server component on purpose: these are four ordinary links to a route that
 * sets Content-Disposition, so the browser does the download and there is no
 * state, no fetch and no JavaScript involved. Building it as a client
 * component with fetch and a Blob would be more code doing the same thing
 * worse, and would break the middle-click and right-click that people actually
 * use to save a file.
 */

const DATASETS = [
  {
    key: "contacts",
    label: "Contacts",
    detail:
      "Everyone who has interacted, with when you last messaged them and whether they opted out.",
    format: "CSV",
  },
  {
    key: "logs",
    label: "DM logs",
    detail:
      "Every send and every skip, with the reason it did not go out. This is the column nobody else lets you take.",
    format: "CSV",
  },
  {
    key: "links",
    label: "Tracked links",
    detail: "Every link, where it points and how many clicks it has.",
    format: "CSV",
  },
  {
    key: "campaigns",
    label: "Campaigns",
    detail:
      "Every campaign as JSON, in the shape the importer accepts, so it can go straight back in.",
    format: "JSON",
  },
] as const;

export default function ExportSection(): React.JSX.Element {
  return (
    <section className="panel rounded p-4 sm:p-6">
      <h2 className="text-base font-semibold">Your data</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        All of it, whenever you want it, on every plan. Campaigns come out in
        the same format the importer takes, so nothing here is a one way door.
      </p>

      <ul className="mt-5 space-y-3">
        {DATASETS.map((dataset) => (
          <li
            key={dataset.key}
            className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
          >
            <div className="min-w-[14rem] flex-1">
              <p className="text-sm font-medium text-foreground">
                {dataset.label}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                {dataset.detail}
              </p>
            </div>
            <a
              href={`/api/export?dataset=${dataset.key}`}
              className="shrink-0 rounded border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:border-border-hover hover:text-foreground"
            >
              Download {dataset.format}
            </a>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-xs text-muted">
        Exports are capped at 50,000 rows, newest first. A truncated file says
        so in its response headers.
      </p>
    </section>
  );
}
