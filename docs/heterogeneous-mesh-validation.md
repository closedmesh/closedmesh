# Heterogeneous mesh end-to-end validation

This is the runbook for validating that the "any-hardware mesh nodes" stack
(packaging → service → capability gossip → router) works in real life. Run
this when shipping a new release that touches:

- the `closedmesh-llm` build matrix or release workflow
- `public/install.sh`, `public/install.ps1`, or any service-install path
- the capability gossip schema, probe, or filter
- the status API / control panel surfacing

The validation phases below mirror the plan stages and are designed so you
can stop at the highest passing phase if you can't physically assemble all
four boxes.

## Hardware

| Role | Machine | Backend |
| ---- | ------- | ------- |
| A    | M-series Mac (any team Mac)        | metal   |
| B    | Linux box with NVIDIA GPU (≥16 GB) | cuda    |
| C    | Windows 10/11 laptop with Intel/AMD/older GPU | vulkan |
| D    | CPU-only Linux box (any laptop, no discrete GPU) | cpu |

If you don't have all four, the most informative subset is **A + B + D** —
A and B prove cross-OS, cross-vendor mesh chat works, and D proves the
capability filter actually excludes nodes that can't serve a request.

You will also need:

- A model the team uses every day (e.g. `Qwen3-8B-Q4_K_M`, ~5 GB).
- A "deliberately too big" model (e.g. `Llama-3-70B-Instruct-Q4_K_M`,
  ~40 GB) installed on **A only**, used to force a `no_capable_node` 503.

## Phase 0 — sanity checks (single machine, ~5 min)

Run on any one machine that already has a built `closedmesh` binary.

```bash
# from the closedmesh repo
./scripts/smoke-capability.sh
```

Expected: prints `backend`, `vendor`, `vram_total_mb`, `compute_class`,
`peer_count`. Exit code 0.

If `backend` is wrong (e.g. `cpu` on a CUDA box), check
[`closedmesh-llm`'s build target](../../closedmesh-llm/scripts/release-closedmesh.sh)
or the `CLOSEDMESH_BACKEND` env override before continuing.

## Phase 1 — packaging (~30 min)

For each of A/B/C/D, run the appropriate one-liner:

```bash
# A (macOS arm64), B (Linux/CUDA), D (Linux/CPU):
curl -fsSL https://closedmesh.com/install | sh
```

```powershell
# C (Windows):
iwr -useb https://closedmesh.com/install.ps1 | iex
```

Expected on each machine:

- Installer exits 0.
- `closedmesh --version` works in a fresh shell.
- The matched archive in the install log corresponds to the node's actual
  hardware:
  - A → `darwin-aarch64`
  - B → `linux-x86_64-cuda`
  - C → `windows-x86_64-vulkan` (or `cuda` if it has an NVIDIA GPU)
  - D → `linux-x86_64-cpu`

Negative test on D: set `CLOSEDMESH_BACKEND=cuda` in the install env and
re-run. The installer should download the CUDA archive **but** running
`closedmesh serve` will fail at startup because there's no CUDA runtime.
This proves the override works as documented in `README.md`.

## Phase 2 — service auto-start (~15 min)

```bash
# A, B, D:
curl -fsSL https://closedmesh.com/install | sh -s -- --service
closedmesh service status   # ⇒ "running"
```

```powershell
# C:
iwr -useb https://closedmesh.com/install.ps1 | iex; closedmesh-install -Service
closedmesh service status   # ⇒ "running"
```

Reboot each machine. After login, run `closedmesh service status` again
and confirm the runtime came back up on its own. Then on each machine run:

```bash
./scripts/smoke-capability.sh
```

Confirm `backend` matches expectations.

## Phase 3 — mesh formation + capability filter (~30 min)

Pick A as the "host" — that's where you'll join from for the chat UI.

1. On A, run `closedmesh serve --private-only` (if not already a service)
   and grab the invite token from its first-run output (or
   `closedmesh service logs`).

2. On B, C, D, in turn:

   ```bash
   closedmesh serve --join <invite-token>
   ```

3. On A, hit:

   ```bash
   curl -s http://localhost:3131/api/status | jq '.peers | length'
   ```

   Expected: `3` (B, C, D have all joined).

4. Open `http://localhost:3000/control` on A and switch to the **Nodes**
   tab. You should see four rows: `self` (A) plus B, C, D, each with the
   correct `backend`, `vendor`, and VRAM.

5. Hover the status pill in the chat header (`http://localhost:3000`).
   Same four nodes should appear in the hover panel.

### Capability filter proof

The point of the filter is: a CPU-only node never gets a 70B request.

1. On A, send a chat asking for `Llama-3-70B-Instruct-Q4_K_M`. (Use the
   chat UI's model picker, or hit `/api/chat` directly with `"model":
   "Llama-3-70B-Instruct-Q4_K_M"`.) **Only A has the model file**.

2. Inference runs on A (because A is the only node serving that model).
   D's capability gets checked but D's VRAM is 0, so the router never
   even considers it for pipeline-parallel.

3. Now stop A's runtime (`closedmesh service stop`). The mesh now has
   only B, C, D, none of which serve `Llama-3-70B`. Send the same chat
   request again from any node's chat UI.

   Expected: the chat UI shows the friendly amber "No node in the mesh
   can serve that model" panel — not a generic 500. Confirm by hitting
   `/api/chat` directly:

   ```bash
   curl -i -s -X POST http://localhost:3000/api/chat \
       -H 'content-type: application/json' \
       -d '{"messages":[{"role":"user","content":"hi"}],"model":"Llama-3-70B-Instruct-Q4_K_M"}'
   ```

   Expected: HTTP 503, body contains `"reason_code":"no_capable_node"`.

4. Restart A. Within ~10 s the next chat should succeed again.

## Phase 4 — boss's GPU (~10 min)

The motivating use case: a teammate with a GPU we've never seen joins the
mesh and Just Works.

1. On the boss's machine, run the appropriate installer one-liner.
2. Confirm the right archive was selected (CUDA on NVIDIA, ROCm on AMD,
   Vulkan otherwise) — visible in the installer output.
3. `closedmesh serve --join <invite-token>` from the team mesh.
4. On A, refresh `/control` → Nodes. Boss's machine should appear with
   correct backend / vendor / VRAM.
5. Run a chat that needs the GPU's VRAM (e.g. a model only that machine
   can serve solo). Confirm the request is dispatched there by watching
   `closedmesh service logs` on the boss's box.

If any of the above fails, the most useful diagnostic command is:

```bash
curl -s http://localhost:3131/api/status | jq '.'
```

It returns the full capability payload for self + every peer, which is
exactly what the router uses to make filtering decisions.

## What "passing" means

- Phase 1 produces a working binary on each platform.
- Phase 2 brings each runtime back up automatically across reboots.
- Phase 3 demonstrates the mesh forms across OS/vendor boundaries and
  the structured 503 surfaces a friendly UI on `no_capable_node`.
- Phase 4 closes the loop: a real, non-team GPU joined and was used.
