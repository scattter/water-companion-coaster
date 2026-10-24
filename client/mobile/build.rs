fn main() {
    tauri_plugin::Builder::new(&[
        "configure",
        "status",
        "request",
        "pinWidget",
        "choose",
        "connect",
        "read",
        "write",
        "subscribe",
        "disconnect",
        "registerListener",
        "removeListener",
    ])
    .android_path("android")
    .build();
}
