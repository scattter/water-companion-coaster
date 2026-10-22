use std::time::Duration;

use reqwest::{header, Client, RequestBuilder, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::{
    credentials::valid_token,
    model::{Dashboard, Session},
};

#[derive(Debug)]
pub struct ApiError {
    pub message: String,
    pub unauthorized: bool,
}

impl ApiError {
    fn message(value: impl Into<String>) -> Self {
        Self {
            message: value.into(),
            unauthorized: false,
        }
    }
}

#[derive(Clone)]
pub struct Api {
    client: Client,
}

impl Api {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("WaterCompanion/0.1")
            .build()
            .map_err(|_| "无法初始化网络连接。")?;
        Ok(Self { client })
    }

    fn get(&self, origin: &str, path: &str, token: Option<&str>) -> RequestBuilder {
        let request = self.client.get(format!("{origin}{path}"));
        Self::with_session(request, token)
    }

    fn with_session(request: RequestBuilder, token: Option<&str>) -> RequestBuilder {
        if let Some(token) = token.filter(|value| valid_token(value)) {
            request.header(header::COOKIE, format!("coaster_session={token}"))
        } else {
            request
        }
    }

    pub async fn health(&self, origin: &str) -> Result<(), ApiError> {
        let (_, value): (_, Value) = read(self.get(origin, "/api/health", None)).await?;
        if value.get("ok") == Some(&Value::Bool(true)) {
            Ok(())
        } else {
            Err(ApiError::message(
                "此地址没有返回饮水服务的健康状态，请填写服务根地址。",
            ))
        }
    }

    pub async fn login(
        &self,
        origin: &str,
        username: &str,
        password: &str,
    ) -> Result<(Session, String), ApiError> {
        let (headers, session): (_, Session) = read(
            self.client
                .post(format!("{origin}/api/auth/login"))
                .json(&json!({ "username": username.trim(), "password": password })),
        )
        .await?;
        if session.user.is_none() {
            return Err(ApiError::message("服务器没有返回有效登录账号。"));
        }
        let token = session_cookie(&headers, origin.starts_with("https://"))
            .ok_or_else(|| ApiError::message("服务器没有返回有效登录会话。"))?;
        Ok((session, token))
    }

    pub async fn session(&self, origin: &str, token: &str) -> Result<Session, ApiError> {
        let (_, session): (_, Session) =
            read(self.get(origin, "/api/auth/session", Some(token))).await?;
        if session.user.is_none() {
            return Err(ApiError {
                message: "登录已过期，请重新登录。".into(),
                unauthorized: true,
            });
        }
        Ok(session)
    }

    pub async fn dashboard(&self, origin: &str, token: &str) -> Result<Dashboard, ApiError> {
        read(self.get(origin, "/api/dashboard", Some(token)))
            .await
            .map(|(_, data)| data)
    }

    pub async fn logout(&self, origin: &str, token: &str) -> Result<(), ApiError> {
        let request = Self::with_session(
            self.client.post(format!("{origin}/api/auth/logout")),
            Some(token),
        )
        .json(&json!({}));
        let _: (_, Value) = read(request).await?;
        Ok(())
    }
}

fn session_cookie(headers: &header::HeaderMap, secure_transport: bool) -> Option<String> {
    let tokens: Vec<_> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter(|value| {
            secure_transport
                || !value
                    .split(';')
                    .skip(1)
                    .any(|part| part.trim().eq_ignore_ascii_case("secure"))
        })
        .filter_map(|value| value.split(';').next())
        .filter_map(|value| value.trim().strip_prefix("coaster_session="))
        .collect();
    (tokens.len() == 1 && valid_token(tokens[0])).then(|| tokens[0].to_owned())
}

fn transport_error(error: reqwest::Error) -> ApiError {
    let message = if error.is_timeout() {
        "连接超时，请检查服务器地址和网络。"
    } else {
        let mut source = std::error::Error::source(&error);
        let mut certificate = false;
        while let Some(value) = source {
            let text = value.to_string().to_lowercase();
            certificate |= text.contains("certificate") || text.contains("certvalid");
            source = value.source();
        }
        if certificate {
            "HTTPS 证书验证失败，请检查证书是否有效、是否匹配当前域名或 IP。"
        } else {
            "无法连接服务器，请检查地址、网络和服务是否正常。"
        }
    };
    ApiError::message(message)
}

fn response_error(status: StatusCode, data: Option<&Value>) -> ApiError {
    let message = if status.is_redirection() {
        "服务器要求跳转，请直接配置最终服务地址。".to_owned()
    } else if status == StatusCode::UNAUTHORIZED {
        data.and_then(|value| value.get("message").or_else(|| value.get("error")))
            .and_then(Value::as_str)
            .map(|value| value.chars().take(300).collect())
            .unwrap_or_else(|| "登录已过期，请重新登录。".to_owned())
    } else if status == StatusCode::FORBIDDEN {
        "服务器拒绝此访问地址，请使用部署配置允许的域名或 IP。".to_owned()
    } else {
        data.and_then(|value| value.get("message").or_else(|| value.get("error")))
            .and_then(Value::as_str)
            .map(|value| value.chars().take(300).collect())
            .unwrap_or_else(|| format!("服务器请求失败（{}）。", status.as_u16()))
    };
    ApiError {
        message,
        unauthorized: status == StatusCode::UNAUTHORIZED,
    }
}

async fn read<T: DeserializeOwned>(
    request: RequestBuilder,
) -> Result<(header::HeaderMap, T), ApiError> {
    let mut response = request.send().await.map_err(transport_error)?;
    let status = response.status();
    let headers = response.headers().clone();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err(ApiError::message("服务器返回的数据过大。"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(response_error(
            status,
            serde_json::from_slice::<Value>(&bytes).ok().as_ref(),
        ));
    }
    serde_json::from_slice(&bytes)
        .map(|data| (headers, data))
        .map_err(|_| ApiError::message("服务器返回的数据格式不正确，请确认地址指向饮水服务。"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_one_well_formed_session_cookie() {
        let mut headers = header::HeaderMap::new();
        let token = "a1".repeat(32);
        headers.append(
            header::SET_COOKIE,
            format!("coaster_session={token}; Path=/; HttpOnly; SameSite=Strict")
                .parse()
                .unwrap(),
        );
        assert_eq!(session_cookie(&headers, true), Some(token));
        headers.append(
            header::SET_COOKIE,
            "coaster_session=invalid; Path=/".parse().unwrap(),
        );
        assert_eq!(session_cookie(&headers, true), None);
    }

    #[test]
    fn does_not_send_a_secure_session_over_http() {
        let mut headers = header::HeaderMap::new();
        let token = "a1".repeat(32);
        headers.append(
            header::SET_COOKIE,
            format!("coaster_session={token}; HttpOnly; Secure")
                .parse()
                .unwrap(),
        );
        assert_eq!(session_cookie(&headers, false), None);
        assert_eq!(session_cookie(&headers, true), Some(token));
    }

    #[test]
    fn distinguishes_expiry_host_rejection_and_redirects() {
        assert!(response_error(StatusCode::UNAUTHORIZED, None).unauthorized);
        assert_eq!(
            response_error(
                StatusCode::UNAUTHORIZED,
                Some(&json!({"error":"用户名或密码错误"}))
            )
            .message,
            "用户名或密码错误"
        );
        assert!(response_error(StatusCode::FORBIDDEN, None)
            .message
            .contains("域名或 IP"));
        assert!(response_error(StatusCode::FOUND, None)
            .message
            .contains("最终服务地址"));
        assert!(!response_error(StatusCode::SERVICE_UNAVAILABLE, None).unauthorized);
    }
}
