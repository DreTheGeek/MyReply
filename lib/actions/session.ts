"use server";

import { signOut } from "@/lib/auth";

/**
 * Ends the session and returns the user to the login page.
 *
 * A server action rather than a client call so the session cookie is cleared
 * by the server that set it, and so the button still works with JavaScript
 * disabled.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
