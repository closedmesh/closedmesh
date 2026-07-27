import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";

export const metadata: Metadata = {
  title: "Developer docs — Senda",
  description:
    "Build on Senda with an OpenAI-compatible API. Run a node and call your local runtime today, or list what the hosted mesh is serving right now. Honest about what's open in early access and what's gated.",
};

/**
 * /docs — the developer surface.
 *
 * The site sells an "OpenAI-compatible API" on the homepage and /about but
 * never showed anyone how to call it. This page closes that gap, and stays
 * honest about the early-access reality (see the access-paths table): the
 * fully-open, works-today path is running a node and hitting your own local
 * runtime; the hosted entry exposes `/v1/models` openly but gates
 * `/v1/chat/completions` until the Phase 5 paid API ships public keys.
 */
export default function DocsPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />

      {/* Hero */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
          <div className="max-w-3xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
              Developer docs
            </div>
            <h1 className="mt-3 text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
              OpenAI-compatible.
              <span className="block text-[var(--fg-muted)]">
                Point your existing client at the mesh.
              </span>
            </h1>
            <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-[var(--fg-muted)] sm:text-lg">
              Every Senda peer exposes a standard{" "}
              <code className="font-mono text-[var(--fg)]">
                /v1/chat/completions
              </code>{" "}
              endpoint. Anything that speaks the OpenAI API — the official
              SDKs, LangChain, your own scripts — works by changing one base
              URL. Below is exactly how, and an honest map of what&apos;s open
              today versus what arrives with the paid API.
            </p>
          </div>
        </div>
      </section>

      {/* Access paths — the honest state */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="mb-8 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              Three ways to reach the API
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              What&apos;s open today.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              Senda is in early access, so the surfaces aren&apos;t all
              equally open yet. The fully-open path that works right now is
              running a node and calling your own local runtime — same code,
              same model quality, and the prompt never leaves your machine.
            </p>
          </div>

          <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg-elev-2)] text-left text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
                <tr>
                  <th className="px-5 py-3">Path</th>
                  <th className="px-5 py-3">Base URL</th>
                  <th className="px-5 py-3">Auth</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-[var(--border)]">
                  <td className="px-5 py-4 font-medium">
                    Local node
                    <div className="text-[12px] font-normal text-[var(--fg-muted)]">
                      run the runtime yourself
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-[12px]">
                    http://localhost:9337/v1
                  </td>
                  <td className="px-5 py-4 text-[var(--fg-muted)]">None</td>
                  <td className="px-5 py-4">
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300">
                      Open now
                    </span>
                  </td>
                </tr>
                <tr className="border-t border-[var(--border)]">
                  <td className="px-5 py-4 font-medium">
                    Hosted mesh
                    <div className="text-[12px] font-normal text-[var(--fg-muted)]">
                      the public entry node
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-[12px]">
                    https://entry.senda.network/v1
                  </td>
                  <td className="px-5 py-4 text-[var(--fg-muted)]">
                    Bearer key
                  </td>
                  <td className="px-5 py-4">
                    <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[11px] text-amber-200">
                      Models open · chat gated
                    </span>
                  </td>
                </tr>
                <tr className="border-t border-[var(--border)]">
                  <td className="px-5 py-4 font-medium">
                    Paid API
                    <div className="text-[12px] font-normal text-[var(--fg-muted)]">
                      USDC credits + ck_ key
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-[12px]">
                    https://senda.network/v1
                  </td>
                  <td className="px-5 py-4 text-[var(--fg-muted)]">
                    Bearer ck_…
                  </td>
                  <td className="px-5 py-4">
                    <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300">
                      Open — top up at /buy
                    </span>
                  </td>
                </tr>
                <tr className="border-t border-[var(--border)]">
                  <td className="px-5 py-4 font-medium">
                    Web chat
                    <div className="text-[12px] font-normal text-[var(--fg-muted)]">
                      zero setup, not the API
                    </div>
                  </td>
                  <td className="px-5 py-4 font-mono text-[12px]">
                    senda.network
                  </td>
                  <td className="px-5 py-4 text-[var(--fg-muted)]">None</td>
                  <td className="px-5 py-4">
                    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--fg-muted)]">
                      Open now
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-[var(--fg-muted)]">
            Buy USDC credits and mint a key at{" "}
            <Link href="/buy" className="text-[var(--accent)] hover:underline">
              /buy
            </Link>
            , then call{" "}
            <code className="font-mono">senda.network/v1/chat/completions</code>.
            The entry node{" "}
            <code className="font-mono">entry.senda.network</code> stays
            operator-gated; local nodes remain free for self-host. Free web
            chat is unchanged.
          </p>
        </div>
      </section>

      {/* Quickstart */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="mb-8 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              Quickstart
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Call it in three lines.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              These examples target a local node at{" "}
              <code className="font-mono">http://localhost:9337/v1</code>.{" "}
              <Link
                href="/download"
                className="text-[var(--accent)] hover:underline"
              >
                Install the desktop app or curl the runtime
              </Link>{" "}
              first — it autostarts and joins the mesh. Swap the base URL for
              the hosted entry once you have a key.
            </p>
          </div>

          <div className="flex flex-col gap-6">
            <Block label="List the models this node can serve" lang="bash">
              {`curl http://localhost:9337/v1/models`}
            </Block>

            <Block label="Chat completion · curl" lang="bash">
              {`curl http://localhost:9337/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "Qwen3-8B",
    "messages": [
      { "role": "user", "content": "Summarize peer-to-peer inference in two sentences." }
    ]
  }'`}
            </Block>

            <Block label="Python · the official openai SDK" lang="python">
              {`from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:9337/v1",
    api_key="not-needed",  # local node is unauthenticated
)

resp = client.chat.completions.create(
    model="Qwen3-8B",
    messages=[{"role": "user", "content": "Classify: 'battery great, screen dim'."}],
)
print(resp.choices[0].message.content)`}
            </Block>

            <Block label="JavaScript / TypeScript · the openai package" lang="javascript">
              {`import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:9337/v1",
  apiKey: "not-needed",
});

const resp = await client.chat.completions.create({
  model: "Qwen3-8B",
  messages: [{ role: "user", content: "Extract every date: shipped 2026-01-09." }],
});
console.log(resp.choices[0].message.content);`}
            </Block>

            <Block label="Streaming · ask for token usage too" lang="python">
              {`stream = client.chat.completions.create(
    model="Qwen3-8B",
    messages=[{"role": "user", "content": "Write a haiku about latency."}],
    stream=True,
    stream_options={"include_usage": True},  # needed for usage stats
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)`}
            </Block>
          </div>
        </div>
      </section>

      {/* Discover the live mesh */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="mb-8 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              Discover what&apos;s live
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              The model set changes as peers come and go.
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
              There&apos;s no fixed model list — it&apos;s whatever live peers
              are serving. Two open, no-auth endpoints tell you what&apos;s
              routable right now, so you can pick a{" "}
              <code className="font-mono">model</code> that actually exists.
            </p>
          </div>

          <div className="flex flex-col gap-6">
            <Block label="What the hosted mesh can serve (OpenAI shape)" lang="bash">
              {`curl https://entry.senda.network/v1/models`}
            </Block>
            <Block label="Live mesh status — nodes online + routable models" lang="bash">
              {`curl https://senda.network/api/status`}
            </Block>
          </div>
        </div>
      </section>

      {/* Notes */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="mb-8 max-w-2xl">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--fg-muted)]">
              Good to know
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">
              Notes for building against the mesh.
            </h2>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Note title="It's a real OpenAI-compatible surface">
              Chat completions, streaming (SSE), and model listing follow the
              OpenAI schema. Most SDKs and agent frameworks need only the base
              URL changed.
            </Note>
            <Note title="Latency-tolerant by design">
              The mesh targets summarization, classification, extraction, and
              background agent work — not shaving a second off a single reply.
              Set generous client timeouts and prefer batched / async calls.
            </Note>
            <Note title="Ask for usage when streaming">
              Pass{" "}
              <code className="font-mono">
                stream_options.include_usage = true
              </code>{" "}
              or the final chunk omits token counts — and the per-model
              throughput catalog on{" "}
              <Link href="/status" className="text-[var(--accent)] hover:underline">
                /status
              </Link>{" "}
              can&apos;t record a sample.
            </Note>
            <Note title="Run your own for full control">
              The endpoint a hosted peer exposes is the same one your local
              runtime exposes. For anything you don&apos;t want to route
              through someone else, run a node and keep the whole loop on your
              hardware.
            </Note>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section>
        <div className="mx-auto max-w-5xl px-6 py-16 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Run a node, get the API.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-[var(--fg-muted)]">
            The fastest path to programmatic access today is your own node —
            full quality, no key, nothing leaves your machine.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/download"
              className="rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_6px_18px_-10px_rgba(26,157,95,0.7)] transition hover:brightness-110"
            >
              Run a node
            </Link>
            <a
              href="https://github.com/senda-network/senda-llm"
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] px-5 py-2.5 text-sm font-medium text-[var(--fg)] transition hover:bg-[var(--bg-elev-2)]"
            >
              Runtime on GitHub
            </a>
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}

function Block({
  label,
  lang,
  children,
}: {
  label: string;
  lang: string;
  children: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)]">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
        <span className="text-[12px] text-[var(--fg-muted)]">{label}</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--fg-muted)]">
          {lang}
        </span>
      </div>
      <pre className="overflow-x-auto px-4 py-4 text-[12.5px] leading-relaxed">
        <code className="font-mono text-[var(--fg)]">{children}</code>
      </pre>
    </div>
  );
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-elev)] p-6">
      <div className="text-[14px] font-semibold tracking-tight">{title}</div>
      <p className="mt-2 text-[14px] leading-relaxed text-[var(--fg-muted)]">
        {children}
      </p>
    </div>
  );
}
