/**
 * Where the browser should send /api/chat and /api/status when running on
 * the hosted https://closedmesh.com page.
 *
 * - On the hosted public deployment (NEXT_PUBLIC_DEPLOYMENT === "public"),
 *   the page running in the visitor's browser cannot use Vercel's server-side
 *   /api/chat to reach the visitor's local mesh — Vercel's "127.0.0.1" is its
 *   own loopback, not the visitor's. Instead, the page calls back into the
 *   visitor's local Next.js controller (installed via
 *   scripts/install-controller.sh and pinned to localhost:3000), which in
 *   turn proxies to the local closedmesh runtime.
 *
 *   Browsers permit https://closedmesh.com → http://localhost:3000 because
 *   localhost is a "potentially trustworthy origin" (W3C mixed-content spec),
 *   and CORS is granted by app/api/_cors.ts on the controller side.
 *
 * - On the local controller itself (the launchd-installed Next.js server,
 *   also serving the chat UI at http://localhost:3000), this returns the
 *   empty string so all /api/* calls are same-origin and CORS is bypassed.
 *
 * - In `next dev` (NEXT_PUBLIC_DEPLOYMENT unset), same-origin too.
 */

const PUBLIC_DEPLOYMENT_BUILD =
  process.env.NEXT_PUBLIC_DEPLOYMENT === "public" ||
  process.env.NEXT_PUBLIC_CLOSEDMESH_DEPLOYMENT === "public";

export const LOCAL_CONTROLLER_URL =
  process.env.NEXT_PUBLIC_LOCAL_CONTROLLER_URL?.replace(/\/+$/, "") ??
  "http://localhost:3000";

/**
 * Lets us flip a single dev server into "public" mode by tagging the URL
 * with `?as=public` (or `?cm-public=1`). Handy for local smoke tests
 * without standing up a second Next process on a different port.
 */
function urlOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const sp = new URL(window.location.href).searchParams;
    return sp.get("as") === "public" || sp.get("cm-public") === "1";
  } catch {
    return false;
  }
}

export function isPublicDeployment(): boolean {
  return PUBLIC_DEPLOYMENT_BUILD || urlOverride();
}

/**
 * Absolute URL for an API path when running on the public site;
 * relative (same-origin) path when running locally.
 */
export function apiUrl(path: `/${string}`): string {
  if (!isPublicDeployment()) return path;
  return `${LOCAL_CONTROLLER_URL}${path}`;
}
