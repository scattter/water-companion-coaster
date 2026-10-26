#[derive(Clone, Copy)]
pub struct Activity {
    pub idle_seconds: Option<f64>,
    pub suspended: bool,
    pub wake_generation: u64,
}

#[cfg(target_os = "windows")]
static PANEL_BLURRED: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

#[cfg(target_os = "windows")]
pub fn panel_blurred(window: &tauri::WebviewWindow) {
    if window.is_visible().unwrap_or(false) {
        *PANEL_BLURRED.lock().unwrap() = Some(std::time::Instant::now());
        let _ = window.hide();
    }
}

#[cfg(target_os = "windows")]
pub fn consume_tray_blur() -> bool {
    // Clicking the tray first blurs the panel, then delivers the mouse-up event.
    PANEL_BLURRED
        .lock()
        .unwrap()
        .take()
        .is_some_and(|at| at.elapsed().as_millis() < 300)
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
    fn coaster_status_title(value: *const std::ffi::c_char, animate: bool);
}

#[cfg(target_os = "macos")]
pub fn animate_tray_title(value: &str, animate: bool) {
    if let Ok(value) = std::ffi::CString::new(value) {
        unsafe { coaster_status_title(value.as_ptr(), animate) };
    }
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
    #[cfg(target_os = "windows")]
    return place_windows(window, None);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    window.center()
}

pub fn resize_panel(window: &tauri::WebviewWindow, height: f64) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    return window.run_on_main_thread(move || unsafe { coaster_panel_resize(height) });
    #[cfg(target_os = "windows")]
    return place_windows(window, Some(height));
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let width = window
            .inner_size()?
            .to_logical::<f64>(window.scale_factor()?)
            .width;
        window.set_size(tauri::LogicalSize::new(width, height))
    }
}

pub fn start() {
    #[cfg(target_os = "windows")]
    unsafe {
        coaster_windows_start();
    }
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
    #[cfg(target_os = "windows")]
    unsafe {
        let idle = coaster_windows_idle();
        return Activity {
            idle_seconds: (idle.is_finite() && idle >= 0.0).then_some(idle),
            suspended: coaster_windows_suspended() != 0,
            wake_generation: coaster_windows_generation() as u64,
        };
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Activity {
        idle_seconds: None,
        suspended: false,
        wake_generation: 0,
    }
}

#[cfg(target_os = "windows")]
extern "C" {
    fn coaster_windows_start();
    fn coaster_windows_idle() -> f64;
    fn coaster_windows_suspended() -> i32;
    fn coaster_windows_generation() -> u32;
    fn coaster_windows_light_theme() -> i32;
    fn coaster_windows_animate() -> i32;
}

#[cfg(target_os = "windows")]
pub fn light_taskbar() -> bool {
    unsafe { coaster_windows_light_theme() != 0 }
}

#[cfg(target_os = "windows")]
pub fn animate_taskbar() -> bool {
    unsafe { coaster_windows_animate() != 0 }
}

#[cfg(target_os = "windows")]
fn place_windows(window: &tauri::WebviewWindow, height: Option<f64>) -> tauri::Result<()> {
    use tauri::Manager;
    let tray = window
        .app_handle()
        .tray_by_id("companion")
        .and_then(|tray| tray.rect().ok().flatten());
    let anchor = tray.map(|rect| {
        let p = rect
            .position
            .to_physical::<i32>(window.scale_factor().unwrap_or(1.0));
        let s = rect
            .size
            .to_physical::<u32>(window.scale_factor().unwrap_or(1.0));
        [p.x, p.y, p.x + s.width as i32, p.y + s.height as i32]
    });
    let monitor = if let Some(a) = anchor {
        window.monitor_from_point(a[0] as f64, a[1] as f64)?
    } else {
        window.primary_monitor()?
    };
    let Some(monitor) = monitor else {
        return window.center();
    };
    let work = monitor.work_area();
    let area = [
        work.position.x,
        work.position.y,
        work.position.x + work.size.width as i32,
        work.position.y + work.size.height as i32,
    ];
    let scale = monitor.scale_factor();
    let height = height.unwrap_or(window.inner_size()?.height as f64 / window.scale_factor()?);
    let bounds = crate::placement::fit(
        area,
        anchor.unwrap_or([area[2], area[3], area[2], area[3]]),
        [
            (340.0 * scale).round() as i32,
            (height.clamp(120.0, 1600.0) * scale).round() as i32,
        ],
        (4.0 * scale).round() as i32,
    );
    // Move first so the destination monitor's DPI change cannot rescale the final size twice.
    window.set_position(tauri::PhysicalPosition::new(bounds[0], bounds[1]))?;
    window.set_size(tauri::PhysicalSize::new(bounds[2] as u32, bounds[3] as u32))
}
