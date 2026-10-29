use crate::model::Settings;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub server: Option<String>,
    pub settings: Settings,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retired_window_preferences_preserve_server_and_reminders() {
        let preferences: Preferences = serde_json::from_str(
            r#"{"server":"https://water.example.com","settings":{"showCompanion":true,"alwaysOnTop":true,"autoRest":false,"reminders":false},"position":{"x":20,"y":40}}"#,
        )
        .unwrap();
        assert_eq!(
            preferences.server.as_deref(),
            Some("https://water.example.com")
        );
        assert!(!preferences.settings.auto_rest);
        assert!(!preferences.settings.reminders);
        assert_eq!(
            preferences.settings.character,
            crate::model::Character::Robot
        );
        let saved = serde_json::to_value(preferences).unwrap();
        assert!(saved.get("position").is_none());
        assert!(saved["settings"].get("showCompanion").is_none());
        assert!(saved["settings"].get("alwaysOnTop").is_none());
    }

    #[test]
    fn character_selection_survives_reload_without_changing_other_preferences() {
        let directory = std::env::temp_dir().join(format!(
            "coaster-character-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let storage = Storage::new(&directory).unwrap();
        for character in ["robot", "cat", "dog", "girl", "boy", "capybara"] {
            let expected: Preferences = serde_json::from_value(serde_json::json!({
                "server": "https://water.example.com",
                "settings": { "autoRest": false, "reminders": true, "character": character }
            }))
            .unwrap();
            storage.save(&expected).unwrap();
            let restored = Storage::new(&directory).unwrap().load().unwrap();
            assert_eq!(restored.server, expected.server);
            assert_eq!(restored.settings, expected.settings);
            assert_eq!(
                serde_json::to_value(&restored.settings).unwrap()["character"],
                character
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unknown_character_falls_back_without_discarding_server_or_preferences() {
        let preferences: Preferences = serde_json::from_str(
            r#"{"server":"https://water.example.com","settings":{"character":"future-character","autoRest":false,"reminders":false}}"#,
        ).unwrap();
        assert_eq!(
            preferences.settings.character,
            crate::model::Character::Robot
        );
        assert_eq!(
            preferences.server.as_deref(),
            Some("https://water.example.com")
        );
        assert!(!preferences.settings.auto_rest);
        assert!(!preferences.settings.reminders);
    }
}

pub struct Storage {
    path: PathBuf,
}

impl Storage {
    pub fn new(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(|_| "无法创建客户端设置目录。")?;
        Ok(Self {
            path: directory.join("preferences.json"),
        })
    }

    pub fn load(&self) -> Result<Preferences, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "本机设置文件损坏，请重新配置服务器。".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(Preferences::default())
            }
            Err(_) => Err("无法读取本机设置。".into()),
        }
    }

    pub fn save(&self, preferences: &Preferences) -> Result<(), String> {
        let temp = self.path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(preferences).map_err(|_| "无法保存本机设置。")?;
        fs::write(&temp, bytes)
            .and_then(|_| fs::rename(&temp, &self.path))
            .map_err(|_| "无法保存本机设置。".into())
    }
}
