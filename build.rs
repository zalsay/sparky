fn main() {
    prost_build::compile_protos(&["proto/pbbp2.proto"], &["proto/"]).unwrap();
}
