import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";

export const metadata: Metadata = {
  title: "Security & threat model — Senda",
  description:
    "An honest account of what Senda protects, what it does not, how peer verification works, and how this compares to centralized APIs and attestation-based marketplaces.",
};

/**
 * /security — public threat model for the early-access launch.
 *
 * Leads with the prompt-visibility trade-off (serving peer must read the
 * prompt), documents what verification actually enforces today, and
 * differentiates without overclaiming vs coordinator/TEE approaches.
 */
export default function SecurityPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />

      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
        <header className="mb-12 max-w-2xl">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
            Security
          </div>
          <h1 className="mt-2 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl">
            Threat model &amp; trust boundaries
          </h1>
          <p className="mt-4 text-pretty text-[15px] leading-relaxed text-[var(--fg-muted)]">
            Senda is a peer-to-peer inference mesh, not a hosted API
            behind a privacy guarantee. This page states what that means in
            practice — including what we do not protect against today.
          </p>
        </header>

        <div className="prose-section space-y-12 text-[15px] leading-relaxed text-[var(--fg-muted)]">
          <Section title="The honest trade-off: prompts and peers">
            <p>
              When you chat through the mesh, a{" "}
              <strong className="font-medium text-[var(--fg)]">
                serving peer must read your prompt
              </strong>{" "}
              to run inference. That peer runs the open-source Senda LLM
              runtime on hardware the operator controls. Unlike a centralized
              API where one vendor contractually limits access, each mesh peer
              is a separate operator with physical access to the machine
              serving your session.
            </p>
            <p>
              Senda does <em>not</em> today provide hardened enclaves,
              TEE attestation, or encrypted-inference guarantees that would
              prevent a malicious operator from inspecting traffic on their
              own box. If you need prompts to never be readable by third
              parties, run your own peer locally — or keep sensitive work
              entirely on hardware you control.
            </p>
          </Section>

          <Section title="What we do enforce">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong className="font-medium text-[var(--fg)]">
                  Model identity.
                </strong>{" "}
                Peers publish a deterministic fingerprint of the model they
                claim to serve. Entry nodes re-run unpredictable synthetic
                probes and compare — a peer cannot advertise a 70B model while
                quietly running an 8B or returning canned text. Verification
                uses only synthetic probes;{" "}
                <strong className="font-medium text-[var(--fg)]">
                  real user prompts are never replayed
                </strong>{" "}
                for auditing.
              </li>
              <li>
                <strong className="font-medium text-[var(--fg)]">
                  Open-source runtime.
                </strong>{" "}
                The inference stack is auditable at{" "}
                <a
                  href="https://github.com/senda-network/senda-llm"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  senda-network/senda-llm
                </a>
                . Operators and users can inspect what runs on a peer before
                trusting it.
              </li>
              <li>
                <strong className="font-medium text-[var(--fg)]">
                  No third-party AI provider in the default path.
                </strong>{" "}
                Mesh-routed requests stay on contributor hardware. A
                configured external fallback exists for daily-driver models
                when the mesh cannot meet latency targets — responses are
                labeled in routing headers so callers can see which supply
                path served them.
              </li>
              <li>
                <strong className="font-medium text-[var(--fg)]">
                  Benchmark honesty.
                </strong>{" "}
                Peers gossip both through-mesh and native (local{" "}
                <code className="rounded bg-[var(--bg-elev)] px-1 py-0.5 text-[13px] text-[var(--fg)]">
                  llama-server
                </code>
                ) throughput figures. The public catalog at{" "}
                <Link href="/status" className="text-[var(--accent)] hover:underline">
                  /status
                </Link>{" "}
                shows measured numbers, not marketing claims.
              </li>
            </ul>
            <p className="mt-4 rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-[14px]">
              <span className="font-semibold text-amber-200">Today:</span>{" "}
              verification runs in <em>observe mode</em> — verdicts are logged
              and displayed; routing is not yet demoted on mismatch. Enforcement
              ships only after false-positive rates on real peers are clean.
            </p>
          </Section>

          <Section title="What we do not claim">
            <ul className="list-disc space-y-2 pl-5">
              <li>Prompt confidentiality from arbitrary mesh peers</li>
              <li>Hardware attestation or TEE-isolated inference</li>
              <li>SLA-grade uptime or latency on the free early-access mesh</li>
              <li>
                A crypto token, customer-facing on-chain escrow vault, or{" "}
                <em>guaranteed</em> fiat/USDC payouts. Contributor{" "}
                <em>credits</em> are not cash (
                <Link href="/contribute" className="text-[var(--accent)] hover:underline">
                  /contribute
                </Link>
                ). Peer USD + prepaid API balance exist as an early-access
                preview with caps — see{" "}
                <Link href="/earn" className="text-[var(--accent)] hover:underline">
                  /earn
                </Link>
                ,{" "}
                <Link href="/buy" className="text-[var(--accent)] hover:underline">
                  /buy
                </Link>
                ,{" "}
                <Link href="/terms" className="text-[var(--accent)] hover:underline">
                  /terms
                </Link>
                )
              </li>
            </ul>
          </Section>

          <Section title="How this compares">
            <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="w-full min-w-[520px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--bg-elev)] text-[11px] uppercase tracking-wider text-[var(--fg-muted)]">
                    <th className="px-4 py-3 font-medium">Dimension</th>
                    <th className="px-4 py-3 font-medium">Senda</th>
                    <th className="px-4 py-3 font-medium">
                      Centralized API
                    </th>
                    <th className="px-4 py-3 font-medium">
                      Attestation marketplace
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  <CompareRow
                    dim="Architecture"
                    us="True P2P mesh; replication-first routing"
                    centralized="Single vendor datacenter"
                    attestation="Coordinator + attested workers"
                  />
                  <CompareRow
                    dim="Prompt hiding"
                    us="Honest peer read; run local for max privacy"
                    centralized="Vendor policy + contract"
                    attestation="Stronger hiding via TEE / hardened runtime"
                  />
                  <CompareRow
                    dim="Hardware"
                    us="Apple Silicon, CUDA, Vulkan, ROCm, CPU"
                    centralized="Vendor-chosen GPUs"
                    attestation="Often Apple Silicon + attestation"
                  />
                  <CompareRow
                    dim="Supply model"
                    us="Open contributors; credits + preview Peer USD"
                    centralized="Vendor capacity"
                    attestation="Curated providers"
                  />
                  <CompareRow
                    dim="Verification"
                    us="Synthetic model-identity probes (open source)"
                    centralized="Trust the brand"
                    attestation="Hardware + runtime attestation"
                  />
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-[14px]">
              Senda optimizes for{" "}
              <strong className="font-medium text-[var(--fg)]">
                open mesh supply on hardware people already own
              </strong>{" "}
              — speculative decoding, solo replication, and broad backend
              support. Attestation-first marketplaces optimize for{" "}
              <strong className="font-medium text-[var(--fg)]">
                stronger prompt hiding on curated hardware
              </strong>
              . Different trade-offs; we name ours explicitly rather than
              implying equivalence.
            </p>
          </Section>

          <Section title="Operator responsibilities">
            <p>
              If you run a peer, you are responsible for the machine, network
              exposure, model files, and power draw on your hardware. The
              runtime can autostart as a user service; it joins the mesh via an
              invite token embedded in the desktop app or supplied at install
              time. Do not run a peer on hardware or networks you do not
              control.
            </p>
          </Section>

          <Section title="Reporting issues">
            <p>
              Security vulnerabilities in the runtime or website:{" "}
              <a
                href="https://github.com/senda-network/senda-llm/security"
                target="_blank"
                rel="noreferrer"
                className="text-[var(--accent)] hover:underline"
              >
                GitHub Security Advisories
              </a>{" "}
              on <code className="text-[13px]">senda-llm</code>. Mesh
              misbehavior (peers serving wrong models, suspicious routing): note
              the peer hostname and model on{" "}
              <Link href="/status" className="text-[var(--accent)] hover:underline">
                /status
              </Link>{" "}
              and open a discussion on the runtime repo.
            </p>
          </Section>
        </div>
      </main>

      <PublicFooter />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold tracking-tight text-[var(--fg)]">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function CompareRow({
  dim,
  us,
  centralized,
  attestation,
}: {
  dim: string;
  us: string;
  centralized: string;
  attestation: string;
}) {
  return (
    <tr>
      <td className="px-4 py-3 font-medium text-[var(--fg)]">{dim}</td>
      <td className="px-4 py-3">{us}</td>
      <td className="px-4 py-3">{centralized}</td>
      <td className="px-4 py-3">{attestation}</td>
    </tr>
  );
}
