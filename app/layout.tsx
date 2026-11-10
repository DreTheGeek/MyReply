import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { THEME_SCRIPT } from "@/lib/security/theme-script";

// Three roles, three weights each at most, all subset to latin and served
// self-hosted by next/font so there is no render-blocking request to Google.
const display = Archivo({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-heading",
  display: "swap",
});

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-code",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MyReply: Instagram comment-to-DM for agencies",
  description:
    "Turn keyword comments into automatic DMs on the official Instagram API. Flat pricing with no per-contact fees, unlimited automations, and client-ready reports.",
  keywords: [
    "instagram automation",
    "comment to DM",
    "instagram private replies",
    "manychat alternative",
    "agency instagram automation",
  ],
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "MyReply",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#18181b",
  width: "device-width",
  initialScale: 1,
  // Installed on iOS the app owns the full screen, notch included; the safe
  // area insets below keep content clear of the system UI.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full ${display.variable} ${body.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Applies the saved theme before first paint. Without this the page
          renders light and then snaps to dark, which is worse than no toggle
          at all. Light stays the default: only an explicit stored choice of
          "dark" turns dark on, never the OS setting.
        */}
        <script
          dangerouslySetInnerHTML={{
            // Shared with next.config.ts, which sends the CSP hash of this
            // exact string. Editing it here alone would stop it running.
            __html: THEME_SCRIPT,
          }}
        />
      </head>
      <body
        className="min-h-full bg-background text-foreground font-sans antialiased"
        // Clears the home indicator when installed; 0 everywhere else.
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {children}
        <Analytics />
      </body>
    </html>
  );
}
