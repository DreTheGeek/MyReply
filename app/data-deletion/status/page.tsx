import type { Metadata } from "next";
import { z } from "zod";
import LegalShell from "@/components/legal-shell";
import { findDataDeletionRequest } from "@/lib/channels/compliance";
import { PLATFORM_LABELS } from "@/lib/channels/platforms";

export const metadata: Metadata = {
  title: "Data Deletion Status - MyReply",
  description: "Check a data deletion request by its confirmation code.",
  robots: { index: false, follow: false },
};

// Read per request: a code's status changes when the deletion completes.
export const dynamic = "force-dynamic";

const codeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{16}$/);

type PageProps = { searchParams: Promise<{ code?: string | string[] }> };

function formatDate(date: Date): string {
  return date.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" });
}

export default async function DataDeletionStatusPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const raw = (await searchParams).code;
  const parsed = codeSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  const request = parsed.success ? await findDataDeletionRequest(parsed.data) : null;

  return (
    <LegalShell
      title="Data Deletion Status"
      description="The status of a request to delete the data MyReply held for a connected account."
      updatedAt="November 10, 2026"
    >
      {request && parsed.success ? (
        <section>
          <h2 className="text-xl font-bold text-foreground">
            {request.completedAt ? "Deleted" : "Received, in progress"}
          </h2>
          <p className="mt-3">Confirmation code: {parsed.data}</p>
          <p className="mt-3">
            {PLATFORM_LABELS[request.platform]} sent this request on{" "}
            {formatDate(request.requestedAt)} UTC.
          </p>
          {request.completedAt ? (
            <p className="mt-3">
              Finished on {formatDate(request.completedAt)} UTC. The accounts you connected were
              removed, along with their campaigns, conversations, contacts and delivery history.
            </p>
          ) : (
            <p className="mt-3">
              It has not finished yet. Check back shortly, or contact support with the code above.
            </p>
          )}
        </section>
      ) : (
        <section>
          <h2 className="text-xl font-bold text-foreground">Code not found</h2>
          <p className="mt-3">
            We could not find a request with that confirmation code. Check that the code matches
            the one you were given. Requests are kept for a year.
          </p>
        </section>
      )}
    </LegalShell>
  );
}
