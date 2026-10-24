#[cfg(target_os = "macos")]
const SERVICE: &str = "com.watercompanion.client.session";

#[cfg(target_os = "macos")]
fn service_name() -> Result<&'static str, String> {
    use sha2::{Digest, Sha256};
    use std::{fs::File, sync::OnceLock};

    // 本地临时签名随构建改变，旧条目的访问权限不会继承；每个可执行版本使用独立条目。
    static NAME: OnceLock<Result<String, String>> = OnceLock::new();
    NAME.get_or_init(|| {
        let executable =
            std::env::current_exe().map_err(|_| "无法定位客户端，请重新启动后再试。")?;
        let mut file = File::open(executable).map_err(|_| "无法读取客户端，请重新安装后再试。")?;
        let mut hash = Sha256::new();
        std::io::copy(&mut file, &mut hash)
            .map_err(|_| "无法识别客户端版本，请重新安装后再试。")?;
        Ok(format!("{SERVICE}.{:x}", hash.finalize()))
    })
    .as_ref()
    .map(String::as_str)
    .map_err(Clone::clone)
}

#[cfg(target_os = "macos")]
fn keychain_error(action: &str, code: i32) -> String {
    if matches!(code, -25308 | -25293) {
        format!(
            "系统钥匙串暂不允许{action}登录信息（错误 {code}）。请确认“登录”钥匙串已解锁后重试。"
        )
    } else {
        format!("无法{action}登录信息（钥匙串错误 {code}），请稍后重试。")
    }
}

#[cfg(target_os = "macos")]
fn disable_prompts() -> Result<(), String> {
    use security_framework::os::macos::keychain::{KeychainUserInteractionLock, SecKeychain};
    use std::sync::OnceLock;

    // 此开关作用于整个进程；一直保留 guard，避免并发操作或 guard 析构时重新打开系统弹窗。
    static INTERACTION_LOCK: OnceLock<Result<KeychainUserInteractionLock, String>> =
        OnceLock::new();
    INTERACTION_LOCK
        .get_or_init(|| {
            SecKeychain::disable_user_interaction()
                .map_err(|_| "无法初始化登录凭证存储，请重启客户端后再试。".into())
        })
        .as_ref()
        .map(|_| ())
        .map_err(Clone::clone)
}

pub fn valid_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

#[cfg(target_os = "macos")]
pub fn read(origin: &str) -> Result<Option<String>, String> {
    use security_framework::passwords::get_generic_password;
    disable_prompts()?;
    match get_generic_password(service_name()?, origin) {
        Ok(bytes) => String::from_utf8(bytes)
            .map_err(|_| "保存的登录信息无效，请重新登录。".into())
            .and_then(|value| {
                if valid_token(&value) {
                    Ok(Some(value))
                } else {
                    Err("保存的登录信息无效，请重新登录。".into())
                }
            }),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(keychain_error("读取", error.code())),
    }
}

#[cfg(target_os = "macos")]
pub fn save(origin: &str, token: &str) -> Result<(), String> {
    if !valid_token(token) {
        return Err("服务器返回的登录信息无效。".into());
    }
    disable_prompts()?;
    security_framework::passwords::set_generic_password(service_name()?, origin, token.as_bytes())
        .map_err(|error| keychain_error("保存", error.code()))
}

#[cfg(target_os = "macos")]
pub fn remove(origin: &str) -> Result<(), String> {
    disable_prompts()?;
    match security_framework::passwords::delete_generic_password(service_name()?, origin) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(error) => Err(keychain_error("清除", error.code())),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn read(_: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn save(_: &str, _: &str) -> Result<(), String> {
    Err("此版本仅提供 macOS 安全会话存储。".into())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn remove(_: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_cookie_injection_and_malformed_tokens() {
        assert!(valid_token(&"a1".repeat(32)));
        assert!(!valid_token(&"A1".repeat(32)));
        assert!(!valid_token("abc; injected=1"));
        assert!(!valid_token(&"g".repeat(64)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "需要本机已解锁的钥匙串；仅创建并清理随机测试账号"]
    fn current_build_credentials_do_not_touch_legacy_entries() {
        use security_framework::passwords::{
            delete_generic_password, get_generic_password, set_generic_password,
        };

        disable_prompts().unwrap();
        let origin = format!(
            "https://keychain-check-{}-{}.invalid",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        );
        let legacy = "a1".repeat(32);
        let current = "b2".repeat(32);
        let replacement = "c3".repeat(32);
        let result = std::panic::catch_unwind(|| -> Result<(), String> {
            set_generic_password(SERVICE, &origin, legacy.as_bytes()).map_err(|e| e.to_string())?;
            remove(&origin)?;
            assert!(read(&origin)?.is_none());
            save(&origin, &current)?;
            assert_eq!(read(&origin)?.as_deref(), Some(current.as_str()));
            save(&origin, &replacement)?;
            assert_eq!(read(&origin)?.as_deref(), Some(replacement.as_str()));
            remove(&origin)?;
            assert!(read(&origin)?.is_none());
            assert_eq!(
                get_generic_password(SERVICE, &origin).map_err(|e| e.to_string())?,
                legacy.as_bytes()
            );
            Ok(())
        });
        let cleanup_current = remove(&origin);
        let cleanup_legacy = delete_generic_password(SERVICE, &origin);
        result.unwrap().unwrap();
        cleanup_current.unwrap();
        cleanup_legacy.unwrap();
    }
}

#[cfg(target_os = "windows")]
extern "C" {
    fn coaster_credential_read(origin: *const std::ffi::c_char, token: *mut u8) -> u32;
    fn coaster_credential_save(origin: *const std::ffi::c_char, token: *const u8) -> u32;
    fn coaster_credential_remove(origin: *const std::ffi::c_char) -> u32;
}
#[cfg(target_os = "windows")]
fn credential_origin(origin: &str) -> Result<std::ffi::CString, String> {
    std::ffi::CString::new(origin).map_err(|_| "服务器地址无效。".into())
}
#[cfg(target_os = "windows")]
fn windows_error(code: u32) -> String {
    format!("无法访问 Windows 登录凭证（错误 {code}），请稍后重试。")
}
#[cfg(target_os = "windows")]
pub fn read(origin: &str) -> Result<Option<String>, String> {
    let origin = credential_origin(origin)?;
    let mut bytes = [0u8; 64];
    match unsafe { coaster_credential_read(origin.as_ptr(), bytes.as_mut_ptr()) } {
        0 => {
            let value = String::from_utf8(bytes.to_vec())
                .map_err(|_| "保存的登录信息无效，请重新登录。")?;
            if valid_token(&value) {
                Ok(Some(value))
            } else {
                Err("保存的登录信息无效，请重新登录。".into())
            }
        }
        1168 => Ok(None),
        code => Err(windows_error(code)),
    }
}
#[cfg(target_os = "windows")]
pub fn save(origin: &str, token: &str) -> Result<(), String> {
    if !valid_token(token) {
        return Err("服务器返回的登录信息无效。".into());
    }
    let origin = credential_origin(origin)?;
    match unsafe { coaster_credential_save(origin.as_ptr(), token.as_ptr()) } {
        0 => Ok(()),
        code => Err(windows_error(code)),
    }
}
#[cfg(target_os = "windows")]
pub fn remove(origin: &str) -> Result<(), String> {
    let origin = credential_origin(origin)?;
    match unsafe { coaster_credential_remove(origin.as_ptr()) } {
        0 => Ok(()),
        code => Err(windows_error(code)),
    }
}
