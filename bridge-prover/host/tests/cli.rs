use std::process::Command;

#[test]
fn print_image_id_needs_no_rpc_arguments() {
    let output = Command::new(env!("CARGO_BIN_EXE_host"))
        .arg("--print-image-id")
        .env_remove("RPC_URL")
        .env_remove("BRIDGE_ADDRESS")
        .output()
        .expect("run host --print-image-id");

    assert!(
        output.status.success(),
        "host failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        include_str!("../../image-id.hex")
    );
}
