import type { MetadataRoute } from "next";

// Web App Manifest — makes re:call installable (the browser "install" button and
// iOS/Android "Add to Home Screen"), launching standalone (no browser chrome).
// Next auto-links this at /manifest.webmanifest. Icons live in web/public.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "re:call",
    short_name: "re:call",
    description:
      "Your team's knowledge base — captured for humans, readable by your AI.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
      // Maskable = the OS may crop to a circle/squircle; these have safe-zone padding.
      { src: "/icon-192-maskable.png", type: "image/png", sizes: "192x192", purpose: "maskable" },
      { src: "/icon-512-maskable.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
      { src: "/apple-icon.png", type: "image/png", sizes: "180x180" },
    ],
  };
}
