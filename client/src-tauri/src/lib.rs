mod address;
#[cfg(any(target_os = "windows", test))]
mod amount_icon;
#[cfg(not(target_os = "android"))]
mod api;
#[cfg(not(target_os = "android"))]
mod credentials;
#[cfg(not(target_os = "android"))]
mod desktop;
mod engine;
mod model;
#[cfg(any(target_os = "windows", test))]
mod placement;
#[cfg(not(target_os = "android"))]
mod platform;
#[cfg(not(target_os = "android"))]
mod runtime;
#[cfg(not(target_os = "android"))]
mod storage;
#[cfg(not(target_os = "android"))]
mod tray;
#[cfg(not(target_os = "android"))]
pub use desktop::{run, show_panel};
#[cfg(target_os = "android")]
mod mobile;
#[cfg(target_os = "android")]
pub use mobile::run;
