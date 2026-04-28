import { Sidebar } from "../components/Sidebar";

// Don't statically prerender the control surface. The desktop app's
// bundled sidecar serves these pages, and prerendered HTML carries
// `Cache-Control: s-maxage=31536000` plus build-pinned `<link href>`s
// to chunk hashes. When users upgrade the .app, those hashes change but
// WKWebView happily serves the year-old cached HTML, which then 404s on
// CSS/JS chunks that no longer exist on disk — leaving them with an
// unstyled dashboard. Force dynamic rendering + the `no-store` headers
// in next.config.ts together keep every load honest.
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
