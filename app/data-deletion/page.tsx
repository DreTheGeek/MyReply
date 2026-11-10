import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Data Deletion - MyReply",
  description:
    "How to remove MyReply from Instagram or Facebook, disconnect an account, and have its data deleted.",
};

export default function DataDeletionPage() {
  return (
    <LegalShell
      title="Data Deletion"
      description="How to remove MyReply from a connected Instagram or Facebook account, and how to have the data we hold for it deleted."
      updatedAt="November 10, 2026"
    >
      <section>
        <h2 className="text-xl font-bold text-foreground">Remove MyReply on Instagram or Facebook</h2>
        <p className="mt-3">
          In Instagram&apos;s settings, find Apps and websites and remove
          MyReply. In Facebook&apos;s settings, find Business integrations and
          remove MyReply. We are told straight away: the stored connection is
          erased and every campaign on that account is paused.
        </p>
        <p className="mt-3">
          If you also ask for your data to be deleted there, every account you
          connected is deleted from MyReply with its campaigns, conversations,
          contacts and delivery history. You are given a confirmation code, and
          you can check it on our status page at any time.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Disconnect in MyReply</h2>
        <p className="mt-3">
          Sign in, open Settings, and select Disconnect next to the account.
          This deletes the stored connection and everything under that account:
          its campaigns, conversations, contacts and delivery history.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Delete Workspace Data</h2>
        <p className="mt-3">
          To delete workspace, campaign, log, webhook, billing reference, and
          operational diagnostic data, contact support from the email address
          used to sign in. Include the workspace name and the Instagram username
          connected to the workspace.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-foreground">Verification</h2>
        <p className="mt-3">
          We may ask you to verify control of the email address or connected
          business account before deleting data. Deletion requests are processed
          as quickly as practical unless retention is required for legal,
          billing, fraud prevention, or security reasons.
        </p>
      </section>
    </LegalShell>
  );
}
