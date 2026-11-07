//! The Chrome's pages as the user sees them, and which of them is each window's active tab.
//!
//! Only std, `super::cdp` and `super::http`, so `tests/arrange.rs` can compile it beside them.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{cdp, http};

const HTTP_TIMEOUT: Duration = Duration::from_secs(2);
/// Per CDP call; a page held by a JavaScript dialog never answers `Runtime.evaluate`.
const CDP_TIMEOUT: Duration = Duration::from_secs(1);
/// All focus reads together, so a few stuck pages cannot stall the panel's poll.
const FOCUS_BUDGET: Duration = Duration::from_secs(3);

/// Chrome's ids are hex; anything else could change the endpoint path it is pasted into.
pub fn is_target_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A tab the user sees: DevTools windows and extension pages are pages to Chrome too.
pub fn is_page(t: &Value) -> bool {
    let url = t["url"].as_str().unwrap_or_default();
    t["type"] == "page"
        && t["id"].as_str().is_some_and(is_target_id)
        && !url.starts_with("devtools://")
        && !url.starts_with("chrome-extension://")
}

/// `/json/list`'s pages in its order, which is newest first.
pub fn list(port: u16) -> Result<Vec<Value>, String> {
    let reply = http::get(port, "/json/list", HTTP_TIMEOUT)
        .map_err(|e| format!("GET http://127.0.0.1:{port}/json/list: {e}"))?;
    if reply.status != 200 {
        return Err(format!("GET /json/list answered {}", reply.status));
    }
    let targets: Vec<Value> = serde_json::from_slice(&reply.body)
        .map_err(|e| format!("/json/list is not a JSON list: {e}"))?;
    Ok(targets.into_iter().filter(is_page).collect())
}

/// The pages where `document.hasFocus()` is true: each window's active tab, none for a blank one.
/// `/json/list` order says nothing about activation (phase 4 probe, answer b).
pub fn focused(port: u16, ids: &[&str]) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok((url, _)) = cdp::browser_ws(port) else {
        return out;
    };
    let Ok(mut c) = cdp::Cdp::connect(&url, CDP_TIMEOUT) else {
        return out;
    };
    let deadline = Instant::now() + FOCUS_BUDGET;
    for id in ids {
        if Instant::now() >= deadline {
            break;
        }
        let Ok(attached) = c.call(
            "Target.attachToTarget",
            json!({"targetId": id, "flatten": true}),
        ) else {
            continue;
        };
        let Some(session) = attached["sessionId"].as_str() else {
            continue;
        };
        let has_focus = c.call_session(
            session,
            "Runtime.evaluate",
            json!({"expression": "document.hasFocus()", "returnByValue": true}),
        );
        if has_focus.is_ok_and(|r| r["result"]["value"] == true) {
            out.insert(id.to_string());
        }
        let _ = c.call("Target.detachFromTarget", json!({"sessionId": session}));
    }
    out
}
