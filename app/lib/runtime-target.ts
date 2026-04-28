/**
 * Where the browser should send `/api/*` calls.
 *
 * The chat surface is identical between closedmesh.com and the bundled
 * controller in the desktop app. In both cases the page calls its own
 * same-origin Next.js routes (`/api/chat`, `/api/status`, etc.). The
 * difference lives entirely on the server side:
 *
 * - On closedmesh.com the Vercel function proxies to the public mesh
 *   entry point (`CLOSEDMESH_RUNTIME_URL`).
 * - In the .app the bundled controller proxies to the local closedmesh-llm
 *   runtime on `127.0.0.1:9337`.
 *
 * The browser never reaches into the visitor's machine. There is no
 * cross-origin call from the public site to localhost — that pattern
 * triggered the browser's private-network-access prompt and confused
 * what's a "your machine" feature versus a "the mesh" feature.
 */

// `.trim()` defensively against env values like `"public\n"` (a real Vercel
// pitfall). We still expose `isPublicDeployment` for build-time gating
// in `proxy.ts`, but it never affects URL resolution any more.
function flagSet(value: string | undefined): boolean {
  return (value ?? "").trim() === "public";
}

const PUBLIC_DEPLOYMENT_BUILD =
  flagSet(process.env.NEXT_PUBLIC_DEPLOYMENT) ||
  flagSet(process.env.NEXT_PUBLIC_CLOSEDMESH_DEPLOYMENT);

export function isPublicDeployment(): boolean {
  return PUBLIC_DEPLOYMENT_BUILD;
}

/**
 * Same-origin path. Kept as a function for forward-compatibility with any
 * future env-driven override (e.g. pointing the .app at a remote test
 * controller for dev), but the public website never sends fetches outside
 * its own origin.
 */
export function apiUrl(path: `/${string}`): string {
  return path;
}
