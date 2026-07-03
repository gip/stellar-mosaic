use risc0_build::{embed_methods_with_options, DockerOptionsBuilder, GuestOptionsBuilder};
use std::collections::HashMap;

fn main() {
    // Build the guest inside RISC Zero's pinned Docker container so the ELF (and thus the image id)
    // is byte-reproducible across hosts (macOS/arm64 and Ubuntu/x86). A native build leaks the host
    // toolchain and absolute source paths into the binary, giving a different image id per machine.
    // `root_dir` is the dir Cargo needs to build the guest (Cargo.lock + git deps); build.rs lives in
    // bridge-prover/methods, so "../" is the bridge-prover workspace root.
    // Pin the guest-builder container tag explicitly: risc0-build 3.0.5 defaults to `r0.1.88.0`,
    // whose rustc (1.88) is below the MSRV of the Steel/alloy/revm graph (up to 1.94). `r0.1.94.1`
    // matches the rzup toolchain and compiles the guest. Pinning it here (not via the
    // RISC0_DOCKER_CONTAINER_TAG env var) keeps the image id reproducible on every host and in CI.
    let docker = DockerOptionsBuilder::default()
        .root_dir("../".to_string())
        .docker_container_tag("r0.1.94.1".to_string())
        .build()
        .unwrap();

    let guest_opts = GuestOptionsBuilder::default()
        .use_docker(docker)
        .build()
        .unwrap();

    // Key is the guest crate's package name (methods/guest/Cargo.toml).
    embed_methods_with_options(HashMap::from([("bridge-guest", guest_opts)]));
}
