use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub user: Option<User>,
    pub device_id: Option<String>,
    pub binding_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct User {
    pub id: String,
    pub username: String,
    pub role: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub date: String,
    pub time_zone: String,
    pub totals: Totals,
    pub week: Vec<DayTotal>,
    pub events: Vec<DrinkEvent>,
    pub device: Option<Device>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub drink_ml: f64,
    pub refill_ml: f64,
    pub drink_count: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTotal {
    pub date: String,
    pub drink_ml: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EventKind {
    Drink,
    Refill,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrinkEvent {
    pub id: String,
    pub kind: EventKind,
    pub amount_ml: f64,
    pub before_grams: f64,
    pub after_grams: f64,
    pub occurred_at: String,
    pub revoked_at: Option<String>,
    pub binding_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub last_seen_at: Option<String>,
    pub online: bool,
    pub weight_grams: Option<f64>,
    pub stable: bool,
    pub cup_present: bool,
    pub source: String,
    pub calibrated: bool,
    pub empty_cup_grams: Option<f64>,
    pub pending_count: u64,
    pub time_pending_count: u64,
    pub clock_synced: bool,
    pub error: Option<String>,
    pub firmware_version: Option<String>,
    pub binding_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Connection {
    #[default]
    Unconfigured,
    SignedOut,
    Connecting,
    Online,
    Offline,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CompanionState {
    Working,
    Sleeping,
    Drinking,
    Reminding,
    #[default]
    Idle,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub auto_rest: bool,
    pub reminders: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_rest: true,
            reminders: true,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub server: Option<String>,
    pub session: Session,
    pub dashboard: Option<Dashboard>,
    pub connection: Connection,
    pub error: Option<String>,
    pub last_synced_at: Option<String>,
    pub state: CompanionState,
    pub drink_ml: Option<f64>,
    pub frame: u32,
    pub settings: Settings,
}
