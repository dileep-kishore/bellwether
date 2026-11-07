//! A Chrome DevTools Protocol client over the browser's WebSocket, loopback only.

use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

use super::http;

const VERSION_TIMEOUT: Duration = Duration::from_secs(2);

/// The browser WebSocket URL from `/json/version`, and the browser id that ends it.
pub fn browser_ws(port: u16) -> Result<(String, String), String> {
    let reply = http::get(port, "/json/version", VERSION_TIMEOUT)
        .map_err(|e| format!("GET http://127.0.0.1:{port}/json/version: {e}"))?;
    if reply.status != 200 {
        return Err(format!(
            "GET http://127.0.0.1:{port}/json/version answered {}",
            reply.status
        ));
    }
    let version: Value = serde_json::from_slice(&reply.body)
        .map_err(|e| format!("/json/version on {port} is not JSON: {e}"))?;
    let url = version["webSocketDebuggerUrl"]
        .as_str()
        .ok_or_else(|| format!("/json/version on {port} has no webSocketDebuggerUrl"))?;
    let id = url
        .rsplit('/')
        .next()
        .filter(|id| !id.is_empty() && url.contains("/devtools/browser/"))
        .ok_or_else(|| format!("{url:?} names no browser id"))?;
    Ok((url.to_string(), id.to_string()))
}

pub struct Cdp {
    ws: WebSocket<TcpStream>,
    timeout: Duration,
    next_id: u64,
}

impl Cdp {
    /// Connects only to `ws://127.0.0.1:<port>/…` or `ws://[::1]:<port>/…`.
    pub fn connect(ws_url: &str, timeout: Duration) -> Result<Cdp, String> {
        let addr = loopback_addr(ws_url)?;
        let stream = TcpStream::connect_timeout(&addr, timeout)
            .map_err(|e| format!("connect {ws_url}: {e}"))?;
        stream
            .set_read_timeout(Some(timeout))
            .and_then(|()| stream.set_write_timeout(Some(timeout)))
            .map_err(|e| format!("connect {ws_url}: {e}"))?;
        let (ws, _) =
            tungstenite::client(ws_url, stream).map_err(|e| format!("connect {ws_url}: {e}"))?;
        Ok(Cdp {
            ws,
            timeout,
            next_id: 1,
        })
    }

    /// Sends one command and waits for the reply with its id, skipping events and other replies.
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"id": id, "method": method, "params": params});
        self.ws
            .send(Message::text(request.to_string()))
            .map_err(|e| format!("{method}: {e}"))?;
        // One deadline per call, so a stream of events cannot keep it waiting.
        let deadline = Instant::now() + self.timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(format!("{method}: no reply within {:?}", self.timeout));
            }
            self.ws
                .get_mut()
                .set_read_timeout(Some(left))
                .map_err(|e| format!("{method}: {e}"))?;
            let msg = match self.ws.read() {
                Ok(msg) => msg,
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return Err(format!("{method}: no reply within {:?}", self.timeout))
                }
                Err(e) => return Err(format!("{method}: {e}")),
            };
            let text = match msg {
                Message::Text(text) => text,
                Message::Close(_) => {
                    return Err(format!("{method}: the browser closed the socket"))
                }
                _ => continue,
            };
            let Ok(reply) = serde_json::from_str::<Value>(text.as_str()) else {
                continue;
            };
            if reply["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = reply.get("error") {
                let message = error["message"].as_str().unwrap_or("unknown error");
                return Err(format!("{method}: {message}"));
            }
            return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
        }
    }
}

impl Drop for Cdp {
    fn drop(&mut self) {
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
    }
}

/// The address a loopback WebSocket URL names; anything else, userinfo included, is refused.
fn loopback_addr(url: &str) -> Result<SocketAddr, String> {
    let refuse = || format!("refusing {url:?}: only ws://127.0.0.1:<port>/ or ws://[::1]:<port>/");
    let (ip, rest) = if let Some(rest) = url.strip_prefix("ws://127.0.0.1:") {
        (IpAddr::V4(Ipv4Addr::LOCALHOST), rest)
    } else if let Some(rest) = url.strip_prefix("ws://[::1]:") {
        (IpAddr::V6(Ipv6Addr::LOCALHOST), rest)
    } else {
        return Err(refuse());
    };
    let end = rest.find('/').unwrap_or(rest.len());
    let digits = &rest[..end];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(refuse());
    }
    let port: u16 = digits.parse().map_err(|_| refuse())?;
    if port == 0 {
        return Err(refuse());
    }
    Ok(SocketAddr::new(ip, port))
}
