import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/use-theme";

// Self-hosted at build (no runtime request → safe under corporate CSP). The
// weights match the type scale: 400 body, 500 labels/buttons, 600 titles/H3,
// 700 H1/H2. Exposed as CSS vars that globals.css folds into --font-sans/mono.
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
});

// ~148 chars: under the ~160 platforms show before truncating.
const DESCRIPTION =
  "An open-source, self-hosted knowledge base for Microsoft 365, with a native " +
  "MCP interface so AI assistants work from the same notes your team writes.";

// 56 chars, under the 60-char sweet spot for og:title / twitter:title.
const OG_TITLE = "re:call — your team's knowledge base is your AI's memory";

// The social card is a static file (public/og-card.png). We build its absolute
// URL ourselves at REQUEST time rather than leaning on Next's metadataBase: the
// file-convention image routes don't pick up an async generateMetadata base, and
// a build-time base bakes in localhost (the build container has no runtime host),
// which makes crawlers fetch localhost and silently drop the image.
//
// Origin precedence (all evaluated at runtime, since headers() forces dynamic):
// APP_URL, else AUTH_POST_LOGOUT_REDIRECT_URI (provisioning sets it to the web
// origin), else the request host for zero-config self-hosters.
export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const base =
    process.env.APP_URL ??
    process.env.AUTH_POST_LOGOUT_REDIRECT_URI ??
    `${proto}://${host}`;
  const image = {
    url: `${base}/og-card.png`,
    width: 1200,
    height: 630,
    alt: "re:call — a knowledge base for Microsoft 365, with a native MCP interface for AI assistants",
  };

  return {
    metadataBase: new URL(base),
    title: { default: "re:call", template: "%s · re:call" },
    description: DESCRIPTION,
    applicationName: "re:call",
    // Installed-PWA behaviour: launch standalone on iOS (no Safari chrome) and
    // point iOS at the home-screen icon (Android reads these from the manifest).
    appleWebApp: { capable: true, title: "re:call", statusBarStyle: "default" },
    icons: { apple: "/apple-icon.png" },
    openGraph: {
      type: "website",
      siteName: "re:call",
      title: OG_TITLE,
      description: DESCRIPTION,
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title: OG_TITLE,
      description: DESCRIPTION,
      images: [image],
    },
  };
}

// Explicit mobile viewport. Next injects a sensible default, but pinning it
// guarantees the responsive layout scales to the device width rather than a
// zoomed-out desktop width on phones.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Status-bar / toolbar tint in the installed app, matched to the theme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#111214" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // suppressHydrationWarning: the pre-paint script sets the `data-theme`
  // attribute on <html> before React hydrates, which would otherwise mismatch.
  // The theme script must be a RAW inline <script>, not next/script: rendered by
  // this Server Component it lands in the initial HTML and the browser runs it
  // synchronously while parsing — before the body paints, so there's no
  // light→dark flash. next/script @ beforeInteractive does not reliably execute
  // pre-paint in the App Router, which is what caused the flash.
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
