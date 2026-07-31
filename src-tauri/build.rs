fn main() {
    // 获取项目根目录
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let root_dir = std::path::Path::new(&manifest_dir).parent().unwrap();

    // 编译 protobuf
    let proto_path = root_dir.join("proto/pbbp2.proto");
    if proto_path.exists() {
        let proto_file = proto_path.to_str().unwrap();
        let proto_dir = root_dir.join("proto");
        let proto_dir_str = proto_dir.to_str().unwrap();
        prost_build::compile_protos(&[proto_file], &[proto_dir_str]).unwrap();
    }

    // 为 externalBin 创建带目标三元组后缀的 symlink
    // Tauri 要求 ../target/release/sparky-server-<target_triple> 存在
    if let Ok(target) = std::env::var("TARGET") {
        let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
        let bin = root_dir.join("target").join(&profile).join("sparky-server");
        let link = root_dir.join("target").join(&profile).join(format!("sparky-server-{}", target));
        if bin.exists() && !link.exists() {
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(&bin, &link);
        }
    }

    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "browser-bridge",
            tauri_build::InlinedPlugin::new().commands(&[
                "browser_bridge_response",
                "browser_debug_log",
                "browser_link_open",
            ]),
        ),
    )
    .expect("failed to build Tauri application");
}
