import type { Metadata } from "next";
import Link from "next/link";
import { PublicHeader } from "../../components/PublicHeader";
import { PublicFooter } from "../../components/PublicFooter";

export const metadata: Metadata = {
  title: "Terms — Senda",
  description:
    "The terms for using Senda during early access: as-is availability, acceptable use, prepaid API balance, contribution credits vs peer USD, refunds, and node responsibilities.",
};

const UPDATED = "July 27, 2026";

/**
 * /terms — short, honest terms of use that match the early-access reality:
 * as-is, no warranty, credits are illustrative (not cash, no token),
 * acceptable-use limits, and the responsibilities a node contributor takes
 * on. Plain-language, intentionally not over-lawyered for the stage.
 */
export default function TermsPage() {
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader variant="default" />

      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-3xl px-6 py-16 sm:py-20">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
            Terms
          </div>
          <h1 className="mt-3 text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            The deal, in plain language.
          </h1>
          <p className="mt-5 text-pretty text-base leading-relaxed text-[var(--fg-muted)]">
            By using Senda — the web chat, the API, or by running a node —
            you agree to the terms below. Senda is in early access and
            these will evolve with the product. Last updated {UPDATED}.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-3xl px-6 py-14">
          <div className="flex flex-col gap-10">
            <Clause title="Early access, provided as-is">
              <p>
                The mesh is live and under active development. Availability,
                latency, which models are served, and the feature set can
                change or break at any time. The service is provided
                &quot;as is&quot; and &quot;as available,&quot; without
                warranties of any kind. Don&apos;t rely on it for anything
                safety-, finance-, legal-, or health-critical.
              </p>
            </Clause>

            <Clause title="Model outputs">
              <p>
                Senda serves open-weight models. Their outputs can be
                inaccurate, incomplete, or offensive, and do not constitute
                professional advice. You&apos;re responsible for reviewing and
                how you use anything the models generate.
              </p>
            </Clause>

            <Clause title="Acceptable use">
              <p>You agree not to use Senda to:</p>
              <ul className="list-disc space-y-2 pl-5">
                <li>break the law or generate content that is illegal where you are;</li>
                <li>
                  attack, overload, or disrupt the mesh, the entry node, or any
                  peer — including attempts to de-anonymize peers or users;
                </li>
                <li>
                  generate content that exploits or harms minors, or that
                  facilitates serious harm to people;
                </li>
                <li>
                  misrepresent the source of a model&apos;s output or
                  circumvent the verification and routing controls.
                </li>
              </ul>
            </Clause>

            <Clause title="Paid API preview (prepaid balance)">
              <p>
                The{" "}
                <Link href="/buy" className="text-[var(--accent)] hover:underline">
                  paid API preview
                </Link>{" "}
                lets you top up a prepaid API balance in USDC on Solana and spend
                it on{" "}
                <code className="text-[var(--fg)]">/v1</code> inference. Free
                web chat remains free. The preview is experimental: rates, models,
                availability, and settlement timing can change. Prepaid balance is
                a service credit for inference — not an investment, deposit
                account, or crypto token issued by Senda.
              </p>
              <p>
                You are responsible for sending the correct asset (USDC) on Solana
                mainnet to the published treasury address. Wrong-chain or
                wrong-token transfers may be unrecoverable. Deposit attribution
                and refunds depend on network confirmation and our ops process.
              </p>
            </Clause>

            <Clause title="Refunds">
              <p>
                You may request a refund of unused prepaid API balance (subject
                to a minimum threshold shown on /buy). Refunds return USDC to a
                Solana wallet you control. During preview, refunds are processed
                manually or semi-automatically and are not instant. Amounts
                already spent on completed or in-flight inference are not
                refundable. We may refuse or delay refunds that look abusive,
                erroneous, or legally restricted.
              </p>
            </Clause>

            <Clause title="Contribution credits vs peer USD">
              <p>
                Contributors accumulate{" "}
                <Link href="/contribute" className="text-[var(--accent)] hover:underline">
                  contribution credits
                </Link>{" "}
                for completion tokens served to the mesh. Those credits remain
                illustrative during early access — they are{" "}
                <span className="text-[var(--fg)]">not cash</span>, not a
                financial instrument, and not a crypto token, and carry no
                guarantee of monetary value.
              </p>
              <p>
                Separately, when a peer serves a <em>paid</em>{" "}
                <code className="text-[var(--fg)]">/v1</code> request, we may
                accrue a peer USD liability toward a future USDC payout. Peer
                payouts are a preview capability: thresholds, timing, tax/KYC
                requirements, and availability can change, and there is{" "}
                <span className="text-[var(--fg)]">no guarantee</span> that
                accrued peer USD will be paid on any schedule until we say
                payouts are generally available.
              </p>
            </Clause>

            <Clause title="If you run a node">
              <p>
                Running a node is voluntary and at your own risk. You are
                responsible for your own hardware, electricity, network, and
                for complying with the laws that apply to you — including any
                tax reporting if you later receive payouts. By serving the
                mesh you accept that other users&apos; prompts will be processed
                on your machine to generate responses. You can stop serving at
                any time.
              </p>
            </Clause>

            <Clause title="Limitation of liability">
              <p>
                To the maximum extent permitted by law, Senda and its
                contributors are not liable for any indirect, incidental, or
                consequential damages, or for any loss arising from your use of
                the service, the mesh, model outputs, or running a node.
              </p>
            </Clause>

            <Clause title="Changes">
              <p>
                We may change, suspend, or discontinue any part of the service,
                and we may update these terms — the date above reflects the
                latest version. Continued use after a change means you accept
                it. Questions: open an issue on{" "}
                <a
                  href="https://github.com/senda-network/senda-llm"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[var(--accent)] hover:underline"
                >
                  GitHub
                </a>
                . See also our{" "}
                <Link href="/privacy" className="text-[var(--accent)] hover:underline">
                  privacy policy
                </Link>
                .
              </p>
            </Clause>
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}

function Clause({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-[var(--fg-muted)]">
        {children}
      </div>
    </div>
  );
}
