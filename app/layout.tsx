import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://senda.network"),
  title: "Senda — open peer-to-peer LLM",
  description:
    "Chat with an LLM served by a peer-to-peer mesh of contributed compute. Peers by default; rare uptime fallback may use an external provider. Run a node yourself or just use the chat.",
  openGraph: {
    type: "website",
    siteName: "Senda",
    url: "https://senda.network",
    title: "Senda — open-source AI, served by the people",
    description:
      "A peer-to-peer network for open language models: use models other people serve, or run the app and serve them yourself. Peers by default; rare uptime fallback may use an external provider.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Senda — open-source AI, served by the people",
    description:
      "A peer-to-peer network for open language models: use models other people serve, or run the app and serve them yourself. Peers by default; rare uptime fallback may use an external provider.",
  },
};

// Runs before first paint to set the theme, avoiding a light/dark flash.
//   1. An explicit stored choice ("light"/"dark") always wins, everywhere.
//   2. Otherwise the public marketing site defaults to light — visitors get a
//      consistent light-themed website regardless of their OS setting.
//   3. Otherwise (the control app: /chat, /dashboard, /models, /nodes, /logs,
//      /settings) the attribute is left off so the CSS prefers-color-scheme
//      media query governs and the app follows the OS.
// Keep in sync with app/lib/theme.ts.
const themeScript = `(function(){try{var t=localStorage.getItem("senda:theme");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t);return;}var app=/^\\/(chat|dashboard|models|nodes|logs|settings)(\\/|$)/.test(location.pathname);if(!app){document.documentElement.setAttribute("data-theme","light");}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <meta name="color-scheme" content="light dark" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
