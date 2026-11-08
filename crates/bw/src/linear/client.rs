//! One GraphQL request to Linear. The key comes from the Keychain through `security` and goes to curl in
//! its config on standard input, so it is never in an argument list, a file or this helper's output.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

use super::{fail, Fail};

pub const ENDPOINT: &str = "https://api.linear.app/graphql";
const SERVICE: &str = "bellwether.linear";
const MAX_REPLY: usize = 8 * 1024 * 1024;
/// curl's exit codes for a network that is not there: resolve, connect, timeout, TLS connect, empty reply,
/// send and receive.
const OFFLINE_CODES: [i32; 8] = [5, 6, 7, 28, 35, 52, 55, 56];

/// `BW_LINEAR_URL` lets tests point at a loopback server; nothing else may receive the key.
pub fn endpoint() -> Result<String, Fail> {
    let Some(url) = std::env::var("BW_LINEAR_URL")
        .ok()
        .filter(|u| !u.is_empty())
    else {
        return Ok(ENDPOINT.to_string());
    };
    let loopback = url.strip_prefix("http://127.0.0.1:").is_some_and(|rest| {
        let port = rest.split('/').next().unwrap_or("");
        !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit())
    });
    if url == ENDPOINT || loopback {
        Ok(url)
    } else {
        Err(fail(
            "usage",
            "BW_LINEAR_URL must be Linear's endpoint or http://127.0.0.1:<port>/",
        ))
    }
}

fn program(var: &str, default: &str) -> String {
    std::env::var(var)
        .ok()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// The key, or `no_key`. The Keychain item is written by `scripts/linear-key.sh`.
fn read_key() -> Result<String, Fail> {
    let out = Command::new(program("BW_SECURITY", "/usr/bin/security"))
        .args(["find-generic-password", "-s", SERVICE, "-w"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| fail("no_key", format!("could not run security: {e}")))?;
    let key = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || key.is_empty() {
        return Err(fail(
            "no_key",
            "No Linear key in this Mac's Keychain: run scripts/linear-key.sh",
        ));
    }
    // A value with a quote or a line break could write its own curl options.
    if !key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(fail(
            "no_key",
            "The Keychain's bellwether.linear item is not a Linear key: run scripts/linear-key.sh",
        ));
    }
    Ok(key)
}

/// A curl config value in double quotes, where `\` and `"` are the escapes curl reads.
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// What came back, before it is read as GraphQL.
struct Reply {
    status: u16,
    body: Vec<u8>,
}

fn send(url: &str, key: &str, body: &str) -> Result<Reply, Fail> {
    let mut child = Command::new(program("BW_CURL", "/usr/bin/curl"))
        .args([
            "-sS",
            "--max-time",
            "20",
            "--proto",
            "=https,http",
            "-K",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| fail("linear_failed", format!("could not run curl: {e}")))?;
    let config = format!(
        "url = {}\nrequest = \"POST\"\nheader = {}\nheader = \"Content-Type: application/json\"\n\
         data-binary = {}\nwrite-out = \"\\n%{{http_code}}\"\n",
        quoted(url),
        quoted(&format!("Authorization: {key}")),
        quoted(body),
    );
    {
        let mut stdin = child.stdin.take().expect("piped stdin");
        let _ = stdin.write_all(config.as_bytes());
    }
    let mut out = Vec::new();
    let stdout = child.stdout.take().expect("piped stdout");
    let _ = stdout.take(MAX_REPLY as u64 + 1).read_to_end(&mut out);
    let mut err = String::new();
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let status = child
        .wait()
        .map_err(|e| fail("linear_failed", format!("waiting for curl: {e}")))?;
    if out.len() > MAX_REPLY {
        return Err(fail("linear_failed", "Linear's reply was over 8 MiB"));
    }
    let err = err.replace(key, "<key>");
    match status.code() {
        Some(0) => {}
        Some(c) if OFFLINE_CODES.contains(&c) => {
            return Err(fail(
                "offline",
                format!("Linear is unreachable: {}", err.trim()),
            ))
        }
        c => {
            return Err(fail(
                "linear_failed",
                format!("curl exited {}: {}", c.unwrap_or(-1), err.trim()),
            ))
        }
    }
    let cut = out.iter().rposition(|&b| b == b'\n').unwrap_or(0);
    let status = String::from_utf8_lossy(&out[(cut + 1).min(out.len())..])
        .trim()
        .parse()
        .unwrap_or(0);
    out.truncate(cut);
    Ok(Reply { status, body: out })
}

/// Posts a GraphQL request and returns its `data`, or a named failure.
pub fn post(body: &Value) -> Result<Value, Fail> {
    let url = endpoint()?;
    let key = read_key()?;
    let reply = send(&url, &key, &body.to_string())?;
    classify(reply.status, &reply.body)
}

fn classify(status: u16, body: &[u8]) -> Result<Value, Fail> {
    let v: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let errors = v["errors"].as_array().cloned().unwrap_or_default();
    let code = |e: &Value| e["extensions"]["code"].as_str().unwrap_or("").to_string();
    let first = errors
        .first()
        .and_then(|e| e["message"].as_str())
        .unwrap_or("")
        .to_string();
    if status == 401
        || status == 403
        || errors
            .iter()
            .any(|e| code(e) == "AUTHENTICATION_ERROR" || code(e) == "FORBIDDEN")
    {
        return Err(fail(
            "key_refused",
            "Linear refused the key: make a new personal key and run scripts/linear-key.sh",
        ));
    }
    if status == 429 || errors.iter().any(|e| code(e) == "RATELIMITED") {
        return Err(fail(
            "rate_limited",
            "Linear's rate limit was reached; try again in a minute",
        ));
    }
    if !errors.is_empty() {
        return Err(fail("linear_failed", format!("Linear answered: {first}")));
    }
    if status != 200 || !v["data"].is_object() {
        return Err(fail(
            "linear_failed",
            format!("Linear answered HTTP {status} without data"),
        ));
    }
    Ok(v["data"].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quoting_escapes_backslash_and_quote() {
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn errors_are_named() {
        let auth = json!({"errors":[{"message":"x","extensions":{"code":"AUTHENTICATION_ERROR"}}]});
        assert_eq!(
            classify(400, auth.to_string().as_bytes()).unwrap_err().code,
            "key_refused"
        );
        assert_eq!(classify(429, b"{}").unwrap_err().code, "rate_limited");
        assert_eq!(classify(500, b"oops").unwrap_err().code, "linear_failed");
        let ok = json!({"data":{"viewer":{"id":"u"}}});
        assert_eq!(
            classify(200, ok.to_string().as_bytes()).unwrap()["viewer"]["id"],
            "u"
        );
    }
}
