const SERVICE: &str = "com.watercompanion.client.session";

#[cfg(target_os = "macos")]
fn disable_prompts() -> Result<(), String> {
    use security_framework::os::macos::keychain::{KeychainUserInteractionLock, SecKeychain};
    use std::sync::OnceLock;

    // 此开关作用于整个进程；一直保留 guard，避免并发操作或 guard 析构时重新打开系统弹窗。
    static INTERACTION_LOCK: OnceLock<Result<KeychainUserInteractionLock, String>> = OnceLock::new();
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
    match get_generic_password(SERVICE, origin) {
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
        Err(_) => Err("保存的登录状态已不可用，请重新登录客户端。".into()),
    }
}

#[cfg(target_os = "macos")]
pub fn save(origin: &str, token: &str) -> Result<(), String> {
    if !valid_token(token) {
        return Err("服务器返回的登录信息无效。".into());
    }
    disable_prompts()?;
    security_framework::passwords::set_generic_password(SERVICE, origin, token.as_bytes())
        .map_err(|_| "无法保存登录信息，请检查“登录”钥匙串是否已解锁后重试。".into())
}

#[cfg(target_os = "macos")]
pub fn remove(origin: &str) -> Result<(), String> {
    disable_prompts()?;
    match security_framework::passwords::delete_generic_password(SERVICE, origin) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("无法清除登录信息，请检查“登录”钥匙串是否已解锁后重试。".into()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read(_: &str) -> Result<Option<String>, String> {
    Ok(None)
}
#[cfg(not(target_os = "macos"))]
pub fn save(_: &str, _: &str) -> Result<(), String> {
    Err("此版本仅提供 macOS 安全会话存储。".into())
}
#[cfg(not(target_os = "macos"))]
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
}
