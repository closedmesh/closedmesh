import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge proxy (Next 16's middleware replacement). Its sole job is to make
 * absolutely sure that the public Vercel deployment (closedmesh.com) does
 * not expose anything that's only meaningful on the user's own machine.
 *
 * The codebase has two surfaces that share components and libs:
 *   1. The public marketing + chat site, deployed to Vercel.
 *      `NEXT_PUBLIC_DEPLOYMENT === "public"` here.
 *   2. The local controller bundled inside the desktop .app (and also
 *      installable via scripts/install-controller.sh on Linux servers).
 *      `NEXT_PUBLIC_DEPLOYMENT` is unset there.
 *
 * The (control) route group — Dashboard, Chat-with-sidebar, Models, Mesh,
 * Activity, Settings — and every /api/control/* endpoint only make sense
 * on (2). Shipping them on (1) would mean the public website appears to
 * "manage your computer hardware", which is exactly the sort of confusion
 * we want to avoid. So on the public deployment we 404 every route in
 * that surface.
 *
 * Belt-and-braces: the route handlers themselves *also* check `isPublic`
 * and refuse to do anything dangerous. Middleware just makes the routes
 * cease to exist at the edge before any handler runs.
 */
const CONTROL_PAGE_PREFIXES = [
  "/dashboard",
  "/models",
  "/nodes",
  "/logs",
  "/settings",
];

const CONTROL_API_PREFIX = "/api/control";

// `.trim()` defensively — a stray newline in the Vercel env var
// (`"public\n"` instead of `"public"`) is the kind of typo that would
// silently disable the firewall otherwise. Empty / unset env vars stay
// falsy.
function flagSet(value: string | undefined): boolean {
  return (value ?? "").trim() === "public";
}

const PUBLIC_DEPLOYMENT =
  flagSet(process.env.NEXT_PUBLIC_DEPLOYMENT) ||
  flagSet(process.env.CLOSEDMESH_DEPLOYMENT);

export function proxy(req: NextRequest) {
  if (!PUBLIC_DEPLOYMENT) return NextResponse.next();

  const path = req.nextUrl.pathname;

  // The /chat path collides with the control-side page at (control)/chat.
  // On the public site, `/` is already the chat surface, so anyone landing
  // on /chat almost certainly meant the homepage. Redirect rather than
  // 404 — better UX, especially for shared links.
  if (path === "/chat" || path.startsWith("/chat/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url, 308);
  }

  if (path.startsWith(CONTROL_API_PREFIX)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  if (
    CONTROL_PAGE_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(prefix + "/"),
    )
  ) {
    // Rewrite to a path that no route matches; Next.js will render the
    // global app/not-found.tsx with a 404 status. That gives us a styled
    // marketing 404 (link back to /) instead of a bare text response.
    const url = req.nextUrl.clone();
    url.pathname = "/_blocked-on-public";
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  // Apply to everything except Next's internal asset paths and static files.
  // Without this, the proxy would run on every chunk request and slow page
  // loads down for no reason.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|install.sh|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|js|css|map|woff2?)$).*)",
  ],
};
