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
    tauri_build::build()
}
