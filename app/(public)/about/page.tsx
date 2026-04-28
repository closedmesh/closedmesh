import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "../../components/Logo";

export const metadata: Metadata = {
  title: "How ClosedMesh works",
  description:
    "Your private LLM, on hardware people own. A peer-to-peer mesh of contributed machines serving open-weight models. No third-party API in the middle.",
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
                Open peer-to-peer LLM mesh.
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
                Your private LLM.
                <span className="block text-[var(--fg-muted)]">
                  On hardware people own.
                </span>
              </h1>
              <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-[var(--fg-muted)] sm:text-lg">
                A peer-to-peer mesh of contributed machines, running
                open-weight models. Use the chat from anywhere —
                closedmesh.com or the desktop app, no install required.
                Run a node from any capable machine and add capacity to the
                mesh. No third-party API in the middle.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[12px]">
              <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[var(--fg-muted)]">
                No third-party LLM API
              </span>
              <span className="rounded-full border border-[var(--border)] bg-[var(--bg-elev)] px-3 py-1 text-[var(--fg-muted)]">
                Peer-to-peer
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
              eyebrow="Chat surface"
              title="ClosedMesh"
              subtitle="Where you actually use the thing."
              points={[
                "A web chat at closedmesh.com — open it and start typing.",
                "A native desktop app that ships the same chat plus the controls for running a node yourself.",
                "Streaming responses, thread persistence, model picker, OpenAI-compatible API for tools and agents.",
              ]}
            />
            <LayerCard
              eyebrow="Inference runtime · open source"
              title="ClosedMesh LLM"
              subtitle="The peer-to-peer engine that serves the chat."
              points={[
                "Runs on machines volunteered to the mesh — laptops, workstations, on-prem boxes.",
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
              Two roles. One mesh.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              Anyone can chat — at closedmesh.com or in the desktop app —
              without running anything themselves. Inference is served by
              peers who&apos;ve chosen to contribute compute by running the
              ClosedMesh LLM runtime on their own hardware. Anybody can be
              one, both, or neither.
            </p>
          </div>

          <ArchitectureDiagram />

          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            <NumberedStep
              n={1}
              title="Chat"
              body="Web at closedmesh.com or in the desktop app. Type a message, get a streamed response. No account, no setup, nothing to install."
            />
            <NumberedStep
              n={2}
              title="Mesh entry"
              body="Requests land at the public mesh entry point and are routed to a peer that can serve the requested model — by capability, by load, by latency."
            />
            <NumberedStep
              n={3}
              title="Compute peers"
              body="Volunteered nodes running ClosedMesh LLM. Auto-routes around offline ones, handles dense models split across several peers, MoE models sharded by expert."
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
              Capacity is everywhere. ClosedMesh just uses it.
            </h2>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <Feature
              title="No third-party AI provider"
              body="Prompts go to a peer running an open-weight model on hardware that someone in the mesh owns. No OpenAI, Anthropic or Google in the loop — nothing to revoke, no provider terms to read."
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
              body="Every peer exposes a standard /v1/chat/completions endpoint. Drop-in for any tool that speaks OpenAI — agents, IDE plugins, internal scripts."
            />
            <Feature
              title="Auto-route around failure"
              body="Laptops sleep. Workstations reboot. The mesh keeps serving — requests are dispatched only to live, capability-matched peers."
            />
            <Feature
              title="One-step contribute"
              body="Want to lend compute? Download the desktop app or curl the runtime. It registers a launchd / systemd / scheduled-task autostart and joins the mesh."
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
              ClosedMesh — open peer-to-peer LLM mesh.
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
        aria-label="ClosedMesh architecture: chat clients to mesh entry point to peer compute"
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
            Chat client
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
            or desktop app
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
            Mesh entry
          </text>
          <text
            x="400"
            y="158"
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
            fontSize="11"
            fill={fgMuted}
          >
            OpenAI-compatible /v1
          </text>
          <text
            x="400"
            y="190"
            textAnchor="middle"
            fontFamily="ui-sans-serif, system-ui"
            fontSize="11"
            fill={fgMuted}
          >
            capability-aware router
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
