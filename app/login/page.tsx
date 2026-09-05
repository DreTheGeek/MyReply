import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import LoginForm from "@/components/login-form";
import { getCampaignTemplate } from "@/lib/templates/campaign-templates";

export const metadata = {
  title: "Login - MyReply",
  description: "Sign in to manage Instagram comment-to-DM campaigns.",
};

/**
 * What went wrong, in words a customer can act on.
 *
 * The page had no error branch at all: the searchParams type did not even
 * declare one, and the server action let AuthError escape.
 */
function describeLoginNotice(
  error?: string,
  session?: string
): { tone: "error" | "info"; message: string } | null {
  if (error === "missing_email") {
    return { tone: "error", message: "Enter your email address to continue." };
  }
  if (error === "send_failed") {
    return {
      tone: "error",
      message:
        "We could not send that link just now. Check the address and try again in a moment.",
    };
  }
  if (error) {
    return {
      tone: "error",
      message: "That sign-in link did not work. Request a fresh one below.",
    };
  }
  if (session === "expired") {
    return {
      tone: "info",
      message: "You were signed out. Sign in again to pick up where you were.",
    };
  }
  return null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string;
    template?: string;
    /** Set by the failure path below. */
    error?: string;
    /** Set by the dashboard layout when the session cookie is dead. */
    session?: string;
  }>;
}) {
  const params = await searchParams;
  const notice = describeLoginNotice(params.error, params.session);
  const selectedTemplate = getCampaignTemplate(params.template);
  const templateCallbackUrl = selectedTemplate
    ? `/campaigns/new?template=${selectedTemplate.slug}`
    : null;
  const callbackUrl = params.callbackUrl ?? templateCallbackUrl ?? "/dashboard";

  async function sendMagicLink(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim();
    if (!email) redirect("/login?error=missing_email");

    try {
      await signIn("resend", { email, redirectTo: callbackUrl });
    } catch (error) {
      // signIn signals success by throwing NEXT_REDIRECT, so only AuthError
      // means the send actually failed. Everything else is rethrown.
      //
      // Without this the whole page threw and the person got Next's raw
      // server-exception screen on step one of the golden path. Resend being
      // down, an unverified sending domain, a missing key on a first deploy
      // and our own rate limiter all land here.
      if (error instanceof AuthError) {
        redirect("/login?error=send_failed");
      }
      throw error;
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-foreground">
            MyReply
          </h1>
          <p className="text-muted text-sm leading-relaxed mt-2">
            {selectedTemplate
              ? `Sign in to use the ${selectedTemplate.title} template.`
              : "Sign in by email, then connect your Instagram professional account."}
          </p>
        </div>

        <div className="panel rounded p-8 shadow-black/40">
          {selectedTemplate && (
            <div className="mb-5 border border-accent/20 bg-accent/10 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-accent">
                Template selected
              </p>
              <p className="mt-2 text-sm font-semibold text-foreground">
                {selectedTemplate.title}
              </p>
            </div>
          )}

          {notice && (
            <div
              className={`mb-5 rounded border p-3 text-sm ${
                notice.tone === "error"
                  ? "border-error/30 bg-error/5 text-error"
                  : "border-border bg-surface text-muted"
              }`}
            >
              {notice.message}
            </div>
          )}

          <LoginForm action={sendMagicLink} />
        </div>
      </div>
    </div>
  );
}
