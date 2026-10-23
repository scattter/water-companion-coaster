#[derive(Clone, Copy)]
pub struct Activity {
    pub idle_seconds: Option<f64>,
    pub suspended: bool,
    pub wake_generation: u64,
}

#[cfg(target_os = "macos")]
extern "C" {
    fn coaster_activity_start();
    fn coaster_idle_seconds() -> f64;
    fn coaster_suspended() -> bool;
    fn coaster_wake_generation() -> u64;
    fn coaster_panel_setup(window: *mut std::ffi::c_void, status_item: *mut std::ffi::c_void);
    fn coaster_panel_position();
    fn coaster_panel_resize(height: f64);
}

pub fn setup_panel(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;

        let tray = window
            .app_handle()
            .tray_by_id("companion")
            .ok_or("无法找到菜单栏图标。")?;
        let window = window.clone();
        tray.with_inner_tray_icon(move |tray| {
            let item = tray.ns_status_item().ok_or("无法读取菜单栏图标。")?;
            let pointer = window.ns_window().map_err(|_| "无法读取详情窗口。")?;
            unsafe {
                coaster_panel_setup(pointer, (&*item as *const _) as *mut std::ffi::c_void);
            }
            Ok::<_, String>(())
        })
        .map_err(|_| "无法设置菜单栏浮窗。")??;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

pub fn position_panel(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    return window.run_on_main_thread(|| unsafe { coaster_panel_position() });
    #[cfg(not(target_os = "macos"))]
    window.center()
}

pub fn resize_panel(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    return window.run_on_main_thread(move || unsafe { coaster_panel_resize(height) });
    #[cfg(not(target_os = "macos"))]
    {
        let width = window
            .inner_size()?
            .to_logical::<f64>(window.scale_factor()?)
            .width;
        window.set_size(tauri::LogicalSize::new(width, height))
    }
}

pub fn start() {
    #[cfg(target_os = "macos")]
    unsafe {
        coaster_activity_start();
    }
}

pub fn activity() -> Activity {
    #[cfg(target_os = "macos")]
    unsafe {
        let idle = coaster_idle_seconds();
        Activity {
            idle_seconds: (idle.is_finite() && idle >= 0.0).then_some(idle),
            suspended: coaster_suspended(),
            wake_generation: coaster_wake_generation(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    Activity {
        idle_seconds: None,
        suspended: false,
        wake_generation: 0,
    }
}
