# sidecar/ — bundled controller + Node.js runtime

This directory holds the two artefacts the Tauri shell embeds in each
platform installer (see [`../SIDECAR.md`](../SIDECAR.md) for the full
design):

```
sidecar/
├── controller/        ← Next.js standalone bundle (server.js + .next/ + public/)
└── binaries/
    ├── node-aarch64-apple-darwin
    ├── node-x86_64-unknown-linux-gnu
    └── node-x86_64-pc-windows-msvc.exe
```

Both are **generated**, not checked in (see `.gitignore`). They get
populated at build time by:

- `scripts/stage-controller.sh` — runs `next build` in the repo root,
  copies `.next/standalone/` + `.next/static/` + `public/` here.
- `scripts/fetch-node.sh` — downloads the official Node.js LTS binary
  for the current target triple (or `--target=...`), unpacks it, and
  drops the `node` executable here with the right name suffix that
  `bundle.externalBin` in `tauri.conf.json` expects.

Local dev: `desktop/scripts/build.sh` calls both. CI: each matrix job
in `desktop-release.yml` calls them with the right `--target`.

If you nuke the folder by accident, just rerun `desktop/scripts/build.sh`
— it's idempotent and only re-fetches what's missing.
