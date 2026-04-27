import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "../components/Logo";

export const metadata: Metadata = {
  title: "How ClosedMesh works",
  description:
    "ClosedMesh is a private LLM for teams. The chat UI runs in your browser, inference runs on machines you own. Built on ClosedMesh LLM, an open-source peer-to-peer inference runtime.",
};

export default function AboutPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--bg)]/80 backdrop-blur supports-[backdrop-filter]:bg-[var(--bg)]/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/" className="flex items-center gap-2.5">
            <Logo />
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">
                ClosedMesh
              </div>
              <div className="text-[11px] text-[var(--fg-muted)]">
                Private LLM. Your team&apos;s hardware.
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-5 text-[12px]">
            <Link
              href="/download"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Download
            </Link>
            <Link
              href="/"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Open chat →
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
          <div className="flex flex-col items-start gap-8">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-3">
              <Logo size={42} />
            </div>
            <div className="max-w-3xl">
              <h1 className="text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
                A private LLM that runs on hardware your team already owns.
              </h1>
              <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-[var(--fg-muted)] sm:text-lg">
                ClosedMesh turns the unused capacity of your team&apos;s
                laptops, workstations and on-prem boxes into a single
                peer-to-peer inference mesh. The chat surface runs in your
                browser. Inference runs on machines you control. Nothing leaves
                the network.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[var(--fg-muted)]">
                No third-party LLM API
              </span>
              <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[var(--fg-muted)]">
                Peer-to-peer, encrypted
              </span>
              <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[var(--fg-muted)]">
                OpenAI-compatible runtime
              </span>
              <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[var(--fg-muted)]">
                Mac · Linux · Windows
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* The two layers */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="mb-10 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              Architecture
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Two layers, one product.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              ClosedMesh is split between a thin product surface — the chat UI
              you&apos;re using right now — and a peer-to-peer inference
              runtime that handles model loading, routing, and distribution
              across machines. They&apos;re shipped and versioned separately.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <LayerCard
              eyebrow="Product surface"
              title="ClosedMesh"
              subtitle="The chat UI and local controller."
              points={[
                "Browser-side chat UI with thread persistence and streaming responses.",
                "A local controller that auto-starts at login and proxies to the runtime on the same machine.",
                "Fleet visibility — number of nodes online, per-node hardware, currently-loaded models.",
                "Hosted at closedmesh.com; the page calls back into the visitor's localhost so prompts never traverse our infrastructure.",
              ]}
            />
            <LayerCard
              eyebrow="Inference runtime · open source"
              title="ClosedMesh LLM"
              subtitle="The peer-to-peer engine."
              points={[
                "OpenAI-compatible API at localhost:9337/v1.",
                "Pipeline parallelism for dense models that don't fit on one machine.",
                "MoE expert sharding for Mixture-of-Experts models — zero cross-node inference traffic.",
                "Capability-aware routing: requests only go to nodes that can actually serve them.",
              ]}
              footer={
                <a
                  href="https://github.com/closedmesh/closedmesh-llm"
                  className="text-[12px] text-[var(--accent)] hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  github.com/closedmesh/closedmesh-llm →
                </a>
              }
            />
          </div>
        </div>
      </section>

      {/* Diagram */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="mb-10 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              How it works
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              The page talks to your laptop. Your laptop talks to the mesh.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              When you open this site, the browser doesn&apos;t reach our
              servers for inference. It reaches back into the controller
              running on your own Mac, which routes the request to whichever
              peer in the mesh is best positioned to serve it.
            </p>
          </div>

          <ArchitectureDiagram />

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            <NumberedStep
              n={1}
              title="Browser"
              body="The chat UI loads from closedmesh.com. The page itself is static — it never sees a prompt or a token."
            />
            <NumberedStep
              n={2}
              title="Local controller"
              body="A tiny Next.js service installed on each teammate's machine. CORS-allowed for closedmesh.com. Speaks OpenAI-compatible to the runtime."
            />
            <NumberedStep
              n={3}
              title="Inference mesh"
              body="One or more ClosedMesh LLM peers. Capability-matched. Auto-routes around offline nodes. Handles dense and MoE models that don't fit on one box."
            />
          </div>
        </div>
      </section>

      {/* Properties grid */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="mb-10 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              Why a mesh
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Capacity is everywhere on your team. ClosedMesh just uses it.
            </h2>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Feature
              title="No vendor in the loop"
              body="Conversations stay on machines you own. No keys to revoke, no per-token bill, no third-party retention policy to read."
            />
            <Feature
              title="Heterogeneous hardware"
              body="An M-series Mac, an RTX 4090 box and a Vulkan laptop happily serve the same conversation. Each node advertises its capability; the router only sends work it can actually run."
            />
            <Feature
              title="Models bigger than one box"
              body="Dense models split across nodes by layer (pipeline parallelism). MoE models split by expert with zero cross-node inference traffic."
            />
            <Feature
              title="OpenAI-compatible"
              body="Every node exposes a standard /v1/chat/completions endpoint. Drop-in for any tool that speaks OpenAI — agents, IDE plugins, internal scripts."
            />
            <Feature
              title="Auto-route around failure"
              body="Laptops sleep. Workstations reboot. The mesh keeps serving — requests are dispatched only to live, capability-matched peers."
            />
            <Feature
              title="Single-binary install"
              body="One curl command per machine. The runtime drops into ~/.local/bin and registers a launchd / systemd / scheduled-task autostart."
            />
          </div>
        </div>
      </section>

      {/* Hardware matrix */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-20">
          <div className="mb-10 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              Hardware support
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Whatever the team is already running.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              The installer detects OS, CPU architecture and GPU vendor, then
              pulls the matching runtime build. You can also pin a backend
              explicitly for unusual setups.
            </p>
          </div>

          <HardwareMatrix />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[var(--border)]">
        <div className="mx-auto flex max-w-5xl flex-col items-start justify-between gap-6 px-6 py-12 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2.5">
            <Logo />
            <div className="text-[12px] text-[var(--fg-muted)]">
              ClosedMesh — private LLM, your team&apos;s hardware.
            </div>
          </div>
          <div className="flex items-center gap-5 text-[12px]">
            <Link
              href="/"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Open chat
            </Link>
            <Link
              href="/download"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Download
            </Link>
            <a
              href="https://github.com/closedmesh/closedmesh-llm"
              target="_blank"
              rel="noreferrer"
              className="text-[var(--fg-muted)] hover:text-[var(--fg)]"
            >
              Runtime on GitHub
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function LayerCard({
  eyebrow,
  title,
  subtitle,
  points,
  footer,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  points: string[];
  footer?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-7">
      <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
        {eyebrow}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{title}</div>
      <div className="mt-1 text-[13px] text-[var(--fg-muted)]">{subtitle}</div>
      <ul className="mt-6 flex flex-col gap-3 text-[14px] leading-relaxed text-[var(--fg)]/90">
        {points.map((p) => (
          <li key={p} className="flex gap-2.5">
            <span
              className="mt-2 h-1 w-1 shrink-0 rounded-full bg-[var(--accent)]"
              aria-hidden
            />
            <span>{p}</span>
          </li>
        ))}
      </ul>
      {footer && <div className="mt-6">{footer}</div>}
    </div>
  );
}

function NumberedStep({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-5">
      <div className="flex items-baseline gap-3">
        <span className="font-mono text-[11px] text-[var(--accent)]">
          0{n}
        </span>
        <div className="text-sm font-semibold">{title}</div>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-muted)]">
        {body}
      </p>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
      <div className="text-sm font-semibold tracking-tight">{title}</div>
      <p className="mt-2 text-[13px] leading-relaxed text-[var(--fg-muted)]">
        {body}
      </p>
    </div>
  );
}

function HardwareMatrix() {
  const rows: Array<{ os: string; arch: string; backend: string }> = [
    { os: "macOS", arch: "Apple Silicon", backend: "Metal" },
    { os: "Linux", arch: "x86_64 · NVIDIA", backend: "CUDA" },
    { os: "Linux", arch: "x86_64 · AMD", backend: "ROCm" },
    { os: "Linux", arch: "x86_64 · Intel / other", backend: "Vulkan" },
    { os: "Linux", arch: "x86_64 · CPU-only", backend: "CPU" },
    { os: "Linux", arch: "aarch64", backend: "Vulkan / CPU" },
    { os: "Windows 10/11", arch: "x86_64 · NVIDIA", backend: "CUDA" },
    { os: "Windows 10/11", arch: "x86_64 · AMD / Intel / other", backend: "Vulkan" },
    { os: "WSL2", arch: "x86_64 · NVIDIA passthrough", backend: "CUDA" },
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)]">
      <table className="w-full text-sm">
        <thead className="bg-[var(--bg-elev-2)] text-left text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
          <tr>
            <th className="px-5 py-3">OS</th>
            <th className="px-5 py-3">Hardware</th>
            <th className="px-5 py-3">Backend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.os}-${r.arch}`}
              className="border-t border-[var(--border)] text-[var(--fg)]"
            >
              <td className="px-5 py-3 font-medium">{r.os}</td>
              <td className="px-5 py-3 text-[var(--fg-muted)]">{r.arch}</td>
              <td className="px-5 py-3 font-mono text-[12px]">{r.backend}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArchitectureDiagram() {
  const accent = "var(--accent)";
  const fg = "var(--fg)";
  const fgMuted = "var(--fg-muted)";
  const elev = "var(--bg-elev)";
  const border = "var(--border)";

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6 sm:p-10">
      <svg
        viewBox="0 0 880 320"
        className="h-auto w-full"
        role="img"
        aria-label="ClosedMesh architecture: browser to local controller to peer mesh"
      >
        <defs>
          <marker
            id="cm-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={fgMuted} />
          </marker>
        </defs>

        {/* Browser */}
        <g>
          <rect
            x="20"
            y="100"
            width="180"
            height="120"
            rx="14"
            fill={elev}
            stroke={border}
          />
          <text
            x="110"
            y="135"
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui"
            fontSize="13"
            fontWeight={600}
            fill={fg}
          >
            Browser
          </text>
          <text
            x="110"
            y="158"
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
            fontSize="11"
            fill={fgMuted}
          >
            closedmesh.com
          </text>
          <text
            x="110"
            y="190"
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui"
            fontSize="11"
            fill={fgMuted}
          >
            chat UI · static
          </text>
        </g>

        {/* Arrow 1 */}
        <line
          x1="200"
          y1="160"
          x2="298"
          y2="160"
          stroke={fgMuted}
          strokeWidth="1.5"
          markerEnd="url(#cm-arrow)"
        />
        <text
          x="249"
          y="148"
          textAnchor="middle"
          fontFamily="ui-monospace, monospace"
          fontSize="10"
          fill={fgMuted}
        >
          /api/chat
        </text>

        {/* Local controller */}
        <g>
          <rect
            x="300"
            y="100"
            width="200"
            height="120"
            rx="14"
            fill={elev}
            stroke={border}
          />
          <text
            x="400"
            y="135"
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui"
            fontSize="13"
            fontWeight={600}
            fill={fg}
          >
            Local controller
          </text>
          <text
            x="400"
            y="158"
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
            fontSize="11"
            fill={fgMuted}
          >
            localhost:3000
          </text>
          <text
            x="400"
            y="190"
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui"
            fontSize="11"
            fill={fgMuted}
          >
            on your Mac · launchd
          </text>
        </g>

        {/* Arrow 2 */}
        <line
          x1="500"
          y1="160"
          x2="598"
          y2="160"
          stroke={fgMuted}
          strokeWidth="1.5"
          markerEnd="url(#cm-arrow)"
        />
        <text
          x="549"
          y="148"
          textAnchor="middle"
          fontFamily="ui-monospace, monospace"
          fontSize="10"
          fill={fgMuted}
        >
          /v1
        </text>

        {/* Mesh group */}
        <g>
          <rect
            x="600"
            y="40"
            width="260"
            height="240"
            rx="14"
            fill="transparent"
            stroke={border}
            strokeDasharray="4 4"
          />
          <text
            x="730"
            y="62"
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui"
            fontSize="11"
            fill={fgMuted}
          >
            ClosedMesh LLM peers
          </text>

          {/* Three peer dots with center hub */}
          {/* center hub */}
          <circle cx="730" cy="170" r="6" fill={fg} opacity="0.85" />
          {/* peers */}
          <circle cx="730" cy="100" r="9" fill={accent} />
          <circle cx="660" cy="220" r="9" fill={accent} />
          <circle cx="800" cy="220" r="9" fill={accent} />
          {/* mesh edges */}
          <line
            x1="730"
            y1="109"
            x2="730"
            y2="164"
            stroke={fg}
            strokeOpacity="0.5"
            strokeWidth="1.2"
          />
          <line
            x1="668"
            y1="214"
            x2="724"
            y2="174"
            stroke={fg}
            strokeOpacity="0.5"
            strokeWidth="1.2"
          />
          <line
            x1="792"
            y1="214"
            x2="736"
            y2="174"
            stroke={fg}
            strokeOpacity="0.5"
            strokeWidth="1.2"
          />
          {/* peer labels */}
          <text
            x="730"
            y="86"
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
            fontSize="10"
            fill={fgMuted}
          >
            M-series Mac
          </text>
          <text
            x="660"
            y="246"
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
            fontSize="10"
            fill={fgMuted}
          >
            CUDA · 4090
          </text>
          <text
            x="800"
            y="246"
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
            fontSize="10"
            fill={fgMuted}
          >
            Vulkan laptop
          </text>
        </g>
      </svg>
    </div>
  );
}
