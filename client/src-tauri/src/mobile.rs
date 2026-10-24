use crate::{
    engine::Engine,
    model::{CompanionState, Dashboard, Settings},
};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct Companion {
    engine: Engine,
    identity: String,
    state: CompanionState,
    started: i64,
}

#[tauri::command]
fn mobile_address(address: String) -> Result<String, String> {
    crate::address::normalize_address(&address)
}

#[tauri::command]
fn mobile_companion(
    state: State<'_, Mutex<Companion>>,
    dashboard: Option<Dashboard>,
    identity: String,
    reset: bool,
) -> (CompanionState, u32) {
    let mut current = state.lock().unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    if current.identity != identity || reset {
        current.engine.reset();
        current.identity = identity;
    }
    let connected = dashboard
        .as_ref()
        .and_then(|d| d.device.as_ref())
        .is_some_and(|d| {
            d.online && d.calibrated && d.empty_cup_grams.is_some() && d.error.is_none()
        });
    if let Some(dashboard) = dashboard {
        current.engine.ingest(&dashboard, now);
    }
    let next = if connected {
        current.engine.tick(
            now,
            Some(0.0),
            false,
            true,
            &Settings {
                auto_rest: false,
                reminders: false,
            },
        )
    } else {
        current.engine.mark_baseline();
        CompanionState::Idle
    };
    if current.state != next {
        current.started = now;
        current.state = next;
    }
    (
        next,
        if next == CompanionState::Idle {
            0
        } else {
            ((now.saturating_sub(current.started).max(0) / 1000) % 4) as u32
        },
    )
}

#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(coaster_mobile::init())
        .manage(Mutex::new(Companion::default()))
        .invoke_handler(tauri::generate_handler![mobile_address, mobile_companion])
        .run(tauri::generate_context!())
        .expect("无法启动饮水陪伴");
}
