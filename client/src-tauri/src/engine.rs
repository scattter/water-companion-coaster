use std::collections::HashSet;

use chrono::DateTime;

use crate::model::{CompanionState, Dashboard, DrinkEvent, EventKind, Settings};

const FRESH_EVENT_MS: i64 = 120_000;
const ACTION_MS: i64 = 4_000;
const REMINDER_MS: i64 = 60 * 60 * 1_000;
const IDLE_SECONDS: f64 = 300.0;
const MAX_TICK_GAP_MS: i64 = 15_000;

#[derive(Debug)]
pub struct Engine {
    binding: Option<(String, Option<String>)>,
    date: String,
    seen: HashSet<String>,
    needs_baseline: bool,
    cup_present: Option<bool>,
    cup_lifted: bool,
    drink: Option<DrinkEvent>,
    drink_until: Option<i64>,
    reminder_until: Option<i64>,
    active_ms: i64,
    reminded: bool,
    last_tick: Option<i64>,
    was_active: bool,
    was_locked: bool,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            binding: None,
            date: String::new(),
            seen: HashSet::new(),
            needs_baseline: true,
            cup_present: None,
            cup_lifted: false,
            drink: None,
            drink_until: None,
            reminder_until: None,
            active_ms: 0,
            reminded: false,
            last_tick: None,
            was_active: false,
            was_locked: false,
        }
    }
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn mark_baseline(&mut self) {
        self.needs_baseline = true;
        self.cup_present = None;
        self.cup_lifted = false;
        self.drink = None;
        self.drink_until = None;
        self.reminder_until = None;
        self.last_tick = None;
        self.was_active = false;
    }

    pub fn drink_amount(&self, now_ms: i64) -> Option<f64> {
        // 拿杯只能触发水豚动作，数字必须等放回后上报的有效饮水记录。
        self.drink
            .as_ref()
            .filter(|_| self.drink_until.is_some_and(|until| now_ms < until))
            .map(|event| event.amount_ml)
            .filter(|amount| amount.is_finite() && *amount > 0.0)
    }

    pub fn ingest(&mut self, dashboard: &Dashboard, now_ms: i64) -> bool {
        let binding = dashboard
            .device
            .as_ref()
            .map(|device| (device.id.clone(), device.binding_id.clone()));
        if self.binding != binding {
            self.reset();
            self.binding = binding;
        }
        let cup_present = dashboard
            .device
            .as_ref()
            .filter(|device| {
                device.online
                    && device.calibrated
                    && device.empty_cup_grams.is_some()
                    && device.error.is_none()
            })
            .map(|device| device.cup_present);
        // 只响应观察到的取杯过程，启动、重连时杯子已不在杯垫上不补播。
        let lifted =
            !self.needs_baseline && self.cup_present == Some(true) && cup_present == Some(false);
        self.cup_lifted = cup_present == Some(false) && (self.cup_lifted || lifted);
        self.cup_present = cup_present;
        if self.drink.as_ref().is_some_and(|drink| {
            dashboard
                .events
                .iter()
                .any(|event| event.id == drink.id && event.revoked_at.is_some())
        }) {
            self.drink = None;
        }
        if self.date != dashboard.date {
            // 午夜只淘汰旧日期的去重记录，不把当天第一口水误当成历史基线。
            let current_ids: HashSet<&str> = dashboard
                .events
                .iter()
                .map(|event| event.id.as_str())
                .collect();
            self.seen.retain(|id| current_ids.contains(id.as_str()));
            self.date.clone_from(&dashboard.date);
        }
        let mut new_drink = false;
        let mut fresh_drink = false;
        let mut latest_drink = None;
        for event in &dashboard.events {
            if !self.seen.insert(event.id.clone()) {
                continue;
            }
            let current_binding = self
                .binding
                .as_ref()
                .is_some_and(|(_, binding_id)| *binding_id == event.binding_id);
            let age = DateTime::parse_from_rfc3339(&event.occurred_at)
                .ok()
                .map(|time| now_ms.saturating_sub(time.timestamp_millis()));
            if current_binding
                && age.is_some_and(|age| age >= 0)
                && event.kind == EventKind::Drink
                && event.revoked_at.is_none()
            {
                new_drink = true;
                fresh_drink |= age.is_some_and(|age| age <= FRESH_EVENT_MS);
                if let Some(age) = age.filter(|age| *age <= FRESH_EVENT_MS) {
                    if latest_drink.is_none_or(|(latest_age, _)| age < latest_age) {
                        latest_drink = Some((age, event));
                    }
                }
            }
        }
        if new_drink {
            // 离线补传也证明期间喝过水，应重置提醒，但陈旧记录不补播动画。
            self.active_ms = 0;
            self.reminded = false;
            self.reminder_until = None;
        }
        if self.needs_baseline {
            self.needs_baseline = false;
            return false;
        }
        if fresh_drink {
            self.drink = latest_drink.map(|(_, event)| event.clone());
            self.drink_until = Some(now_ms.saturating_add(ACTION_MS));
        }
        fresh_drink
    }

    pub fn tick(
        &mut self,
        now_ms: i64,
        idle_seconds: Option<f64>,
        locked: bool,
        connected: bool,
        settings: &Settings,
    ) -> CompanionState {
        let elapsed = self
            .last_tick
            .map(|last| now_ms.saturating_sub(last))
            .unwrap_or(0);
        let discontinuity = !(0..=MAX_TICK_GAP_MS).contains(&elapsed);
        if discontinuity || locked || self.was_locked || !connected {
            // 休眠或断线期间经过的墙钟时间不能变成工作时长，也不补播积压动作。
            self.mark_baseline();
        }
        let idle_seconds = idle_seconds.filter(|seconds| seconds.is_finite() && *seconds >= 0.0);
        let active = !locked
            && connected
            && !discontinuity
            && settings.reminders
            && idle_seconds.is_some_and(|seconds| seconds < IDLE_SECONDS);
        if active && self.was_active {
            self.active_ms = self.active_ms.saturating_add(elapsed);
        }
        self.last_tick = Some(now_ms);
        self.was_active = active;
        self.was_locked = locked;

        if locked {
            return if settings.auto_rest {
                CompanionState::Sleeping
            } else {
                CompanionState::Idle
            };
        }
        if self.cup_lifted || self.drink_until.is_some_and(|until| now_ms < until) {
            return CompanionState::Drinking;
        }
        if !settings.reminders || !active {
            self.reminder_until = None;
        } else if self.active_ms >= REMINDER_MS && !self.reminded {
            self.reminded = true;
            self.reminder_until = Some(now_ms.saturating_add(ACTION_MS));
        }
        if self.reminder_until.is_some_and(|until| now_ms < until) {
            return CompanionState::Reminding;
        }
        match idle_seconds {
            Some(seconds) if seconds >= IDLE_SECONDS && settings.auto_rest => {
                CompanionState::Sleeping
            }
            Some(_) => CompanionState::Working,
            None => CompanionState::Idle,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Device, DrinkEvent};

    const NOW: i64 = 1_792_627_200_000;

    fn dashboard() -> Dashboard {
        Dashboard {
            date: "2026-10-22".into(),
            time_zone: "Asia/Shanghai".into(),
            device: Some(Device {
                id: "device-1".into(),
                binding_id: Some("binding-1".into()),
                online: true,
                calibrated: true,
                empty_cup_grams: Some(120.0),
                cup_present: true,
                ..Device::default()
            }),
            ..Dashboard::default()
        }
    }

    fn event(id: &str, timestamp: i64) -> DrinkEvent {
        DrinkEvent {
            id: id.into(),
            kind: EventKind::Drink,
            amount_ml: 30.5,
            before_grams: 200.5,
            after_grams: 170.0,
            occurred_at: DateTime::from_timestamp_millis(timestamp)
                .unwrap()
                .to_rfc3339(),
            revoked_at: None,
            binding_id: Some("binding-1".into()),
        }
    }

    #[test]
    fn lifting_plays_until_return_without_counting_a_drink_or_resetting_reminders() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        let settings = Settings::default();
        engine.ingest(&data, NOW);
        assert_eq!(engine.drink_amount(NOW), None);
        engine.active_ms = 30_000;
        engine.reminded = true;
        data.device.as_mut().unwrap().cup_present = false;
        assert!(!engine.ingest(&data, NOW + 1_000));
        assert_eq!(engine.drink_amount(NOW + 1_000), None);
        assert_eq!(engine.active_ms, 30_000);
        assert!(engine.reminded);
        for offset in [1_000, 5_000, 10_000] {
            assert!(!engine.ingest(&data, NOW + offset));
            assert_eq!(engine.drink_amount(NOW + offset), None);
            assert_eq!(
                engine.tick(NOW + offset, Some(0.0), false, true, &settings),
                CompanionState::Drinking
            );
        }
        data.device.as_mut().unwrap().cup_present = true;
        assert!(!engine.ingest(&data, NOW + 11_000));
        assert_eq!(engine.drink_amount(NOW + 11_000), None);
        assert_eq!(
            engine.tick(NOW + 11_000, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
        data.events.push(event("confirmed", NOW + 12_000));
        assert!(engine.ingest(&data, NOW + 12_000));
        assert_eq!(engine.drink_amount(NOW + 12_000), Some(30.5));
        assert_eq!(engine.active_ms, 0);
        assert!(!engine.reminded);
        assert_eq!(
            engine.tick(NOW + 12_000, Some(0.0), false, true, &settings),
            CompanionState::Drinking
        );
        assert!(!engine.ingest(&data, NOW + 15_000));
        assert_eq!(engine.drink_amount(NOW + 15_000), Some(30.5));
        assert_eq!(
            engine.tick(NOW + 16_000, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
        assert_eq!(engine.drink_amount(NOW + 16_000), None);
    }

    #[test]
    fn drink_amount_uses_latest_fresh_record_without_next_lift_changing_its_display() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        data.events.push(event("baseline", NOW));
        engine.ingest(&data, NOW);
        assert_eq!(engine.drink_amount(NOW), None);
        let mut latest = event("latest", NOW + 2_000);
        latest.amount_ml = 120.0;
        data.events.extend([latest, event("earlier", NOW + 1_000)]);
        engine.ingest(&data, NOW + 2_000);
        assert_eq!(engine.drink_amount(NOW + 2_000), Some(120.0));
        engine.ingest(&data, NOW + 3_000);
        assert_eq!(engine.drink_amount(NOW + 3_000), Some(120.0));
        data.device.as_mut().unwrap().cup_present = false;
        engine.ingest(&data, NOW + 4_000);
        assert_eq!(engine.drink_amount(NOW + 4_000), Some(120.0));
        assert_eq!(engine.drink_amount(NOW + 6_000), None);
        engine.mark_baseline();
        assert_eq!(engine.drink_amount(NOW + 4_000), None);
        data.events.push(event("while-offline", NOW + 5_000));
        engine.ingest(&data, NOW + 5_000);
        assert_eq!(engine.drink_amount(NOW + 5_000), None);
    }

    #[test]
    fn reported_drink_does_not_wait_for_the_return_heartbeat_or_replay_on_it() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        engine.ingest(&data, NOW);
        data.device.as_mut().unwrap().cup_present = false;
        engine.ingest(&data, NOW + 1_000);
        assert_eq!(engine.drink_amount(NOW + 1_000), None);
        data.events
            .push(event("reported-after-return", NOW + 2_000));
        assert!(engine.ingest(&data, NOW + 3_000));
        assert_eq!(engine.drink_amount(NOW + 3_000), Some(30.5));
        data.device.as_mut().unwrap().cup_present = true;
        assert!(!engine.ingest(&data, NOW + 8_000));
        assert_eq!(engine.drink_amount(NOW + 8_000), None);
    }

    #[test]
    fn zero_amount_does_not_switch_the_display() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        engine.ingest(&data, NOW);
        let mut zero = event("zero", NOW + 1_000);
        zero.amount_ml = 0.0;
        data.events.push(zero);
        engine.ingest(&data, NOW + 1_000);
        assert_eq!(engine.drink_amount(NOW + 1_000), None);
    }

    #[test]
    fn revoked_drink_cannot_remain_the_current_amount() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        engine.ingest(&data, NOW);
        data.events.push(event("drink", NOW + 1_000));
        engine.ingest(&data, NOW + 1_000);
        assert_eq!(engine.drink_amount(NOW + 1_000), Some(30.5));
        data.events[0].revoked_at = Some("2026-10-22T00:00:02Z".into());
        engine.ingest(&data, NOW + 2_000);
        assert_eq!(engine.drink_amount(NOW + 2_000), None);
    }

    #[test]
    fn an_absent_cup_on_initial_sync_or_recovery_does_not_replay_a_lift() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        let settings = Settings::default();
        data.device.as_mut().unwrap().cup_present = false;
        engine.ingest(&data, NOW);
        assert_eq!(
            engine.tick(NOW, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
        data.device.as_mut().unwrap().cup_present = true;
        engine.ingest(&data, NOW + 1_000);
        data.device.as_mut().unwrap().cup_present = false;
        engine.ingest(&data, NOW + 2_000);
        assert_eq!(
            engine.tick(NOW + 2_000, Some(0.0), false, true, &settings),
            CompanionState::Drinking
        );
        engine.mark_baseline();
        engine.ingest(&data, NOW + 3_000);
        assert_eq!(
            engine.tick(NOW + 3_000, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
        data.device.as_mut().unwrap().cup_present = true;
        engine.ingest(&data, NOW + 4_000);
        data.device.as_mut().unwrap().cup_present = false;
        data.device.as_mut().unwrap().binding_id = Some("new-binding".into());
        engine.ingest(&data, NOW + 5_000);
        assert_eq!(
            engine.tick(NOW + 5_000, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
    }

    #[test]
    fn invalid_device_status_cancels_lifting_and_requires_a_new_transition() {
        for problem in 0..5 {
            let mut engine = Engine::new();
            let mut data = dashboard();
            let settings = Settings::default();
            engine.ingest(&data, NOW);
            data.device.as_mut().unwrap().cup_present = false;
            engine.ingest(&data, NOW + 1_000);
            assert_eq!(
                engine.tick(NOW + 1_000, Some(0.0), false, true, &settings),
                CompanionState::Drinking
            );
            match problem {
                0 => data.device.as_mut().unwrap().online = false,
                1 => data.device.as_mut().unwrap().calibrated = false,
                2 => data.device.as_mut().unwrap().empty_cup_grams = None,
                3 => data.device.as_mut().unwrap().error = Some("传感器异常".into()),
                _ => data.device = None,
            }
            engine.ingest(&data, NOW + 2_000);
            assert_eq!(
                engine.tick(NOW + 2_000, Some(0.0), false, false, &settings),
                CompanionState::Working
            );
            data = dashboard();
            data.device.as_mut().unwrap().cup_present = false;
            engine.ingest(&data, NOW + 3_000);
            assert_eq!(
                engine.tick(NOW + 3_000, Some(0.0), false, true, &settings),
                CompanionState::Working
            );
        }
    }

    #[test]
    fn lock_and_cloud_disconnect_stop_lifting_without_replaying_after_recovery() {
        for locked in [false, true] {
            let mut engine = Engine::new();
            let mut data = dashboard();
            let settings = Settings::default();
            engine.ingest(&data, NOW);
            data.device.as_mut().unwrap().cup_present = false;
            engine.ingest(&data, NOW + 1_000);
            assert_eq!(
                engine.tick(NOW + 1_000, Some(0.0), false, true, &settings),
                CompanionState::Drinking
            );
            assert_ne!(
                engine.tick(NOW + 2_000, Some(0.0), locked, locked, &settings),
                CompanionState::Drinking
            );
            engine.tick(NOW + 3_000, Some(0.0), false, true, &settings);
            engine.ingest(&data, NOW + 4_000);
            assert_eq!(
                engine.tick(NOW + 4_000, Some(0.0), false, true, &settings),
                CompanionState::Working
            );
        }
    }

    #[test]
    fn initial_sync_is_quiet_and_a_batch_plays_once_for_four_seconds() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        data.events.push(event("initial", NOW));
        assert!(!engine.ingest(&data, NOW));
        assert_eq!(
            engine.tick(NOW, Some(0.0), false, true, &Settings::default()),
            CompanionState::Working
        );
        data.events
            .extend([event("a", NOW + 1_000), event("b", NOW + 1_000)]);
        assert!(engine.ingest(&data, NOW + 1_000));
        assert!(!engine.ingest(&data, NOW + 1_000));
        assert_eq!(
            engine.tick(NOW + 4_999, Some(0.0), false, true, &Settings::default()),
            CompanionState::Drinking
        );
        assert_eq!(
            engine.tick(NOW + 5_000, Some(0.0), false, true, &Settings::default()),
            CompanionState::Working
        );
    }

    #[test]
    fn refill_revoked_old_future_and_other_binding_do_not_trigger_drinking() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        engine.ingest(&data, NOW);
        let mut refill = event("refill", NOW);
        refill.kind = EventKind::Refill;
        let mut revoked = event("revoked", NOW);
        revoked.revoked_at = Some("2026-10-22T00:00:00Z".into());
        let mut other = event("other", NOW);
        other.binding_id = Some("old-binding".into());
        data.events.extend([
            refill,
            revoked,
            other,
            event("old", NOW - FRESH_EVENT_MS - 1),
            event("future", NOW + 1),
        ]);
        assert!(!engine.ingest(&data, NOW));
        assert_eq!(
            engine.tick(NOW, Some(0.0), false, true, &Settings::default()),
            CompanionState::Working
        );
    }

    #[test]
    fn recovery_and_binding_change_establish_new_baselines() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        engine.ingest(&data, NOW);
        engine.mark_baseline();
        data.events.push(event("during-offline", NOW));
        assert!(!engine.ingest(&data, NOW));
        data.events.push(event("after-recovery", NOW + 1));
        assert!(engine.ingest(&data, NOW + 1));
        data.device.as_mut().unwrap().binding_id = Some("new-binding".into());
        let mut bound_event = event("new-account-data", NOW + 2);
        bound_event.binding_id = Some("new-binding".into());
        data.events.push(bound_event);
        assert!(!engine.ingest(&data, NOW + 2));
        engine.reset();
        assert!(!engine.ingest(&data, NOW + 3));
    }

    #[test]
    fn recovered_old_drink_resets_reminder_without_animation_or_repeated_resets() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        engine.ingest(&data, NOW);
        engine.active_ms = REMINDER_MS;
        engine.reminded = true;
        engine.mark_baseline();
        data.events.push(event("offline-drink", NOW - 300_000));
        assert!(!engine.ingest(&data, NOW));
        assert_eq!(engine.active_ms, 0);
        assert!(!engine.reminded);
        assert_eq!(
            engine.tick(NOW, Some(0.0), false, true, &Settings::default()),
            CompanionState::Working
        );
        engine.tick(NOW + 1_000, Some(0.0), false, true, &Settings::default());
        assert_eq!(engine.active_ms, 1_000);
        assert!(!engine.ingest(&data, NOW + 1_000));
        assert_eq!(engine.active_ms, 1_000);
    }

    #[test]
    fn invalid_or_unrelated_events_do_not_reset_reminders() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        engine.ingest(&data, NOW);
        engine.active_ms = 30_000;
        engine.reminded = true;
        let mut refill = event("refill", NOW);
        refill.kind = EventKind::Refill;
        let mut revoked = event("revoked", NOW - 300_000);
        revoked.revoked_at = Some("2026-10-22T00:00:00Z".into());
        let mut other = event("other-binding", NOW);
        other.binding_id = Some("old-binding".into());
        let mut invalid = event("invalid-time", NOW);
        invalid.occurred_at = "invalid".into();
        data.events
            .extend([refill, revoked, other, invalid, event("future", NOW + 1)]);
        assert!(!engine.ingest(&data, NOW));
        assert_eq!(engine.active_ms, 30_000);
        assert!(engine.reminded);
    }

    #[test]
    fn midnight_does_not_animate_totals_or_skip_the_first_new_drink() {
        let mut engine = Engine::new();
        let mut data = dashboard();
        data.events.push(event("yesterday", NOW));
        engine.ingest(&data, NOW);
        data.date = "2026-10-23".into();
        assert!(!engine.ingest(&data, NOW + 1));
        data.events = vec![event("today", NOW + 5_000)];
        assert!(engine.ingest(&data, NOW + 5_000));
        data.totals.drink_ml = 0.0;
        data.events[0].revoked_at = Some("2026-10-23T00:00:00Z".into());
        assert!(!engine.ingest(&data, NOW + 5_001));
    }

    #[test]
    fn sleep_unknown_idle_and_disabled_rest_have_distinct_states() {
        let mut engine = Engine::new();
        let settings = Settings::default();
        assert_eq!(
            engine.tick(NOW, Some(300.0), false, true, &settings),
            CompanionState::Sleeping
        );
        assert_eq!(
            engine.tick(NOW + 1, Some(1.0), false, true, &settings),
            CompanionState::Working
        );
        assert_eq!(
            engine.tick(NOW + 2, None, false, true, &settings),
            CompanionState::Idle
        );
        assert_eq!(
            engine.tick(NOW + 3, Some(f64::NAN), false, true, &settings),
            CompanionState::Idle
        );
        assert_eq!(
            engine.tick(
                NOW + 4,
                Some(400.0),
                false,
                true,
                &Settings {
                    auto_rest: false,
                    ..settings
                }
            ),
            CompanionState::Working
        );
    }

    #[test]
    fn reminders_count_only_active_time_once_until_a_new_drink() {
        let mut engine = Engine::new();
        let settings = Settings::default();
        let mut data = dashboard();
        engine.ingest(&data, NOW);
        let mut time = NOW;
        engine.tick(time, Some(0.0), false, true, &settings);
        for _ in 0..3_599 {
            time += 1_000;
            assert_eq!(
                engine.tick(time, Some(0.0), false, true, &settings),
                CompanionState::Working
            );
        }
        time += 1_000;
        assert_eq!(
            engine.tick(time, Some(0.0), false, true, &settings),
            CompanionState::Reminding
        );
        for _ in 0..5 {
            time += 1_000;
            engine.tick(time, Some(0.0), false, true, &settings);
        }
        assert_eq!(
            engine.tick(time, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
        for _ in 0..3_601 {
            time += 1_000;
            assert_eq!(
                engine.tick(time, Some(0.0), false, true, &settings),
                CompanionState::Working
            );
        }
        data.events.push(event("reset-timer", time));
        assert!(engine.ingest(&data, time));
        assert_eq!(engine.active_ms, 0);
        assert!(!engine.reminded);
    }

    #[test]
    fn paused_time_and_wake_gaps_never_count_as_work() {
        let mut engine = Engine::new();
        let settings = Settings::default();
        engine.tick(NOW, Some(0.0), false, true, &settings);
        engine.tick(NOW + 1_000, Some(0.0), false, true, &settings);
        assert_eq!(engine.active_ms, 1_000);
        engine.tick(NOW + 2_000, Some(300.0), false, true, &settings);
        engine.tick(NOW + 3_000, Some(0.0), false, false, &settings);
        engine.tick(NOW + 4_000, Some(0.0), true, true, &settings);
        engine.tick(NOW + REMINDER_MS, Some(0.0), false, true, &settings);
        assert_eq!(engine.active_ms, 1_000);
        assert!(engine.needs_baseline);
        let mut data = dashboard();
        data.events.push(event("wake-backlog", NOW + REMINDER_MS));
        assert!(!engine.ingest(&data, NOW + REMINDER_MS));
        assert_eq!(
            engine.tick(NOW + REMINDER_MS + 1_000, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
    }

    #[test]
    fn disabling_reminders_prevents_actions_and_stops_the_timer() {
        let mut engine = Engine::new();
        let settings = Settings {
            reminders: false,
            ..Settings::default()
        };
        engine.active_ms = REMINDER_MS;
        assert_eq!(
            engine.tick(NOW, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
        assert_eq!(
            engine.tick(NOW + 1_000, Some(0.0), false, true, &settings),
            CompanionState::Working
        );
        assert_eq!(engine.active_ms, REMINDER_MS);
    }
}
