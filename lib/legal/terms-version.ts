/**
 * The version of the Terms and Privacy Policy currently shown at signup.
 *
 * Dated rather than numbered, because that is what the policy pages
 * themselves display and what somebody would quote back at you. Change this
 * whenever those pages change materially, so a stored value always points at
 * a document that can be produced.
 *
 * app/terms/page.tsx and app/privacy/page.tsx render their own dates. If this
 * disagrees with them, this is the one that is wrong.
 */
export const CURRENT_TERMS_VERSION = "2026-05-24";
