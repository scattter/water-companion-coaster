use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;

use crate::{
    address::normalize_address,
    api::Api,
    credentials,
    engine::Engine,
    model::{CompanionState, Connection, Settings, Snapshot},
    platform,
    storage::{Preferences, Storage},
};

pub struct Inner {
    pub snapshot: Snapshot,
    pub preferences: Preferences,
    engine: Engine,
    token: Option<String>,
    epoch: u64,
    cancel: CancellationToken,
    polling: bool,
    failures: u32,
    next_poll: Instant,
    wake_generation: u64,
    last_cycle: Instant,
    frame_started: i64,
}

pub struct Backend {
    pub inner: Mutex<Inner>,
    pub operations: AsyncMutex<()>,
    storage: Storage,
    api: Api,
    last_published: Mutex<Option<Snapshot>>,
}

impl Inner {
    fn clear_session(&mut self) {
        let revision = self.snapshot.revision;
        self.cancel.cancel();
        self.cancel = CancellationToken::new();
        self.epoch += 1;
        self.polling = false;
        self.token = None;
        self.engine.reset();
        self.failures = 0;
        self.next_poll = Instant::now();
        self.snapshot = Snapshot {
            revision,
            server: self.preferences.server.clone(),
            settings: self.preferences.settings.clone(),
            connection: if self.preferences.server.is_some() {
                Connection::SignedOut
            } else {
                Connection::Unconfigured
            },
            ..Snapshot::default()
        };
    }
}

impl Backend {
    pub fn new(directory: &Path) -> Result<Self, String> {
        let storage = Storage::new(directory)?;
        let (mut preferences, mut error) = match storage.load() {
            Ok(value) => (value, None),
            Err(error) => (Preferences::default(), Some(error)),
        };
        if let Some(server) = preferences.server.as_ref() {
            match normalize_address(server) {
                Ok(value) => preferences.server = Some(value),
                Err(message) => {
                    preferences.server = None;
                    error = Some(message);
                }
            }
        }
        let token = if let Some(server) = &preferences.server {
            match credentials::read(server) {
                Ok(token) => token,
                Err(message) => {
                    error = Some(message);
                    None
                }
            }
        } else {
            None
        };
        let snapshot = Snapshot {
            server: preferences.server.clone(),
            settings: preferences.settings.clone(),
            error,
            connection: if token.is_some() {
                Connection::Connecting
            } else if preferences.server.is_some() {
                Connection::SignedOut
            } else {
                Connection::Unconfigured
            },
            ..Snapshot::default()
        };
        Ok(Self {
            inner: Mutex::new(Inner {
                snapshot,
                preferences,
                engine: Engine::new(),
                token,
                epoch: 0,
                cancel: CancellationToken::new(),
                polling: false,
                failures: 0,
                next_poll: Instant::now(),
                wake_generation: 0,
                last_cycle: Instant::now(),
                frame_started: Utc::now().timestamp_millis(),
            }),
            operations: AsyncMutex::new(()),
            storage,
            api: Api::new()?,
            last_published: Mutex::new(None),
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut inner = self.inner.lock().unwrap();
        inner.snapshot.revision = inner.snapshot.revision.saturating_add(1);
        inner.snapshot.clone()
    }

    pub fn publish(&self, app: &AppHandle) {
        let snapshot = self.snapshot();
        let previous = {
            let mut previous = self.last_published.lock().unwrap();
            if let Some(old) = previous.as_ref() {
                if old.revision > snapshot.revision {
                    return;
                }
                let mut comparable = old.clone();
                comparable.revision = snapshot.revision;
                if comparable == snapshot {
                    return;
                }
            }
            previous.replace(snapshot.clone())
        };
        // 不持有状态锁等待主线程；菜单点击可能同时读取或修改快照。
        let current = app.clone();
        let _ = app.run_on_main_thread(move || {
            let latest = current.state::<Arc<Backend>>().snapshot();
            crate::tray::render(&current, &latest, previous.as_ref());
        });
        let _ = app.emit("companion://snapshot", &snapshot);
    }

    pub async fn configure(&self, app: &AppHandle, address: &str) -> Result<Snapshot, String> {
        let server = normalize_address(address)?;
        let _operation = self.operations.lock().await;
        // 先验证新入口，失败时保留原服务；提交切换时统一取消所有旧请求。
        self.api
            .health(&server)
            .await
            .map_err(|error| error.message)?;
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.preferences.server.as_ref() == Some(&server) {
                return Ok(inner.snapshot.clone());
            }
            let mut preferences = inner.preferences.clone();
            preferences.server = Some(server);
            self.storage.save(&preferences)?;
            if let Some(previous) = &inner.preferences.server {
                if let Err(error) = credentials::remove(previous) {
                    let _ = self.storage.save(&inner.preferences);
                    return Err(error);
                }
            }
            inner.preferences = preferences;
            inner.clear_session();
        }
        self.publish(app);
        Ok(self.snapshot())
    }

    pub async fn login(
        self: &Arc<Self>,
        app: &AppHandle,
        username: &str,
        password: &str,
    ) -> Result<Snapshot, String> {
        let _operation = self.operations.lock().await;
        let (server, epoch, cancel) = {
            let mut inner = self.inner.lock().unwrap();
            let server = inner.preferences.server.clone().ok_or("请先连接服务器。")?;
            credentials::remove(&server)?;
            inner.clear_session();
            inner.snapshot.connection = Connection::Connecting;
            (server, inner.epoch, inner.cancel.clone())
        };
        self.publish(app);
        let response = cancel
            .run_until_cancelled(self.api.login(&server, username, password))
            .await
            .ok_or("登录已取消。")?;
        let result = {
            let mut inner = self.inner.lock().unwrap();
            if inner.epoch != epoch {
                return Err("连接已变化，请重新登录。".into());
            }
            match response {
                Ok((session, token)) => match credentials::save(&server, &token) {
                    Ok(()) => {
                        inner.token = Some(token);
                        inner.snapshot.session = session;
                        inner.snapshot.error = None;
                        Ok(())
                    }
                    Err(error) => {
                        inner.snapshot.connection = Connection::SignedOut;
                        Err(error)
                    }
                },
                Err(error) => {
                    inner.snapshot.connection = Connection::SignedOut;
                    Err(error.message)
                }
            }
        };
        self.publish(app);
        result?;
        self.sync(app, true).await;
        Ok(self.snapshot())
    }

    pub async fn logout(&self, app: &AppHandle) -> Result<Snapshot, String> {
        let _operation = self.operations.lock().await;
        let (server, token) = {
            let mut inner = self.inner.lock().unwrap();
            let server = inner.preferences.server.clone();
            if let Some(server) = &server {
                credentials::remove(server)?;
            }
            let token = inner.token.clone();
            inner.clear_session();
            (server, token)
        };
        self.publish(app);
        if let (Some(server), Some(token)) = (server, token) {
            if self.api.logout(&server, &token).await.is_err() {
                self.inner.lock().unwrap().snapshot.error =
                    Some("已在本机退出；暂时无法确认云端会话注销。".into());
            }
        }
        self.publish(app);
        Ok(self.snapshot())
    }

    pub fn settings(&self, app: &AppHandle, settings: Settings) -> Result<Snapshot, String> {
        {
            let mut inner = self.inner.lock().unwrap();
            let mut preferences = inner.preferences.clone();
            preferences.settings = settings.clone();
            self.storage.save(&preferences)?;
            inner.preferences = preferences;
            inner.snapshot.settings = settings;
        }
        self.publish(app);
        Ok(self.snapshot())
    }

    pub async fn sync(self: &Arc<Self>, app: &AppHandle, force: bool) {
        let (server, token, epoch, cancel) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.polling || (!force && Instant::now() < inner.next_poll) {
                return;
            }
            let (Some(server), Some(token)) =
                (inner.preferences.server.clone(), inner.token.clone())
            else {
                return;
            };
            inner.polling = true;
            (server, token, inner.epoch, inner.cancel.clone())
        };
        let request = async {
            let mut session = self.api.session(&server, &token).await?;
            let dashboard = self.api.dashboard(&server, &token).await?;
            session.device_id = dashboard.device.as_ref().map(|device| device.id.clone());
            session.binding_id = dashboard
                .device
                .as_ref()
                .and_then(|device| device.binding_id.clone());
            Ok::<_, crate::api::ApiError>((session, dashboard))
        };
        let Some(result) = cancel.run_until_cancelled(request).await else {
            return;
        };
        let activity = platform::activity();
        {
            let mut inner = self.inner.lock().unwrap();
            // 身份/服务切换后到达的响应，不能覆盖新会话的数据。
            if inner.epoch != epoch || cancel.is_cancelled() {
                return;
            }
            if activity.suspended
                || activity.wake_generation != inner.wake_generation
                || inner.last_cycle.elapsed() > Duration::from_secs(15)
            {
                inner.wake_generation = activity.wake_generation;
                inner.engine.mark_baseline();
            }
            inner.polling = false;
            match result {
                Ok((session, dashboard)) => {
                    if inner.snapshot.session.user.as_ref().map(|user| &user.id)
                        != session.user.as_ref().map(|user| &user.id)
                    {
                        inner.engine.reset();
                    }
                    if inner.snapshot.connection != Connection::Online {
                        inner.engine.mark_baseline();
                    }
                    inner
                        .engine
                        .ingest(&dashboard, Utc::now().timestamp_millis());
                    inner.snapshot.session = session;
                    inner.snapshot.dashboard = Some(dashboard);
                    inner.snapshot.connection = Connection::Online;
                    inner.snapshot.last_synced_at = Some(Utc::now().to_rfc3339());
                    inner.snapshot.error = None;
                    inner.failures = 0;
                    inner.next_poll = Instant::now() + Duration::from_secs(5);
                }
                Err(error) if error.unauthorized => {
                    let removal = credentials::remove(&server);
                    inner.clear_session();
                    inner.snapshot.error = Some(
                        removal
                            .err()
                            .unwrap_or_else(|| "登录已过期，请重新登录。".into()),
                    );
                }
                Err(error) => {
                    inner.snapshot.connection = Connection::Offline;
                    inner.snapshot.error = Some(error.message);
                    inner.engine.mark_baseline();
                    inner.failures = (inner.failures + 1).min(4);
                    inner.next_poll = Instant::now()
                        + Duration::from_secs((5 * (1u64 << inner.failures)).min(60));
                }
            }
        }
        self.publish(app);
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let backend = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(250));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut activity = platform::activity();
            let mut activity_read = Instant::now();
            loop {
                interval.tick().await;
                if activity_read.elapsed() >= Duration::from_secs(1) {
                    activity = platform::activity();
                    activity_read = Instant::now();
                }
                let should_poll;
                {
                    let mut inner = backend.inner.lock().unwrap();
                    let gap = inner.last_cycle.elapsed() > Duration::from_secs(15);
                    inner.last_cycle = Instant::now();
                    if activity.wake_generation != inner.wake_generation || gap {
                        inner.wake_generation = activity.wake_generation;
                        inner.engine.mark_baseline();
                        inner.next_poll = Instant::now();
                    }
                    if activity.suspended && inner.polling {
                        inner.cancel.cancel();
                        inner.cancel = CancellationToken::new();
                        inner.epoch += 1;
                        inner.polling = false;
                    }
                    let connected = inner.snapshot.connection == Connection::Online
                        && inner
                            .snapshot
                            .dashboard
                            .as_ref()
                            .and_then(|data| data.device.as_ref())
                            .is_some_and(|device| {
                                device.online
                                    && device.calibrated
                                    && device.empty_cup_grams.is_some()
                                    && device.error.is_none()
                            });
                    let now = Utc::now().timestamp_millis();
                    let settings = inner.snapshot.settings.clone();
                    let state = inner.engine.tick(
                        now,
                        activity.idle_seconds,
                        activity.suspended,
                        connected,
                        &settings,
                    );
                    if state != inner.snapshot.state {
                        inner.frame_started = now;
                        inner.snapshot.state = state;
                    }
                    let period = match inner.snapshot.state {
                        CompanionState::Drinking | CompanionState::Reminding => 1_000,
                        CompanionState::Working => 1_000,
                        CompanionState::Sleeping => 2_000,
                        CompanionState::Idle => 0,
                    };
                    inner.snapshot.frame = if period == 0 || activity.suspended {
                        0
                    } else {
                        ((now.saturating_sub(inner.frame_started).max(0) / period) % 4) as u32
                    };
                    should_poll = !activity.suspended
                        && !inner.polling
                        && inner.token.is_some()
                        && Instant::now() >= inner.next_poll;
                }
                backend.publish(&app);
                if should_poll {
                    let current = backend.clone();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        current.sync(&app, false).await;
                    });
                }
            }
        });
    }
}
