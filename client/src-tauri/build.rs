fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // NDK 27 defaults to 4 KB; keep the native library compatible with 16 KB devices.
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg-cdylib=-Wl,-z,common-page-size=16384");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("native/activity.m")
            .file("native/panel.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("coaster_activity");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
        println!("cargo:rerun-if-changed=native/activity.m");
        println!("cargo:rerun-if-changed=native/panel.m");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Icon changes must invalidate Cargo's cached Windows resource.
        println!("cargo:rerun-if-changed=icons/icon.ico");
        // The pinned tauri-build reads this flag; ensure personal installs need no VC runtime DLLs.
        std::env::set_var("STATIC_VCRUNTIME", "true");
        cc::Build::new()
            .file("native/windows.c")
            .compile("coaster_windows");
        for library in ["user32", "advapi32", "wtsapi32"] {
            println!("cargo:rustc-link-lib={library}");
        }
        println!("cargo:rerun-if-changed=native/windows.c");
    }
    tauri_build::build();
}
