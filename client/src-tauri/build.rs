fn main() {
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
    tauri_build::build();
}
