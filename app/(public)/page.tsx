import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { HeroChat } from "./HomepageChat";
import { MeshLiveStatus } from "../components/MeshLiveStatus";
import { PublicHeader } from "../components/PublicHeader";
import { PublicFooter } from "../components/PublicFooter";
import {
  ArchitectureDiagram,
  ArtBand,
  Feature,
  FitCard,
  NumberedStep,
} from "../components/marketing";
import { AppShowcase } from "../components/AppShowcase";

export const metadata: Metadata = {
  title: "Senda — open-source AI, served by the people",
  description:
    "A peer-to-peer network for open language models: reach the network through an OpenAI-compatible API, or run the Senda app and serve models yourself. Peers by default; rare uptime fallback may use an external provider.",
};

/**
 * Public homepage at https://senda.network/.
 *
 * Redesigned from a full-viewport chat into a scrollable marketing page
 * that explains the product up front, while keeping the instant-try hook:
 * the hero carries a collapsed composer (HeroChat) that expands into the
 * full chat surface the moment a visitor interacts with it. No "open chat"
 * detour, no signup.
 *
 * Two audiences land here and the page serves both: someone who wants
 * open models on community hardware by default (hero + chat + "what it's
 * for" + FAQ), and someone with spare hardware who might contribute (the
 * two-sided section + "run a node" CTAs). We deliberately don't lead with
 * anything price-related — the economics may change; the architecture won't.
 *
 * Long-form technical depth (full hardware matrix, the two-layer
 * architecture writeup, every why-a-mesh property) still lives on /about;
 * this page carries condensed versions and links there.
 */
export default function PublicHomePage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader status={<MeshLiveStatus variant="header" />} />

      <main>
        {/* Hero — headline + chat; artwork feathers in below */}
        <section
          id="top"
          className="relative flex min-h-[calc(100svh-8.5rem)] flex-col border-b border-[var(--border)]"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[42%] min-h-[11rem] sm:h-[46%] sm:min-h-[13rem]"
          >
            <div className="absolute inset-0 theme-light-only">
              <Image
                src="/senda-hero.png"
                alt=""
                fill
                priority
                sizes="100vw"
                className="object-cover object-center"
              />
            </div>
            <div className="absolute inset-0 theme-dark-only">
              <Image
                src="/senda-hero-dark.png"
                alt=""
                fill
                priority
                sizes="100vw"
                className="object-cover object-center"
              />
            </div>
            <div
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(to bottom, var(--bg) 0%, transparent 28%, transparent 88%, var(--bg) 100%)",
              }}
            />
          </div>

          <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-12 text-center sm:py-16">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Peer-to-peer LLM network
            </div>
            <h1 className="mt-3 text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
              Open-source AI,
              <span className="block text-[var(--fg-muted)]">
                served by the people.
              </span>
            </h1>
            <p className="mx-auto mt-4 max-w-md text-pretty text-[15px] text-[var(--fg-muted)]">
              A network of machines serving open models. Run the app to add
              yours, or reach the whole network through one OpenAI-compatible
              API. Peers by default; rare uptime fallback may use an external
              provider.
            </p>
            <div className="mx-auto mt-7 w-full max-w-2xl">
              <HeroChat />
            </div>
          </div>

          <div className="relative z-10 h-28 shrink-0 sm:h-36" aria-hidden />
        </section>

        {/* How it works */}
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
                Anyone can use the network — through an OpenAI-compatible API,
                or the chat on senda.network — without running anything
                themselves. The models are served by peers who run the Senda app
                on their own hardware. Anyone can do one, both, or neither.
              </p>
            </div>

            <ArchitectureDiagram />

            <div className="mt-10 grid gap-4 sm:grid-cols-3">
              <NumberedStep
                n={1}
                title="Send a request"
                body="A call to an OpenAI-compatible endpoint — from your code, an agent, or the chat on senda.network. Streamed response, no account, nothing to install."
              />
              <NumberedStep
                n={2}
                title="Mesh entry"
                body="Requests land at the public mesh entry point and are routed to a peer that can serve the requested model — by capability, by load, by latency."
              />
              <NumberedStep
                n={3}
                title="Compute peers"
                body="Volunteered nodes running Senda LLM serve each session end-to-end on whichever peer fits the model, and the router auto-routes around offline ones. A model too big for any single peer can be split across several."
              />
            </div>
          </div>
        </section>

        {/* Artwork — requests routed between peer clusters through the entry */}
        <ArtBand
          src="/senda-mesh.png"
          srcDark="/senda-mesh-dark.png"
          alt="Two glowing clusters of connected nodes linked by curved luminous lines passing through a central node"
        />

        {/* The app — real product screenshots */}
        <section id="app" className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-5xl px-6 py-20">
            <div className="mb-10 max-w-2xl">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
                The app
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                Put your machine on the mesh.
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
                The Senda app joins the peer-to-peer mesh on install: your
                hardware serves what it can, and you chat with what the mesh
                serves. Manage models, watch peers, and talk to live open-weight
                models — one native app for macOS, Windows, and Linux.
              </p>
            </div>
            <AppShowcase />
          </div>
        </section>

        {/* Why a mesh — condensed from /about's full property grid */}
        <section className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-5xl px-6 py-20">
            <div className="mb-10 max-w-2xl">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
                Why a mesh
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                Capacity is everywhere. Senda just uses it.
              </h2>
            </div>

            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              <Feature
                title="Peers by default"
                body="Your prompt goes to a peer running an open-weight model on contributed hardware. Rare uptime fallback may use an external provider so the API stays sellable — the default path is the mesh."
              />
              <Feature
                title="Apple Silicon carries a lot of it"
                body="An M3 Max or M4 Max with 64–128 GB of unified memory can serve 30B–70B-class models at full quality — competitive with, and often ahead of, same-price Windows GPU boxes for large models. CUDA / ROCm / Vulkan machines join too; each fits different model sizes."
              />
              <Feature
                title="One peer, end to end"
                body="A model that fits on one peer runs there start to finish — full quality, no per-token network hops. Splitting a model across peers exists as a fallback for models no single peer can hold."
              />
              <Feature
                title="Peers are verified"
                body="The mesh checks that a peer actually runs the model it advertises: each publishes a deterministic fingerprint and the network re-runs an unpredictable synthetic probe to compare. A peer can't claim a big model while quietly serving a smaller one. Real prompts are never replayed."
              />
              <Feature
                title="OpenAI-compatible"
                body="Every peer exposes a standard /v1/chat/completions endpoint. Drop-in for any tool that speaks OpenAI — agents, IDE plugins, internal scripts."
              />
              <Feature
                title="Run your own peer"
                body="The peer serving your session reads your prompt. Don't want to trust someone else's box? Run the same open-source runtime yourself — the mesh, on hardware you control. Share it, rent it, or keep it entirely in-house."
              />
            </div>
          </div>
        </section>

        {/* Artwork — a glowing trail routing through peers over topographic terrain */}
        <ArtBand
          src="/senda-capacity.png"
          srcDark="/senda-capacity-dark.png"
          alt="A glowing green trail winding across topographic contour lines, dotted with luminous waypoint nodes linked into a mesh"
        />

        {/* Two-sided progression — chat / contribute / earn */}
        <section className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-5xl px-6 py-20">
            <div className="mb-10 max-w-2xl">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
                Two sides
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                Use the mesh. Or become part of it.
              </h2>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <LaneCard
                step="Use"
                title="Build on the network"
                body="Chat free on senda.network, or use the paid API preview: OpenAI-compatible /v1 with a key. Requests go to mesh peers by default; rare uptime fallback may use an external provider."
                cta={{ label: "API preview →", href: "/buy" }}
              />
              <LaneCard
                step="Contribute"
                title="Run a node"
                body="Have a capable Mac or GPU box? Download the desktop app or curl the runtime. It joins the mesh and adds capacity for everyone."
                cta={{ label: "Contribute →", href: "/contribute" }}
              />
              <LaneCard
                step="Earn"
                title="Contributor credits"
                body="Nodes track contributor credits for tokens served. Paid /v1 mesh serves may also accrue peer USD — bind a wallet in the desktop app to request payout. Separate from the customer API balance."
                cta={{ label: "How credits work →", href: "/contribute#earn" }}
              />
            </div>
          </div>
        </section>

        {/* What it's for */}
        <section className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-5xl px-6 py-20">
            <div className="mb-10 max-w-2xl">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
                What it&apos;s for
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                Built for the work you keep in-house.
              </h2>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
                Senda is low-cost inference on open-weight models, served by the
                mesh instead of a hosted AI API. It&apos;s for teams where
                keeping data off third-party providers and keeping per-token
                costs flat matter more than shaving a second off every reply.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <FitCard
                title="Great fit"
                items={[
                  "Summarizing documents and codebases",
                  "Classifying or labeling data at scale",
                  "Long-running background agents and pipelines",
                  "Synthetic-data generation",
                  "Anything private or high-volume where an instant answer isn't the point",
                ]}
              />
              <FitCard
                title="Why it holds up"
                items={[
                  "Peers by default — your prompt goes to a mesh peer; rare uptime fallback may use an external provider",
                  "Yours to control — run your own peer on hardware you own, not a rented black-box endpoint",
                  "No lock-in — OpenAI-compatible API, fully open-source runtime",
                  "Verified peers — each one proves it runs the model it advertises",
                ]}
              />
            </div>
          </div>
        </section>

        {/* FAQ — native <details>, no client JS needed */}
        <section className="border-b border-[var(--border)]">
          <div className="mx-auto max-w-3xl px-6 py-20">
            <div className="mb-10">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
                FAQ
              </div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
                The questions people ask first
              </h2>
            </div>

            <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">
              <FaqItem
                q="What is Senda?"
                a="A peer-to-peer mesh that runs open-weight models on hardware contributors already own. Reach it through an OpenAI-compatible API — or the chat on senda.network — and a capability-aware router sends each request to a peer that can serve it. Peers by default; rare uptime fallback may use an external provider."
              />
              <FaqItem
                q="Do I need to sign up or install anything to chat?"
                a="No. Open senda.network and start typing — no account, no install. The desktop app is only needed if you want to run a node and contribute compute."
              />
              <FaqItem
                q="Can a peer read my prompts?"
                a="The peer serving your session has to read the prompt to run inference — that's the honest trade versus a hosted API. The runtime is open source so peers can be audited, sessions aren't tied to an identity, and for anything you don't want to trust to others, you can run your own peer with the same runtime."
              />
              <FaqItem
                q="Which models can I use?"
                a="Open-weight models served by live peers — the set changes as peers come and go, which is why the live status above lists what's serving right now. Apple Silicon Macs with enough memory can serve 30B–70B-class models at full quality; smaller machines serve smaller models well."
              />
              <FaqItem
                q="What hardware can contribute?"
                a="Apple Silicon Macs (Metal), and NVIDIA (CUDA), AMD (ROCm) or Intel/other (Vulkan) GPU boxes on macOS, Linux, or Windows. The installer detects your OS, CPU architecture and GPU vendor and pulls the matching build."
              />
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section>
          <div className="mx-auto max-w-5xl px-6 py-20 text-center">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Use the network, or help run it.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-[var(--fg-muted)]">
              Build on it through the API, try it in your browser, or add your
              machine and grow the network for everyone.
            </p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="#top"
                className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_6px_18px_-10px_rgba(26,157,95,0.7)] transition hover:brightness-110"
              >
                Try the mesh
              </Link>
              <Link
                href="/download"
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-5 py-2.5 text-sm font-medium text-[var(--fg)] transition hover:bg-[var(--bg-elev-2)]"
              >
                Run a node
              </Link>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}

function LaneCard({
  step,
  title,
  body,
  cta,
  muted,
}: {
  step: string;
  title: string;
  body: string;
  cta: { label: string; href: string };
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-7">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
        {step}
        {muted && (
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[9px] tracking-normal text-[var(--fg-muted)]">
            coming
          </span>
        )}
      </div>
      <div className="mt-2 text-lg font-semibold tracking-tight">{title}</div>
      <p className="mt-2 flex-1 text-[14px] leading-relaxed text-[var(--fg-muted)]">
        {body}
      </p>
      <Link
        href={cta.href}
        className="mt-5 text-[13px] text-[var(--accent)] hover:underline"
      >
        {cta.label}
      </Link>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-left text-[15px] font-medium text-[var(--fg)] [&::-webkit-details-marker]:hidden">
        {q}
        <span
          aria-hidden
          className="shrink-0 text-[var(--fg-muted)] transition group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <p className="pb-5 text-[14px] leading-relaxed text-[var(--fg-muted)]">
        {a}
      </p>
    </details>
  );
}
