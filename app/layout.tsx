import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

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
    >
      <body className="min-h-full bg-background text-foreground font-sans antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
