use crate::model::{Connection, Dashboard, Settings, Snapshot};
use crate::runtime::Backend;
use crate::{platform, tray};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn get_snapshot(backend: State<'_, Arc<Backend>>) -> Snapshot {
    backend.snapshot()
}

#[tauri::command]
async fn configure_server(
    app: AppHandle,
    backend: State<'_, Arc<Backend>>,
    address: String,
) -> Result<Snapshot, String> {
    backend.configure(&app, &address).await
}

#[tauri::command]
async fn login(
    app: AppHandle,
    backend: State<'_, Arc<Backend>>,
    username: String,
    password: String,
) -> Result<Snapshot, String> {
    backend.inner().login(&app, &username, &password).await
}

#[tauri::command]
async fn logout(app: AppHandle, backend: State<'_, Arc<Backend>>) -> Result<Snapshot, String> {
    backend.logout(&app).await
}

#[tauri::command]
async fn refresh(app: AppHandle, backend: State<'_, Arc<Backend>>) -> Result<Snapshot, String> {
    backend.inner().sync(&app, true).await;
    Ok(backend.snapshot())
}

#[tauri::command]
async fn get_dashboard(
    app: AppHandle,
    backend: State<'_, Arc<Backend>>,
    date: String,
) -> Result<Dashboard, String> {
    backend.dashboard_at(&app, &date).await
}

#[tauri::command]
async fn update_settings(
    app: AppHandle,
    backend: State<'_, Arc<Backend>>,
    settings: Settings,
) -> Result<Snapshot, String> {
    let _operation = backend.operations.lock().await;
    backend.settings(&app, settings)
}

pub fn show_panel(app: &AppHandle, page: &str) -> Result<(), String> {
    if !matches!(page, "dashboard" | "settings" | "history") {
        return Err("未知页面。".into());
    }
    let window = app
        .get_webview_window("panel")
        .ok_or("无法找到详情窗口。")?;
    platform::position_panel(&window).map_err(|_| "无法定位详情窗口。")?;
    window.unminimize().map_err(|_| "无法展开详情窗口。")?;
    window.show().map_err(|_| "无法显示详情窗口。")?;
    window.set_focus().map_err(|_| "无法切换到详情窗口。")?;
    window
        .emit("companion://page", page)
        .map_err(|_| "无法切换详情页面。")?;
    Ok(())
}

#[tauri::command]
fn resize_panel(window: tauri::WebviewWindow, height: f64) -> Result<(), String> {
    if !height.is_finite() || height <= 0.0 {
        return Err("面板高度无效。".into());
    }
    platform::resize_panel(&window, height).map_err(|_| "无法调整面板高度。".into())
}

#[tauri::command]
fn hide_panel(window: tauri::WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|_| "无法收起详情窗口。".into())
}

#[tauri::command]
fn open_website(app: AppHandle, backend: State<'_, Arc<Backend>>) -> Result<(), String> {
    let server = backend.snapshot().server.ok_or("请先配置服务器地址。")?;
    app.opener()
        .open_url(server, None::<&str>)
        .map_err(|_| "无法打开浏览器，请检查系统默认浏览器设置。".into())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        let _ = show_panel(app, "dashboard");
    }));
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            configure_server,
            login,
            logout,
            refresh,
            get_dashboard,
            update_settings,
            resize_panel,
            hide_panel,
            open_website,
            quit
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            platform::start();
            let backend = Arc::new(
                Backend::new(&app.path().app_config_dir()?).map_err(std::io::Error::other)?,
            );
            app.manage(backend.clone());
            tray::setup(app.handle())?;
            if let Some(panel) = app.get_webview_window("panel") {
                platform::setup_panel(&panel).map_err(std::io::Error::other)?;
                let window = panel.clone();
                panel.on_window_event(move |event| {
                    #[cfg(target_os = "windows")]
                    if let WindowEvent::Focused(false) = event {
                        platform::panel_blurred(&window);
                    }
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                });
            }
            if matches!(
                backend.snapshot().connection,
                Connection::Unconfigured | Connection::SignedOut
            ) {
                show_panel(app.handle(), "dashboard").map_err(std::io::Error::other)?;
            }
            backend.publish(app.handle());
            backend.start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法启动饮水陪伴客户端");
    app.run(|_handle, event| match event {
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            let _ = show_panel(_handle, "dashboard");
        }
        _ => {}
    });
}
