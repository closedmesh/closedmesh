import type { Metadata } from "next";
import { HomepageChat } from "./HomepageChat";
import { MeshLiveStatus } from "../components/MeshLiveStatus";
import { PublicHeader } from "../components/PublicHeader";

export const metadata: Metadata = {
  title: "ClosedMesh — your private LLM, on hardware people own",
  description:
    "A peer-to-peer mesh of contributed machines, running open-weight models. No third-party API in the middle. Use the chat or run a node.",
};

/**
 * Public homepage at https://closedmesh.com/.
 *
 * Two audiences land on this page and the framing has to work for both:
 *
 *   1. Someone who just wants a private LLM chat. Their question is "is
 *      this trustworthy and does it work?" — answered by leading with
 *      "private LLM mesh" + a live indicator showing the mesh is actually
 *      serving real models, plus the chat composer right there.
 *
 *   2. Someone who has a GPU or laptop and might lend compute. Their
 *      question is "what is this thing I'd be joining?" — answered by
 *      the same headline (mesh, peer-to-peer, hardware) and a clear
 *      pointer to /download from the empty state.
 *
 * We deliberately don't lead with anything price-related. The economics
 * may change; the architecture won't.
 *
 * The page itself stays a Server Component for static metadata; the
 * interactive chat + empty-state suggestion tiles live in HomepageChat,
 * which is marked "use client" because suggestion onClick needs a
 * function prop that can't cross the server/client boundary.
 */
export default function PublicHomePage() {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--bg)] text-[var(--fg)]">
      <PublicHeader status={<MeshLiveStatus variant="header" />} />

      <main className="flex flex-1 flex-col">
        <HomepageChat />
      </main>
    </div>
  );
}
