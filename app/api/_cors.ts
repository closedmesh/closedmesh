// Cross-origin policy for the local ClosedMesh controller.
//
// When a visitor opens https://closedmesh.com (the Vercel-hosted public UI),
// their browser makes calls back into THIS Next.js process running on their
// own Mac at http://localhost:3000. That cross-origin call needs the local
// controller to set the right CORS headers.
//
// Browsers permit https://closedmesh.com → http://localhost:3000 because
// localhost is a "potentially trustworthy origin" (W3C mixed-content spec).
//
// Origins are configured via CLOSEDMESH_PUBLIC_ORIGINS (comma-separated). The
// default trusts only the hosted site. The same-machine deployment (i.e. the
// browser opening http://localhost:3000 directly) is same-origin and doesn't
// need this layer at all.

const DEFAULT_ALLOWED = ["https://closedmesh.com"];

function allowedOrigins(): string[] {
  const raw =
    process.env.CLOSEDMESH_PUBLIC_ORIGINS ??
    process.env.CLOSEDMESH_PUBLIC_ORIGIN ??
    "";
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED;
}

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return allowedOrigins().includes(origin);
}

const ALLOWED_HEADERS = "Content-Type, Authorization, X-Requested-With";
const ALLOWED_METHODS = "GET, POST, OPTIONS";

export function corsHeaders(req: Request): Headers {
  const headers = new Headers();
  const origin = req.headers.get("origin");
  if (isOriginAllowed(origin)) {
    headers.set("Access-Control-Allow-Origin", origin!);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

export function applyCors(req: Request, res: Response): Response {
  const headers = corsHeaders(req);
  if (headers.get("Access-Control-Allow-Origin")) {
    headers.forEach((value, key) => res.headers.set(key, value));
  }
  return res;
}

export function preflightResponse(req: Request): Response {
  const origin = req.headers.get("origin");
  if (!isOriginAllowed(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req),
  });
}
