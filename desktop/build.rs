// build.rs — Tauri's standard build hook plus a single extra: forward the
// `TARGET` env var that Cargo passes to build scripts through to the
// compiled binary as `CLOSEDMESH_TARGET_TRIPLE`. We need it at runtime to
// reconstruct the bundled Node.js sidecar's filename (`node-<triple>`)
// without doing fragile cfg!() arch detection.

fn main() {
    let target = std::env::var("TARGET").expect("Cargo always sets TARGET for build scripts");
    println!("cargo:rustc-env=CLOSEDMESH_TARGET_TRIPLE={}", target);
    // Re-run the build script if the target ever changes (e.g. cross-compiling
    // from x86_64 to aarch64 on the same machine).
    println!("cargo:rerun-if-env-changed=TARGET");

    tauri_build::build();
}
