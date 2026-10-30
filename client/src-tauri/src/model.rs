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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cup {
    pub id: u8,
    pub name: String,
    pub empty_cup_grams: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CupSetup {
    pub id: String,
    pub cup_id: u8,
    pub name: String,
    pub expires_at: i64,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cups: Option<Vec<Cup>>,
    pub active_cup_id: Option<u8>,
    pub cup_setup: Option<CupSetup>,
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

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Character {
    Capybara,
    Cat,
    Dog,
    Girl,
    Boy,
    #[default]
    #[serde(other)]
    Robot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub auto_rest: bool,
    pub reminders: bool,
    pub character: Character,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_rest: true,
            reminders: true,
            character: Character::default(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cup_fields_preserve_legacy_compatibility_and_names() {
        let legacy = serde_json::to_value(Device::default()).unwrap();
        assert!(legacy.get("cups").is_none());
        let mut old = legacy.clone();
        old.as_object_mut().unwrap().remove("activeCupId");
        old.as_object_mut().unwrap().remove("cupSetup");
        assert!(serde_json::from_value::<Device>(old).unwrap().cups.is_none());
        let value = serde_json::json!({
            "cups": [{ "id": 2, "name": "保温杯A1", "emptyCupGrams": 180.0 }],
            "activeCupId": 2,
            "cupSetup": { "id": "operation", "cupId": 3, "name": "茶杯", "expiresAt": 1800000300000_i64 }
        });
        let mut updated = legacy;
        updated.as_object_mut().unwrap().extend(value.as_object().unwrap().clone());
        let device: Device = serde_json::from_value(updated).unwrap();
        assert_eq!(device.cups.as_ref().unwrap()[0].name, "保温杯A1");
        assert_eq!(device.active_cup_id, Some(2));
        assert_eq!(device.cup_setup.as_ref().unwrap().cup_id, 3);
        assert_eq!(serde_json::to_value(device).unwrap()["cups"][0]["emptyCupGrams"], 180.0);
    }
}
