use url::Url;

pub fn normalize_address(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("请填写服务器地址。".into());
    }
    if input.chars().any(char::is_whitespace) || input.contains('\\') {
        return Err("服务器地址不能包含空格或反斜杠。".into());
    }
    let address = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&address).map_err(|_| "服务器地址无效，请填写域名或 IP，可附带端口。")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("服务器地址仅支持 HTTP 或 HTTPS。".into());
    }
    if url.host_str().is_none() {
        return Err("服务器地址缺少域名或 IP。".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("服务器地址不能包含账号或密码。".into());
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("请填写服务器根地址，不要附带 /api、其他路径、查询参数或锚点。".into());
    }
    if url.port() == Some(0) {
        return Err("服务器端口必须大于 0。".into());
    }
    Ok(url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::normalize_address;

    #[test]
    fn supports_domains_ips_and_ports() {
        for (input, expected) in [
            ("water.example.com", "https://water.example.com"),
            (
                " HTTPS://Water.Example.com:443/ ",
                "https://water.example.com",
            ),
            ("water.example.com:8443", "https://water.example.com:8443"),
            ("192.168.1.30", "https://192.168.1.30"),
            ("http://192.168.1.30:3001/", "http://192.168.1.30:3001"),
            ("[2001:db8::1]:8443", "https://[2001:db8::1]:8443"),
            ("http://[::1]:3001", "http://[::1]:3001"),
            ("http://localhost:3001", "http://localhost:3001"),
        ] {
            assert_eq!(normalize_address(input).unwrap(), expected, "{input}");
        }
    }

    #[test]
    fn rejects_non_origin_and_ambiguous_addresses() {
        for input in [
            "",
            "https://",
            "ftp://water.example.com",
            "file:///tmp/data",
            "https://alice:password@water.example.com",
            "https://alice@water.example.com",
            "https://water.example.com/api",
            "https://water.example.com/?token=secret",
            "https://water.example.com/#fragment",
            "https://water.example.com:0",
            "https://water.example.com:65536",
            "https://water.example.com\\@evil.example",
            "water. example.com",
            "2001:db8::1",
            "https://[::1",
        ] {
            assert!(normalize_address(input).is_err(), "{input}");
        }
    }
}
