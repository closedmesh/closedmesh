---
name: closedmesh-infra
description: ClosedMesh infrastructure map, deploy flows, and environment variables. Use whenever deploying, releasing, or debugging any part of the ClosedMesh stack — website, desktop app, runtime, or entry node.
---

# ClosedMesh Infrastructure

## Repository access policy — READ FIRST

**The ONLY GitHub repositories you may interact with are the ones under the `closedmesh/` organization.** No exceptions. This applies to every tool: `git`, `gh`, the GitHub MCP, `curl` to api.github.com — anything.

The only two allowed repos:

| Repo | What it is | Local path |
|------|-----------|-----------|
| `closedmesh/closedmesh` | Next.js public site + Tauri desktop app | `/Users/al/apps/closedmesh` |
| `closedmesh/closedmesh-llm` | Rust runtime binary + Docker entry node | `/Users/al/apps/closedmesh-llm` |

### Do NOT touch (ever — not read, not fetch, not query)

- `Mesh-LLM/mesh-llm` — historical public upstream of `closedmesh-llm`. Any `gh` auto-resolution to this repo is a bug, not a feature.
- `michaelneale/mesh-llm` — transferred/renamed predecessor of the above; same rule applies.
- Any other fork, mirror, or upstream you discover in git remotes or config.

### Rules for `gh` and other GitHub tooling

1. **Always scope `gh` explicitly:** pass `-R closedmesh/closedmesh` or `-R closedmesh/closedmesh-llm` on every invocation. Never rely on `gh`'s auto-resolution — the `closedmesh-llm` checkout was previously configured with an `upstream` remote that made `gh` resolve to `Mesh-LLM/mesh-llm` silently.
2. **Local `.git/config` is locked down:** `/Users/al/apps/closedmesh-llm/.git/config` has `upstream` remote removed and `gh-resolved = base` pinned to `origin` (= `closedmesh/closedmesh-llm`). Do not add `upstream` or any non-`closedmesh/` remote back.
3. **Before any `gh` call, confirm the target repo** either by `-R` flag or by reading the git config. If you can't confirm, don't run the command.
4. **Subagents inherit this rule.** When dispatching a shell/browser subagent for git or `gh` work, include the repo-access policy in the prompt and require explicit `-R closedmesh/<repo>` scoping.

---

## Services and where they run

| Service | Platform | URL |
|---------|----------|-----|
| Public website + API | **Vercel** (`closedmesh` project, `0xaliks-projects`) | https://closedmesh.com |
| Entry node (mesh gateway) | **AWS Lightsail** (`closedmesh-entry` instance) | https://mesh.closedmesh.com |
| Reverse proxy on Lightsail | **Caddy** (host, not Docker) | port 443 → container port 9337 |
| Mesh entry node process | **Docker** container `mesh-entry` on Lightsail | image `mesh-entry:latest` |

---

## Deploy flows

### Website (closedmesh.com)

> **Vercel does NOT auto-deploy on git push.** Always run manually.

```bash
cd /Users/al/apps/closedmesh
vercel --prod
```

Check existing deployments: `vercel ls`

### Desktop app (Tauri)

1. Bump version in **two files** (must match):
   - `desktop/Cargo.toml` → `version = "X.Y.Z"`
   - `desktop/tauri.conf.json` → `"version": "X.Y.Z"`
2. Commit and push to `main` on `closedmesh/closedmesh`
3. Push a `desktop-vX.Y.Z` **tag** — this is what triggers the build, NOT the branch push:
   ```bash
   git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z
   ```
4. GitHub Actions (`desktop-release.yml`) builds `.dmg` / installers (~10 min)

Current version: check `desktop/Cargo.toml`.

### Runtime binary (closedmesh-llm)

Releases are triggered by **`workflow_dispatch`** — NOT a tag push (the workflow creates the tag itself).

```bash
# Trigger via gh CLI (preferred):
gh -R closedmesh/closedmesh-llm workflow run release.yml \
  -f version=0.X.Y \
  -f prerelease=false \
  -f skip_gpu_bundles=false \
  -f target_branch=main

# Or via GitHub UI: Actions → Release → Run workflow
```

The workflow's `prepare_release` job bumps all `Cargo.toml` versions, commits to `main`, creates the tag, then build jobs run in parallel (~2.5h for Linux CUDA), and finally `Publish GitHub release` uploads the assets.

GitHub Actions (`release.yml`) uploads assets named `closedmesh-{os}-{arch}.tar.gz` (stable alias, always points to latest) and `closedmesh-v{version}-{os}-{arch}.tar.gz` (versioned, pinned to that release).

### Entry node Docker (Lightsail)

SSH into Lightsail, then:

```bash
# Pull latest image
docker pull ghcr.io/closedmesh/closedmesh-llm/mesh-entry:latest

# Stop and remove old container
docker stop mesh-entry && docker rm mesh-entry

# Start new container with stable iroh port
docker run -d \
  --name mesh-entry \
  --restart unless-stopped \
  --network host \
  -v /opt/closedmesh-data:/data \
  -e APP_MODE=console \
  -e MESH_AUTH_TOKEN=<token> \
  -e INTERNAL_PORT=9337 \
  -e CONSOLE_PORT=3131 \
  -e MESH_BIND_PORT=42140 \
  -e MESH_PUBLISH=true \
  ghcr.io/closedmesh/closedmesh-llm/mesh-entry:latest
```

**Critical**: `MESH_BIND_PORT=42140` keeps iroh on a fixed UDP port. Lightsail firewall has 40000-45000 open. Random ports break P2P connections.

---

## Environment variables

### Vercel (closedmesh.com)

| Variable | Value |
|----------|-------|
| `CLOSEDMESH_RUNTIME_URL` | `https://mesh.closedmesh.com/v1` |
| `CLOSEDMESH_ADMIN_URL` | `https://mesh.closedmesh.com` |
| `CLOSEDMESH_RUNTIME_TOKEN` | Bearer token (same as `MESH_AUTH_TOKEN` on Lightsail) |

> Set via `vercel env add VAR_NAME production`. **No trailing newlines** — Vercel has shipped env values with literal `\n` before, breaking URLs. Always trim when adding.

### GitHub Actions secrets (closedmesh repo)

| Secret | Used by |
|--------|---------|
| `CLOSEDMESH_RUNTIME_TOKEN` | `desktop-release.yml` — baked into desktop binary at build time |

### Lightsail Docker container

| Variable | Purpose |
|----------|---------|
| `MESH_AUTH_TOKEN` | Bearer token Caddy validates on all API requests |
| `MESH_BIND_PORT` | Fixed iroh QUIC port (must be 40000-45000) |
| `INTERNAL_PORT` | closedmesh API port inside container (9337) |
| `CONSOLE_PORT` | Admin console port (3131) |
| `MESH_PUBLISH` | Set `true` so entry node advertises itself to Nostr |

---

## Key files

| File | Purpose |
|------|---------|
| `desktop/src/mesh.rs` | `FALLBACK_JOIN_TOKEN` — update when entry node identity changes |
| `desktop/Cargo.toml` + `desktop/tauri.conf.json` | App version (must stay in sync) |
| `app/api/status/route.ts` | Public `/api/status` — aggregates mesh node + model data |
| `app/components/MeshLiveStatus.tsx` | Header status pill → links to `/status` |
| `app/(public)/status/page.tsx` | Live mesh status page |
| `closedmesh-llm/docker/entrypoint.sh` | Docker container startup, reads all env vars |
| `closedmesh-llm/docker/Caddyfile` | Auth-gated Caddy config for entry node |

---

## Common gotchas

- **Vercel does not auto-deploy.** Always run `vercel --prod` after pushing.
- **Version bump requires two files**: `Cargo.toml` AND `tauri.conf.json` — they must match or the build fails.
- **Entry node uses a fixed iroh port** (`MESH_BIND_PORT=42140`). If the container is recreated without this, iroh picks a random port that is likely blocked by the Lightsail firewall, breaking P2P connections and causing `3.210.30.58:0` in the join token.
- **`FALLBACK_JOIN_TOKEN` in `mesh.rs`** must be updated whenever the entry node container is recreated from scratch (iroh generates a new identity unless `/opt/closedmesh-data` is mounted and preserved).
- **Vercel env vars must have no trailing newlines.** Remove and re-add if URLs look broken (`mesh.closedmesh.com\n` is invalid).
- **Asset names are `closedmesh-{os}-{arch}.tar.gz`**, not `mesh-llm-*`. Desktop app `mesh.rs` expects exactly this pattern for auto-update.
- **`closedmesh-llm` CI runs `xtask repo-consistency`** — if asset names, fixture JSON, `RELEASE.md`, or `install.sh` disagree, CI fails before building.
